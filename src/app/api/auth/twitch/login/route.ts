import { NextResponse } from 'next/server'
import { getTwitchAuthUrl, ADDITIONAL_SCOPES } from '@/lib/twitch/auth'
import { cookies } from 'next/headers'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { handleAuthError } from '@/lib/auth-error-handler'
import { reportAuthError } from '@/lib/sentry/error-handler'
import { setRequestContext, clearUserContext } from '@/lib/sentry/user-context'
import { ERROR_MESSAGES, STATE_COOKIE_OPTIONS, COOKIE_NAMES } from '@/lib/constants'
import { getBaseUrl } from '@/lib/url-utils'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

// Web Crypto APIのcrypto.randomUUID()を使用（Cloudflare Workers互換）
// Using Web Crypto API crypto.randomUUID() for Cloudflare Workers compatibility

export async function GET(request: Request) {
  // Use Web Crypto API (Cloudflare Workers compatible)
  // Web Crypto APIを使用（Cloudflare Workers互換）
  const requestId = crypto.randomUUID()
  setRequestContext(requestId, '/api/auth/twitch/login')
  clearUserContext()

  try {
    const ip = getClientIp(request);
    const identifier = `ip:${ip}`;
    const rateLimitResult = await checkRateLimit(rateLimits.authLogin, identifier, 5, 60 * 1000);

    if (!rateLimitResult.success) {
      return NextResponse.json(
{ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      );
    }

    // 開発環境ではリクエストのホストから動的にベースURLを取得
    // 本番環境では NEXT_PUBLIC_APP_URL を使用
    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}/api/auth/twitch/callback`

    // Generate state for CSRF protection (Web Crypto API)
    // CSRF保護用のstateを生成（Web Crypto API）
    const state = crypto.randomUUID()

    // Store state in cookie
    const cookieStore = await cookies()
    cookieStore.set('twitch_auth_state', state, STATE_COOKIE_OPTIONS)

    // 以前取得済みの追加スコープをOAuthリクエストに含める
    // これにより通常ログインでも新トークンにuser:write:chat等が付与され、
    // DBのtwitch_scopesと実際のトークンの不整合を防ぐ
    // Include previously granted additional scopes in the OAuth request
    // so the new token retains them (e.g., user:write:chat)
    //
    // getSession()は期限切れセッションをnullとして返すため、
    // 期限切れCookieからもtwitchUserIdを抽出してスコープを復元する
    // getSession() rejects expired sessions as null, so we also
    // extract twitchUserId from expired cookies for scope preservation
    let preservedScopes: string[] = []
    try {
      let twitchUserId: string | null = null

      // 1. 有効なセッションからtwitchUserIdを取得
      const session = await getSession()
      if (session?.twitchUserId) {
        twitchUserId = session.twitchUserId
      }

      // 2. セッション期限切れの場合、CookieからtwitchUserIdを直接抽出
      // これが権限消失の主因: 期限切れセッションではgetSession()がnullを返し、
      // 追加スコープがOAuthリクエストに含まれなかった
      // This is the primary cause of permission loss: getSession() returns null
      // for expired sessions, so additional scopes were not included in OAuth request
      if (!twitchUserId) {
        const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
        if (sessionCookie) {
          try {
            const parsed = JSON.parse(sessionCookie)
            if (parsed.twitchUserId && typeof parsed.twitchUserId === 'string') {
              twitchUserId = parsed.twitchUserId
              logger.info('Login: extracted twitchUserId from expired session cookie', {
                twitchUserId,
              })
            }
          } catch {
            // Cookie解析エラーは無視（破損したCookieは無害にスキップ）
            // Ignore parse errors (corrupted cookies are safely skipped)
          }
        }
      }

      if (twitchUserId) {
        const supabaseAdmin = getSupabaseAdmin()
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('twitch_scopes')
          .eq('twitch_user_id', twitchUserId)
          .maybeSingle()

        if (user?.twitch_scopes) {
          // 有効な追加スコープのみ抽出（デフォルトスコープは既にAUTH_SCOPESに含まれる）
          // Extract only valid additional scopes (default scopes already in AUTH_SCOPES)
          const validAdditionalScopes = Object.values(ADDITIONAL_SCOPES) as string[]
          preservedScopes = user.twitch_scopes.filter(
            (s: string) => validAdditionalScopes.includes(s)
          )

          if (preservedScopes.length > 0) {
            logger.info('Login: preserving additional scopes', {
              twitchUserId,
              preservedScopes,
              fromExpiredSession: !session,
            })
          }
        }
      }
    } catch {
      // スコープ取得失敗はログイン処理をブロックしない
      // Scope lookup failure should not block the login flow
    }

    // forceVerify: falseで同意画面を強制しない（既存スコープの保持のみなので再同意不要）
    // forceVerify: false skips forced consent screen (just preserving already-granted scopes)
    const authUrl = getTwitchAuthUrl(
      redirectUri,
      state,
      preservedScopes.length > 0 ? preservedScopes : undefined,
      preservedScopes.length > 0 ? { forceVerify: false } : undefined
    )

    // Check if direct redirect is requested (for server-side redirects)
    // サーバーサイドリダイレクト用に直接リダイレクトが要求されているかチェック
    const url = new URL(request.url)
    const shouldRedirect = url.searchParams.get('redirect') === 'true'
    const returnTo = url.searchParams.get('returnTo')

    // Store returnTo URL in cookie if provided (for post-login redirect)
    // returnTo URLが指定されている場合はCookieに保存（ログイン後のリダイレクト用）
    if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      cookieStore.set(COOKIE_NAMES.RETURN_TO, returnTo, STATE_COOKIE_OPTIONS)
    }

    if (shouldRedirect) {
      return NextResponse.redirect(authUrl)
    }

    return NextResponse.json({ authUrl })
  } catch (error) {
    reportAuthError(error, {
      provider: 'twitch',
      action: 'login',
    })
    
    // Return JSON for API routes since the frontend expects JSON response
    // フロントエンドがJSONレスポンスを期待しているため、APIルート用にJSONを返す
    return handleAuthError(error, 'unknown_error', { route: 'twitch_login' }, { returnJson: true })
  }
}
