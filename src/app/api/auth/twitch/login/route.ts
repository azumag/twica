import { NextResponse } from 'next/server'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { cookies } from 'next/headers'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { handleAuthError } from '@/lib/auth-error-handler'
import { randomUUID } from 'crypto'
import { reportAuthError } from '@/lib/sentry/error-handler'
import { setRequestContext, clearUserContext } from '@/lib/sentry/user-context'
import { ERROR_MESSAGES, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { getBaseUrl } from '@/lib/url-utils'

export async function GET(request: Request) {
  const requestId = randomUUID()
  setRequestContext(requestId, '/api/auth/twitch/login')
  clearUserContext()

  try {
    const ip = getClientIp(request);
    const identifier = `ip:${ip}`;
    const rateLimitResult = await checkRateLimit(rateLimits.authLogin, identifier, 5, 60 * 1000);

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

    // 開発環境ではリクエストのホストから動的にベースURLを取得
    // 本番環境では NEXT_PUBLIC_APP_URL を使用
    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}/api/auth/twitch/callback`

    // Generate state for CSRF protection
    const state = randomUUID()

    // Store state in cookie
    const cookieStore = await cookies()
    cookieStore.set('twitch_auth_state', state, STATE_COOKIE_OPTIONS)

    const authUrl = getTwitchAuthUrl(redirectUri, state)

    // Check if direct redirect is requested (for server-side redirects)
    // サーバーサイドリダイレクト用に直接リダイレクトが要求されているかチェック
    const url = new URL(request.url)
    const shouldRedirect = url.searchParams.get('redirect') === 'true'

    if (shouldRedirect) {
      return NextResponse.redirect(authUrl)
    }

    return NextResponse.json({ authUrl })
  } catch (error) {
    reportAuthError(error, {
      provider: 'twitch',
      action: 'login',
    })
    
    return handleAuthError(error, 'unknown_error', { route: 'twitch_login' })
  }
}
