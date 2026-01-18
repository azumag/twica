import { NextResponse } from 'next/server'
import { clearSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getSession } from '@/lib/session'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'

export async function POST(request: Request) {
  try {
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
        }
      );
    }

    if (session) {
      await deleteTwitchTokens(session.twitchUserId);
    }

    await clearSession()
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/`)
  } catch (error) {
    return handleApiError(error, "Auth Logout API: POST")
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession();

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.authLogout, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)}`)
    }

    if (session) {
      await deleteTwitchTokens(session.twitchUserId);
    }

    await clearSession()
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/`)
  } catch (error) {
    return handleApiError(error, "Auth Logout API: GET")
  }
}
