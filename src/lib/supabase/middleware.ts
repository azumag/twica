import { NextResponse, type NextRequest } from 'next/server'

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
 */
export async function updateSession(request: NextRequest) {
  // Simply pass through the request - session is managed via custom cookies
  // リクエストをそのまま通過させる - セッションはカスタムCookieで管理
  return NextResponse.next({ request })
}
