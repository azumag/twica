import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE_NAMES, getDeleteCookieOptions } from '@/lib/constants'

/**
 * Middleware session handler
 * Note: This project uses Twitch OAuth with custom session management (cookies),
 * NOT Supabase Auth. The previous supabase.auth.getUser() call was causing
 * unnecessary API requests to Supabase on every page navigation, resulting
 * in significant latency (~100-500ms per request).
 *
 * このプロジェクトはSupabase Authではなく、Twitch OAuthと独自のセッション管理を使用。
 * 以前のsupabase.auth.getUser()呼び出しは、ページ遷移ごとにSupabaseへの
 * 不要なAPIリクエストを発生させ、大幅な遅延（1リクエストあたり約100-500ms）の原因となっていた。
 *
 * Additionally, expired session cookies are cleared here in middleware because
 * Server Components (layout/page) cannot modify cookies. clearSession() in
 * getSession() was causing "Cookies can only be modified in a Server Action
 * or Route Handler" errors.
 *
 * 期限切れセッションCookieのクリアもここで行う。Server Component（layout/page）では
 * Cookieの書き込みが禁止されているため、getSession()内のclearSession()呼び出しが
 * エラーを引き起こしていた。
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request })

  const sessionCookie = request.cookies.get(COOKIE_NAMES.SESSION)?.value
  if (sessionCookie) {
    try {
      const parsed = JSON.parse(sessionCookie)
      if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) {
        // Clear expired session and CSRF cookies via middleware response
        // ミドルウェアのレスポンス経由で期限切れセッション・CSRFのCookieをクリア
        const deleteOptions = getDeleteCookieOptions()
        response.cookies.set(COOKIE_NAMES.SESSION, '', deleteOptions)
        response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
      }
    } catch {
      // Clear unparseable session and CSRF cookies
      // パースできないセッションCookie・CSRFトークンもクリア
      const deleteOptions = getDeleteCookieOptions()
      response.cookies.set(COOKIE_NAMES.SESSION, '', deleteOptions)
      response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
    }
  }

  return response
}
