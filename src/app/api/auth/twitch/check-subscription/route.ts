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
 * Discord の refresh-role と同一パターン。
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
    const supabaseAdmin = getSupabaseAdmin()
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        twitch_sub_verified_at: new Date().toISOString(),
        twitch_has_sub: hasSub,
      })
      .eq('twitch_user_id', session.twitchUserId)

    if (updateError) {
      logger.warn('[TwitchSub] Failed to cache subscription result:', {
        twitchUserId: session.twitchUserId,
        error: updateError,
      })
    }

    logger.info('[TwitchSub] Subscription checked', {
      twitchUserId: session.twitchUserId,
      hasSub,
    })

    return NextResponse.json({ success: true, hasSub })
  } catch (error) {
    logger.error('[TwitchSub] check-subscription error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
