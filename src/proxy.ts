import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders } from '@/lib/security-headers'

export async function proxy(request: NextRequest) {
  const response = await updateSession(request)

  setSecurityHeaders(response)

  if (request.nextUrl.pathname.startsWith('/api')) {
    const ip = getClientIp(request);

    const identifier = `global:${ip}`;
    const rateLimitResult = await checkRateLimit(
      rateLimits.eventsub,
      identifier
    );

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
      );

      return setSecurityHeaders(errorResponse)
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
