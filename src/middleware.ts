import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders } from '@/lib/security-headers'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const method = request.method.toUpperCase()

  const response = await updateSession(request)
  setSecurityHeaders(response)

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
