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
    // callbackでの全置換時にスコープが消失しない
    // Include previously granted additional scopes in the OAuth request
    // so the new token retains them and callback's full-replace is safe
    let preservedScopes: string[] = []
    let scopeRestoreFailed = false
    try {
      let twitchUserId: string | null = null

      // 1. 有効なセッションからtwitchUserIdを取得
      const session = await getSession()
      if (session?.twitchUserId) {
        twitchUserId = session.twitchUserId
      }

      // 2. ログアウト後のスコープ復元用最小Cookie（twitchUserIdのみ）から取得
      // clearSession()がログアウト時に設定する専用Cookie。
      // 全セッションデータの代わりにtwitchUserIdだけを保持するため改ざん耐性が高い
      // (twitchUserIdはTwitch公開APIで誰でも取得可能な情報であり機密性なし)
      // Read twitchUserId from the minimal scope-restore cookie set by clearSession() on logout.
      // Using a dedicated minimal cookie avoids retaining full unsigned session data.
      if (!twitchUserId) {
        const scopeRestoreUid = cookieStore.get(COOKIE_NAMES.SCOPE_RESTORE_USER_ID)?.value
        if (scopeRestoreUid) {
          twitchUserId = scopeRestoreUid
          logger.info('Login: extracted twitchUserId from scope restore cookie', {
            twitchUserId,
          })
        }
      }

      if (twitchUserId) {
        const supabaseAdmin = getSupabaseAdmin()
        const { data: user, error: dbError } = await supabaseAdmin
          .from('users')
          .select('twitch_scopes')
          .eq('twitch_user_id', twitchUserId)
          .maybeSingle()

        if (dbError) {
          // DB障害時: スコープ復元に失敗したことをcallbackに伝達する
          // callbackで全置換すると追加スコープが消失するため、ガードが必要
          // DB failure: signal to callback that scope restoration failed
          // Without this guard, callback's full-replace would silently drop additional scopes
          logger.warn('Login: scope preservation DB query failed', {
            twitchUserId,
            error: dbError.message,
            code: dbError.code,
          })
          scopeRestoreFailed = true
        } else if (user?.twitch_scopes) {
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
    } catch (error) {
      // スコープ取得で予期しない例外が発生した場合もガードを設定
      // Set guard on unexpected exceptions during scope restoration
      logger.warn('Login: scope preservation failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      })
      scopeRestoreFailed = true
    }

    // スコープ復元失敗時、callbackでの全置換を抑止するためガードCookieを設定
    // OAuth stateに紐づけることで、reauth等の別フローに影響しない
    // Set guard cookie on failure, tied to this OAuth state so it doesn't affect other flows
    if (scopeRestoreFailed) {
      cookieStore.set(COOKIE_NAMES.SCOPE_RESTORE_FAILED, state, STATE_COOKIE_OPTIONS)
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
