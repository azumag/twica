import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope, removeScope } from '@/lib/twitch/token-manager'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/auth'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

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

    let saved = true
    let saveFailureCode: string | undefined
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
