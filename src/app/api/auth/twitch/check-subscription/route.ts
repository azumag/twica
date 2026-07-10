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
// -----------------------------------------------------------------------------
// #663 (#570/#572 パターン踏襲): pg 直結経路。
// このルートは users への upsert（書き込み）と空応答時の再読込検証（読み取り）が
// 混在するため、ルート内の DB アクセス全体を isPgWriteEnabled() で分岐する
// （sub-check.ts 冒頭のフラグ使い分け方針と同じ。pg-read では従来の PostgREST
// 経路のまま動く）。共有関数 hasScope（読み取り）/ removeScope（書き込み）は
// それぞれの内部で独立にフラグ分岐される。既存 supabase-js 実装は無変更で残す。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { isPgMissingColumnError } from '@/lib/db/errors'
import { users as usersTable } from '@/lib/db/schema'

/**
 * サブスク手動確認結果の保存（upsert + 空応答時の再読込検証）の pg 直結実装 (#663)
 *
 * 戻り値: 保存結果（saved / saveFailureCode）。回復不能な保存エラーは 'persist_error'
 * を返し、呼び出し元が既存経路と同じ 500 応答に変換する。
 *
 * PostgREST 実装との対応:
 * - .upsert(..., { onConflict: 'twitch_user_id' }).select('twitch_user_id').maybeSingle()
 *   → INSERT ... ON CONFLICT (twitch_user_id) DO UPDATE + .returning() + rows[0] ?? null。
 *   conflict target は users.twitch_user_id の UNIQUE 制約（migration 00001）。
 *   supabase-js の upsert は payload 全列を EXCLUDED の値で DO UPDATE するため、
 *   values と同一のオブジェクトを set に渡すことで意味論を一致させる。
 * - PGRST204（書き込み列がスキーマキャッシュに無い）は pg 直結では SQLSTATE 42703。
 *   既存と同じく saved=false + saveFailureCode 付きの成功応答に落とす。
 *   既知の表現差: saveFailureCode はドライバ由来のコードをそのまま返す
 *   （postgrest: 'PGRST204' / pg: '42703'）。クライアント（TwitchSubCheckSection.tsx）
 *   は表示用サフィックスとしてしか使わないため実害はない。
 * - その他の保存エラー → 'persist_error'（既存経路の error log + 500 と同じ流れ）。
 * - upsert 応答 0 行 → 再読込検証。pg 直結の ON CONFLICT DO UPDATE + RETURNING は
 *   常に 1 行返すため実際にはほぼ到達しない防御的パスだが、既存経路の外部挙動
 *   （NO_ROW_RETURNED 等の saveFailureCode）を 1:1 で維持するために実装する。
 *
 * 冪等性: verifiedAt を queryFn の外で 1 度だけ計算し、リトライしても同じ値を書く
 * ON CONFLICT DO UPDATE の upsert のため idempotent: true（sub-check.ts の
 * キャッシュ更新と同じ判断）。
 */
async function persistSubscriptionResultPg(
  session: {
    twitchUserId: string
    twitchUsername: string
    twitchDisplayName: string
    twitchProfileImageUrl: string
  },
  hasSub: boolean
): Promise<{ saved: boolean; saveFailureCode?: string } | 'persist_error'> {
  const verifiedAt = new Date().toISOString()
  const upsertValues = {
    twitch_user_id: session.twitchUserId,
    twitch_username: session.twitchUsername,
    twitch_display_name: session.twitchDisplayName,
    twitch_profile_image_url: session.twitchProfileImageUrl,
    twitch_sub_verified_at: verifiedAt,
    twitch_has_sub: hasSub,
  }

  let persistedUser: { twitch_user_id: string } | null
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .insert(usersTable)
          .values(upsertValues)
          .onConflictDoUpdate({
            target: usersTable.twitch_user_id,
            set: upsertValues,
          })
          .returning({ twitch_user_id: usersTable.twitch_user_id })
      },
      'checkSubscription(upsert)',
      { idempotent: true },
    )
    persistedUser = rows[0] ?? null
  } catch (persistError) {
    if (isPgMissingColumnError(persistError)) {
      // PGRST204 相当（42703）: スキーマ差分で保存だけ失敗するケース。
      // 手動確認結果は返せるため、API 全体は成功として扱う（既存と同じ）。
      const code = (persistError as { code?: string }).code
      logger.warn('[TwitchSub] Persist skipped due to schema mismatch:', {
        twitchUserId: session.twitchUserId,
        code,
        message: persistError instanceof Error ? persistError.message : String(persistError),
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      })
      return { saved: false, saveFailureCode: code }
    }
    logger.error('[TwitchSub] Failed to persist subscription result:', {
      twitchUserId: session.twitchUserId,
      error: persistError,
      persistedUser: null,
    })
    return 'persist_error'
  }

  if (persistedUser) {
    return { saved: true }
  }

  // 環境/レスポンス設定により、更新成功でも返却行が空になるケースがある（既存経路の
  // 防御的分岐の 1:1 対応）。その場合は再読込して実際に保存できたかを検証する。
  let latestUser: { twitch_has_sub: boolean | null; twitch_sub_verified_at: string | null } | null
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
          .where(eq(usersTable.twitch_user_id, session.twitchUserId))
          .limit(1) // twitch_user_id は UNIQUE（00001）のため maybeSingle と同じ外部挙動
      },
      'checkSubscription(verify read-back)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    latestUser = rows[0] ?? null
  } catch (verifyError) {
    logger.warn('[TwitchSub] Persist verification failed:', {
      twitchUserId: session.twitchUserId,
      code: (verifyError as { code?: string })?.code,
      message: verifyError instanceof Error ? verifyError.message : String(verifyError),
    })
    // 既存経路の verifyError.code ?? 'VERIFY_READ_ERROR' に対応
    return {
      saved: false,
      saveFailureCode: (verifyError as { code?: string })?.code ?? 'VERIFY_READ_ERROR',
    }
  }

  // 再読込検証の判定ロジックは既存経路と同一（twitch_sub_verified_at は pg 直結だと
  // PG テキスト形式の文字列で返るが、消費は new Date() 経由の時刻比較のみのため
  // 表現差の影響はない。sub-check.ts の同趣旨コメント参照）
  const verifiedAtMs = latestUser?.twitch_sub_verified_at
    ? new Date(latestUser.twitch_sub_verified_at).getTime()
    : NaN
  const verifiedRecently = Number.isFinite(verifiedAtMs) && Math.abs(Date.now() - verifiedAtMs) < 2 * 60 * 1000

  if (!latestUser || latestUser.twitch_has_sub !== hasSub || !verifiedRecently) {
    logger.warn('[TwitchSub] Persist not confirmed after read-back:', {
      twitchUserId: session.twitchUserId,
      latestUser,
      expectedHasSub: hasSub,
    })
    return { saved: false, saveFailureCode: 'NO_ROW_RETURNED' }
  }

  logger.info('[TwitchSub] Persist confirmed by read-back after empty response row:', {
    twitchUserId: session.twitchUserId,
    hasSub,
  })
  return { saved: true }
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
    // #663: upsert（書き込み）と再読込検証（読み取り）が混在するため
    // isPgWriteEnabled() で DB アクセス全体を分岐する。フラグ未設定・pg-read 時は
    // else 節の既存 supabase-js 実装が従来どおり実行される（saved / saveFailureCode
    // の宣言のみ両経路で共有するため分岐の外へ移動。既存ロジックは無変更）。
    let saved = true
    let saveFailureCode: string | undefined
    if (isPgWriteEnabled()) {
      const persistOutcome = await persistSubscriptionResultPg(session, hasSub)
      if (persistOutcome === 'persist_error') {
        return NextResponse.json(
          { error: 'Failed to save subscription status' },
          { status: 500 }
        )
      }
      saved = persistOutcome.saved
      saveFailureCode = persistOutcome.saveFailureCode
    } else {
      const supabaseAdmin = getSupabaseAdmin()
      const verifiedAt = new Date().toISOString()
      const { data: persistedUser, error: persistError } = await supabaseAdmin
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

      if (persistError) {
        // PGRST204: スキーマ差分（カラム未適用等）で保存だけ失敗するケース。
        // 手動確認結果は返せるため、API全体は成功として扱う。
        if (persistError.code === 'PGRST204') {
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
        const { data: latestUser, error: verifyError } = await supabaseAdmin
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
