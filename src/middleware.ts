import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders } from '@/lib/security-headers'
import { defaultLocale, locales, LOCALE_COOKIE_NAME, type Locale } from '@/i18n/config'

/**
 * Detect locale from request (cookie or Accept-Language header)
 * リクエストからロケールを検出（CookieまたはAccept-Languageヘッダー）
 */
function detectLocale(request: NextRequest): Locale {
  // Priority 1: Check cookie for user's saved preference
  // 優先度1: ユーザーの保存された設定をCookieから確認
  const localeCookie = request.cookies.get(LOCALE_COOKIE_NAME)?.value
  if (localeCookie && locales.includes(localeCookie as Locale)) {
    return localeCookie as Locale
  }

  // Priority 2: Check Accept-Language header
  // 優先度2: Accept-Languageヘッダーを確認
  const acceptLanguage = request.headers.get('accept-language')
  if (acceptLanguage) {
    const languages = acceptLanguage
      .split(',')
      .map((lang) => {
        const [code, qValue] = lang.trim().split(';q=')
        return {
          code: code.split('-')[0].toLowerCase(),
          quality: qValue ? parseFloat(qValue) : 1,
        }
      })
      .sort((a, b) => b.quality - a.quality)

    for (const lang of languages) {
      if (locales.includes(lang.code as Locale)) {
        return lang.code as Locale
      }
    }
  }

  // Priority 3: Fall back to default locale
  // 優先度3: デフォルトロケールにフォールバック
  return defaultLocale
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const response = await updateSession(request)
  setSecurityHeaders(response)

  // Detect and set locale for server components
  // サーバーコンポーネント用にロケールを検出・設定
  const locale = detectLocale(request)
  response.headers.set('x-locale', locale)

  // Ensure pages with session-dependent content are never cached
  // This is especially important for the top page which shows different content
  // based on login state
  if (pathname === '/' || pathname === '/dashboard') {
    response.headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
  }

  if (pathname.startsWith('/api')) {
    const ip = getClientIp(request)
    const identifier = `global:${ip}`
    const rateLimitResult = await checkRateLimit(
      rateLimits.eventsub,
      identifier
    )

    if (!rateLimitResult.success) {
      const errorResponse = NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      )

      return setSecurityHeaders(errorResponse)
    }

    const excludePaths = [
      '/api/auth/twitch/callback',
      '/api/twitch/eventsub',
      '/api/auth/twitch/login',
    ]

    if (excludePaths.some(path => pathname.startsWith(path))) {
      return response
    }

    // CSRF validation is handled in individual route handlers
    // Middleware runs in Edge Runtime where cookies() is not available
    return response
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
