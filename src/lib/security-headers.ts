import { NextResponse } from 'next/server'
import { SECURITY_HEADERS } from './constants'

export function setSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS)
  response.headers.set('X-Frame-Options', SECURITY_HEADERS.X_FRAME_OPTIONS)
  response.headers.set('X-XSS-Protection', SECURITY_HEADERS.X_XSS_PROTECTION)

  const csp = process.env.NODE_ENV === 'production'
    ? SECURITY_HEADERS.CSP_PRODUCTION
    : SECURITY_HEADERS.CSP_DEVELOPMENT
  response.headers.set('Content-Security-Policy', csp)

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', SECURITY_HEADERS.HSTS)
  }

  return response
}
