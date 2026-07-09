import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope, removeScope } from '@/lib/twitch/token-manager'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
// ---------------------------------------------------------------------------
// #663 (#572 sub-check.ts の hasTwitchSub 踏襲): pg 直結経路。フラグ未設定時
// （既定 'postgrest'）は isPgWriteEnabled() が false を返すため getDb() は
// 一切呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// このルートは読み取り（読み戻し検証）と書き込み（キャッシュ保存）が混在するため
// isPgWriteEnabled() で分岐する（token-manager.ts 冒頭のフラグ使い分け方針）。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { isPgMissingColumnError } from '@/lib/db/errors'
import { users as usersTable } from '@/lib/db/schema'

interface PersistDriverError {
  code?: string
  message: string
}

/**
 * サブスク確認結果の保存（UPSERT）の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: onConflict('twitch_user_id') の UPSERT は、users の
 * twitch_user_id UNIQUE 制約（migration 00001、token-manager.ts 等と同じ根拠）を
 * conflict target とした INSERT ... ON CONFLICT DO UPDATE と等価。
 * .select('twitch_user_id').maybeSingle() は .returning({twitch_user_id}) の
 * rows[0] ?? null で同じ外部挙動（0 行 = 環境依存でレスポンス行が空のケース）。
 * 42703（列未デプロイ）は既存の PGRST204 分岐と同じ「保存はスキップし手動確認の
 * 結果自体は返す」安全側フォールバックに揃える。
 *
 * 保存する値（twitchUsername 等）は呼び出し元で計算済みの固定値のため、
 * 接続断リトライしても同じ内容を書く UPSERT ＝冪等。
 */
async function persistSubscriptionResultPg(payload: {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string | null | undefined
  verifiedAt: string
  hasSub: boolean
}): Promise<{ data: { twitch_user_id: string } | null; error: PersistDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        const values = {
          twitch_user_id: payload.twitchUserId,
          twitch_username: payload.twitchUsername,
          twitch_display_name: payload.twitchDisplayName,
          twitch_profile_image_url: payload.twitchProfileImageUrl ?? null,
          twitch_sub_verified_at: payload.verifiedAt,
          twitch_has_sub: payload.hasSub,
        }
        return db
          .insert(usersTable)
          .values(values)
          .onConflictDoUpdate({ target: usersTable.twitch_user_id, set: values })
          .returning({ twitch_user_id: usersTable.twitch_user_id })
      },
      'check-subscription(persist)',
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      return { data: null, error: { code: '42703', message: 'schema mismatch' } }
    }
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * 保存確認の読み戻し（persistedUser が空だった場合の検証読み取り）の pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約により
 * 最大 1 行のため LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 */
async function verifySubscriptionPersistPg(
  twitchUserId: string
): Promise<{
  data: { twitch_has_sub: boolean | null; twitch_sub_verified_at: string | null } | null
  error: PersistDriverError | null
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({
            twitch_has_sub: usersTable.twitch_has_sub,
            twitch_sub_verified_at: usersTable.twitch_sub_verified_at,
          })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'check-subscription(verify)',
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * Twitch サブスク状態を手動確認する POST API
 * キャッシュを無視して Twitch API に直接問い合わせ、結果を DB に保存する。
 */
export async function POST(request: Request) {
  try {
    // CSRF 検証
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    if (!isTwitchSubCheckEnabled()) {
      return NextResponse.json(
        { error: 'Twitch subscription check is not configured' },
        { status: 404 }
      )
    }

    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.NOT_AUTHENTICATED },
        { status: 401 }
      )
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.twitchCheckSubscription, identifier)

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        { status: 429, headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        }}
      )
    }

    // user:read:subscriptions スコープがあるか確認
    const scopeGranted = await hasScope(session.twitchUserId, ADDITIONAL_SCOPES.USER_READ_SUBSCRIPTIONS)
    if (!scopeGranted) {
      return NextResponse.json(
        { error: 'user:read:subscriptions scope not granted. Please re-authorize.', needsReauth: true },
        { status: 403 }
      )
    }

    // Twitch API でサブスク状態を確認
    const { hasSub, authError } = await checkTwitchSubViaApi(session.twitchUserId)

    if (hasSub === null) {
      if (authError) {
        // 401/403: トークン/スコープの問題 → 手動確認なのでスコープ除去して再認証を促す
        try {
          await removeScope(session.twitchUserId, ADDITIONAL_SCOPES.USER_READ_SUBSCRIPTIONS)
        } catch (removeError) {
          logger.warn('[TwitchSub] Failed to remove scope after auth error:', {
            twitchUserId: session.twitchUserId,
            error: removeError,
          })
        }
        return NextResponse.json(
          { error: 'Authentication error. Please re-authorize.', needsReauth: true },
          { status: 502 }
        )
      }
      // 5xx/ネットワークエラー等: 一時障害の可能性 → スコープ除去しない
      // レート制限で連打は防止されているため、リトライストームの心配なし
      return NextResponse.json(
        { error: 'Failed to check subscription status. Please try again later.' },
        { status: 502 }
      )
    }

    // DB 更新（キャッシュ保存）
    // users 行が欠けている環境でも保存できるよう upsert を使用する。
    const supabaseAdmin = getSupabaseAdmin()
    const verifiedAt = new Date().toISOString()
    // #663: 書き込み（読み戻し検証を含む）のため isPgWriteEnabled() で分岐。
    const { data: persistedUser, error: persistError } = isPgWriteEnabled()
      ? await persistSubscriptionResultPg({
          twitchUserId: session.twitchUserId,
          twitchUsername: session.twitchUsername,
          twitchDisplayName: session.twitchDisplayName,
          twitchProfileImageUrl: session.twitchProfileImageUrl,
          verifiedAt,
          hasSub,
        })
      : await supabaseAdmin
          .from('users')
          .upsert({
            twitch_user_id: session.twitchUserId,
            twitch_username: session.twitchUsername,
            twitch_display_name: session.twitchDisplayName,
            twitch_profile_image_url: session.twitchProfileImageUrl,
            twitch_sub_verified_at: verifiedAt,
            twitch_has_sub: hasSub,
          }, {
            onConflict: 'twitch_user_id',
          })
          .select('twitch_user_id')
          .maybeSingle()

    let saved = true
    let saveFailureCode: string | undefined
    if (persistError) {
      // PGRST204（postgrest 経路）/ 42703（pg 経路、isPgMissingColumnError 相当）は
      // どちらも「スキーマ差分（カラム未適用等）で保存だけ失敗するケース」を表す。
      // 手動確認結果は返せるため、API全体は成功として扱う。
      if (persistError.code === 'PGRST204' || persistError.code === '42703') {
        saved = false
        saveFailureCode = persistError.code
        logger.warn('[TwitchSub] Persist skipped due to schema mismatch:', {
          twitchUserId: session.twitchUserId,
          code: persistError.code,
          message: persistError.message,
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        })
      } else {
        logger.error('[TwitchSub] Failed to persist subscription result:', {
          twitchUserId: session.twitchUserId,
          error: persistError,
          persistedUser,
        })
        return NextResponse.json(
          { error: 'Failed to save subscription status' },
          { status: 500 }
        )
      }
    } else if (!persistedUser) {
      // 環境/レスポンス設定により、更新成功でも返却行が空になるケースがある。
      // その場合は再読込して実際に保存できたかを検証する。
      const { data: latestUser, error: verifyError } = isPgWriteEnabled()
        ? await verifySubscriptionPersistPg(session.twitchUserId)
        : await supabaseAdmin
            .from('users')
            .select('twitch_has_sub, twitch_sub_verified_at')
            .eq('twitch_user_id', session.twitchUserId)
            .maybeSingle()

      const verifiedAtMs = latestUser?.twitch_sub_verified_at
        ? new Date(latestUser.twitch_sub_verified_at).getTime()
        : NaN
      const verifiedRecently = Number.isFinite(verifiedAtMs) && Math.abs(Date.now() - verifiedAtMs) < 2 * 60 * 1000

      if (verifyError) {
        saved = false
        saveFailureCode = verifyError.code ?? 'VERIFY_READ_ERROR'
        logger.warn('[TwitchSub] Persist verification failed:', {
          twitchUserId: session.twitchUserId,
          code: verifyError.code,
          message: verifyError.message,
        })
      } else if (!latestUser || latestUser.twitch_has_sub !== hasSub || !verifiedRecently) {
        saved = false
        saveFailureCode = 'NO_ROW_RETURNED'
        logger.warn('[TwitchSub] Persist not confirmed after read-back:', {
          twitchUserId: session.twitchUserId,
          latestUser,
          expectedHasSub: hasSub,
        })
      } else {
        logger.info('[TwitchSub] Persist confirmed by read-back after empty response row:', {
          twitchUserId: session.twitchUserId,
          hasSub,
        })
      }
    }

    logger.info('[TwitchSub] Subscription checked', {
      twitchUserId: session.twitchUserId,
      hasSub,
    })

    return NextResponse.json({ success: true, hasSub, saved, saveFailureCode })
  } catch (error) {
    logger.error('[TwitchSub] check-subscription error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
