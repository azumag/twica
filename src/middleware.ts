import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders } from '@/lib/security-headers'
import { ERROR_MESSAGES } from '@/lib/constants'
import { defaultLocale, locales, LOCALE_COOKIE_NAME, type Locale } from '@/i18n/config'

// Next.js 16 recommends proxy.ts, but Proxy always builds as Node.js runtime
// with no opt-out: setting `export const config = { runtime: 'edge' }` in a
// proxy.ts file throws "Proxy always runs on Node.js runtime" at build time.
// (https://nextjs.org/docs/messages/middleware-to-proxy)
// @opennextjs/cloudflare (currently ^1.16.1) hard-fails `workers:build` with
// "Node.js middleware is not currently supported. Consider switching to Edge
// Middleware." whenever it detects Node.js-runtime middleware/proxy output
// (see useNodeMiddleware() in its build.js). This is still true as of
// @opennextjs/cloudflare 1.20.1, the latest published version as of this
// writing (2026-07-03) — confirmed by inspecting that version's published
// build.js, which contains the identical check.
// Upstream tracking: opennextjs/opennextjs-cloudflare maintainers say real
// proxy.ts support is planned only via Next.js's "Adapters API"
// (opennextjs/opennextjs-cloudflare#972). The concrete bug is tracked at
// opennextjs/opennextjs-cloudflare#1277 (open), with a community fix at PR
// #1280 (open, changes requested by a maintainer, stalled since 2026-06-21 —
// not merged/released). A maintainer's current guidance on #1277 is to keep
// using middleware.ts if it doesn't need Node.js-only APIs, which is exactly
// what this file does.
// This file intentionally stays on the deprecated middleware.ts convention
// (with edge-compatible code only) until proxy.ts support ships in a
// released @opennextjs/cloudflare version.

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

// Paths excluded from global rate limiting (have their own rate limits)
// グローバルレート制限から除外するパス（独自のレート制限を持つ）
const RATE_LIMIT_EXCLUDED_PATHS = [
  '/api/auth/twitch/callback',
  '/api/twitch/eventsub',
  '/api/auth/twitch/login',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const response = await updateSession(request)
  // パスに基づいて適切なセキュリティヘッダーを設定
  // Set appropriate security headers based on the path
  setSecurityHeaders(response, pathname)

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

  // Apply global rate limiting only to API routes
  // グローバルレート制限はAPIルートにのみ適用
  if (pathname.startsWith('/api')) {
    // Skip global rate limiting for paths with their own rate limiting
    // to reduce CPU overhead from redundant checks
    // 独自のレート制限を持つパスはグローバルレート制限をスキップして
    // 冗長なチェックによるCPUオーバーヘッドを削減
    const isExcludedPath = RATE_LIMIT_EXCLUDED_PATHS.some(path => pathname.startsWith(path))

    if (!isExcludedPath) {
      const ip = getClientIp(request)
      const identifier = `global:${ip}`
      const rateLimitResult = await checkRateLimit(
        rateLimits.global,
        identifier
      )

      if (!rateLimitResult.success) {
        const errorResponse = NextResponse.json(
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

        return setSecurityHeaders(errorResponse, pathname)
      }
    }

    // CSRF validation is handled in individual route handlers
    // Middleware runs in Edge Runtime where cookies() is not available
    return response
  }

  return response
}

export const config = {
  // Exclude static files and assets from middleware to reduce CPU usage
  // 静的ファイルとアセットをミドルウェアから除外してCPU使用量を削減
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|eot)$).*)',
  ],
}
