import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE_NAMES, getDeleteCookieOptions } from '@/lib/constants'
import { parseSession, verifySession } from '@/lib/session-cookie'

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
 * IMPORTANT: Expired session cookies are NOT deleted here.
 * The login route's parseSession() fallback relies on the expired cookie
 * to extract twitchUserId and preserve additional scopes (e.g., user:write:chat)
 * during re-login. Deleting the expired cookie here would cause the login route
 * to lose the twitchUserId, resulting in silent scope loss.
 * The cookie's maxAge (COOKIE_MAX_AGE_SECONDS) is intentionally set longer than
 * the session validity (MAX_AGE_SECONDS) to provide a grace period for scope preservation.
 * getSession() already returns null for expired sessions, so keeping the cookie
 * is safe — it only serves as a twitchUserId source for the login route.
 *
 * 重要: 期限切れセッションCookieはここで削除しない。
 * ログインルートのparseSession()フォールバックが期限切れCookieからtwitchUserIdを
 * 抽出し、追加スコープ（user:write:chat等）を保持するために使用する。
 * ここで削除するとログインルートがtwitchUserIdを取得できず、スコープが暗黙的に消失する。
 * CookieのmaxAge（COOKIE_MAX_AGE_SECONDS）はセッション有効期限（MAX_AGE_SECONDS）より
 * 意図的に長く設定されており、スコープ保持のための猶予期間を提供する。
 * getSession()は期限切れセッションにnullを返すため、Cookieを残しても安全。
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request })

  const sessionCookie = request.cookies.get(COOKIE_NAMES.SESSION)?.value
  if (sessionCookie) {
    try {
      const payload = await verifySession(sessionCookie, { allowUnsignedLegacy: true })
      const parsed = parseSession(payload)
      if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) {
        // セッション期限切れ時: CSRFトークンが存在する場合のみ削除。セッションCookieは保持する。
        // リクエストにcsrf_tokenがない場合はSet-Cookieヘッダを出さない（キャッシュ効率維持）
        // On session expiry: only clear CSRF token if it exists in request.
        // Avoids unnecessary Set-Cookie headers that degrade CDN/browser cache efficiency.
        if (request.cookies.get(COOKIE_NAMES.CSRF_TOKEN)) {
          const deleteOptions = getDeleteCookieOptions()
          response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
        }
      }
    } catch {
      // パースできないCookieは改ざん/破損の可能性があるため削除（セキュリティ対策）
      // csrf_tokenもリクエストに存在する場合のみ削除（不要なSet-Cookie抑制）
      // Clear unparseable session cookie. Also clear CSRF token only if present in request.
      const deleteOptions = getDeleteCookieOptions()
      response.cookies.set(COOKIE_NAMES.SESSION, '', deleteOptions)
      if (request.cookies.get(COOKIE_NAMES.CSRF_TOKEN)) {
        response.cookies.set(COOKIE_NAMES.CSRF_TOKEN, '', deleteOptions)
      }
    }
  }

  return response
}
