import { NextResponse } from 'next/server'
import { clearSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getSession } from '@/lib/session'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { clearCSRFToken, validateCSRFToken } from '@/lib/csrf'
import { logger } from '@/lib/logger'
import { getBaseUrl } from '@/lib/url-utils'

export async function POST(request: Request) {
  // 開発環境ではリクエストのホストから動的にベースURLを取得
  const baseUrl = getBaseUrl(request)

  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    const session = await getSession();

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.authLogout, identifier);

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
        });
    }

    if (session) {
      try {
        await deleteTwitchTokens(session.twitchUserId);
      } catch (error) {
        // Token deletion is optional - log but continue logout
        logger.error('Failed to delete Twitch tokens during logout:', { error });
      }
    }

    await clearSession()
    await clearCSRFToken()
    return NextResponse.redirect(`${baseUrl}/`)
  } catch (error) {
    return handleApiError(error, "Auth Logout API: POST")
  }
}

export async function GET(request: Request) {
  // 開発環境ではリクエストのホストから動的にベースURLを取得
  const baseUrl = getBaseUrl(request)

  try {
    const session = await getSession();

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.authLogout, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.redirect(`${baseUrl}/?error=${encodeURIComponent(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)}`)
    }

    if (session) {
      try {
        await deleteTwitchTokens(session.twitchUserId);
      } catch (error) {
        // Token deletion is optional - log but continue logout
        logger.error('Failed to delete Twitch tokens during logout:', { error });
      }
    }

    await clearSession()
    await clearCSRFToken()
    return NextResponse.redirect(`${baseUrl}/`)
  } catch (error) {
    return handleApiError(error, "Auth Logout API: GET")
  }
}
