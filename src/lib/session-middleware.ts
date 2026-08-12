import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE_NAMES, getDeleteCookieOptions } from '@/lib/constants'
import { parseSession, verifySession } from '@/lib/session-cookie'

/**
 * Middleware session handler for the application's Twitch OAuth cookie.
 *
 * The service does not use Supabase Auth. Expired session cookies are retained
 * so the login route can recover twitchUserId and preserve additional scopes
 * during re-login; getSession() still treats them as unauthenticated. The CSRF
 * cookie is removed when the session expires, while malformed/tampered session
 * cookies are removed immediately.
 */
export async function updateSession(request: NextRequest, requestHeaders: Headers) {
  // 追加ヘッダー（CSP nonce 等）は request を再構築せず NextResponse.next の
  // request.headers 経由で渡す（#836: body を持つ Request を new NextRequest で
  // 複製すると Fetch 仕様上 body が tee され、未消費ブランチのバッファリングが
  // 発生しうるため）。
  const response = NextResponse.next({ request: { headers: requestHeaders } })

  const sessionCookie = request.cookies.get(COOKIE_NAMES.SESSION)?.value
  if (sessionCookie) {
    try {
      const payload = await verifySession(sessionCookie, { allowUnsignedLegacy: true })
      const parsed = parseSession(payload)
      if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) {
        // Preserve the expired session cookie for scope restoration. Avoid an
        // unnecessary Set-Cookie header when no CSRF cookie exists.
        if (request.cookies.get(COOKIE_NAMES.CSRF_TOKEN)) {
          const deleteOptions = getDeleteCookieOptions()
          response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
        }
      }
    } catch {
      // Invalid session data is either corrupted or tampered with.
      const deleteOptions = getDeleteCookieOptions()
      response.cookies.set(COOKIE_NAMES.SESSION, '', deleteOptions)
      if (request.cookies.get(COOKIE_NAMES.CSRF_TOKEN)) {
        response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
      }
    }
  }

  return response
}
