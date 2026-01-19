import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders } from '@/lib/security-headers'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const method = request.method.toUpperCase()

  const response = await updateSession(request)
  setSecurityHeaders(response)

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

    const safeMethods = ['GET', 'HEAD', 'OPTIONS']
    if (safeMethods.includes(method)) {
      return response
    }

    try {
      const validation = await validateCSRFToken(request)

      if (!validation.valid) {
        logger.error('CSRF validation failed in middleware', {
          url: request.url,
          method: request.method,
          error: validation.error,
        })
        return NextResponse.json(
          { error: ERROR_MESSAGES.FORBIDDEN },
          { status: 403 }
        )
      }

      return response
    } catch (error) {
      logger.error('CSRF middleware error', {
        url: request.url,
        method: request.method,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      return NextResponse.json(
        { error: ERROR_MESSAGES.INTERNAL_ERROR },
        { status: 500 }
      )
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
