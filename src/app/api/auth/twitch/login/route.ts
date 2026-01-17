import { NextResponse } from 'next/server'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { cookies } from 'next/headers'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { handleAuthError } from '@/lib/auth-error-handler'
import { randomUUID } from 'crypto'

export async function GET(request: Request) {
  try {
    const ip = getClientIp(request);
    const identifier = `ip:${ip}`;
    const rateLimitResult = await checkRateLimit(rateLimits.authLogin, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
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

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`

    // Generate state for CSRF protection
    const state = randomUUID()

    // Store state in cookie
    const cookieStore = await cookies()
    cookieStore.set('twitch_auth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
    })

    const authUrl = getTwitchAuthUrl(redirectUri, state)

    return NextResponse.redirect(authUrl)
  } catch (error) {
    return handleAuthError(error, 'unknown_error', { route: 'twitch_login' })
  }
}
