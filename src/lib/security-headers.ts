import { NextResponse } from 'next/server'
import { SECURITY_HEADERS } from './constants'

/**
 * Set security headers on response
 * レスポンスにセキュリティヘッダーを設定
 * @param response - NextResponse object to modify
 * @param pathname - Request pathname (optional, used for route-specific headers)
 */
export function setSecurityHeaders(response: NextResponse, pathname?: string): NextResponse {
  response.headers.set('X-Content-Type-Options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS)

  // overlay ルートは同一オリジンからの iframe 埋め込みを許可（プレビュー機能用）
  // Allow same-origin iframe embedding for overlay routes (for preview functionality)
  if (pathname?.startsWith('/overlay')) {
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  } else {
    response.headers.set('X-Frame-Options', SECURITY_HEADERS.X_FRAME_OPTIONS)
  }

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
