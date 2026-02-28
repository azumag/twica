import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

const DISABLED_SUB_VERIFIED_AT = '9999-12-31T00:00:00.000Z'

/**
 * Twitch サブスク状態を手動で無効化する POST API
 * 自動再チェックが走らないように far-future の verified_at を保存する。
 */
export async function POST(request: Request) {
  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
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
    const rateLimitResult = await checkRateLimit(rateLimits.twitchDisableSubscription, identifier)
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      )
    }

    const supabaseAdmin = getSupabaseAdmin()
    const { data: updatedUser, error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        twitch_has_sub: false,
        twitch_sub_verified_at: DISABLED_SUB_VERIFIED_AT,
      })
      .eq('twitch_user_id', session.twitchUserId)
      .select('twitch_user_id')
      .maybeSingle()

    if (updateError || !updatedUser) {
      logger.error('[TwitchSub] Failed to disable subscription status:', {
        twitchUserId: session.twitchUserId,
        error: updateError,
        updatedUser,
      })
      return NextResponse.json(
        { error: 'Failed to disable subscription status' },
        { status: 500 }
      )
    }

    logger.info('[TwitchSub] Subscription status disabled manually', {
      twitchUserId: session.twitchUserId,
    })

    return NextResponse.json({
      success: true,
      hasSub: false,
      twitchSubVerifiedAt: DISABLED_SUB_VERIFIED_AT,
    })
  } catch (error) {
    logger.error('[TwitchSub] disable-subscription error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
