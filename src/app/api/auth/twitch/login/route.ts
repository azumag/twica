import { NextResponse } from 'next/server'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { cookies } from 'next/headers'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { handleAuthError } from '@/lib/auth-error-handler'
import { reportAuthError } from '@/lib/sentry/error-handler'
import { setRequestContext, clearUserContext } from '@/lib/sentry/user-context'
import { ERROR_MESSAGES, STATE_COOKIE_OPTIONS, COOKIE_NAMES } from '@/lib/constants'
import { getBaseUrl } from '@/lib/url-utils'
import { getSession, parseSession, verifySession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

/**
 * ログイン時のスコープ復元読み取りの pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約
 * （migration 00001）により最大 1 行のため、LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。
 */
async function fetchScopeRestorationUserPg(
  twitchUserId: string
): Promise<{ data: { twitch_scopes: string[] | null } | null; error: { code?: string; message: string } | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'login(scope restore)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      data: null,
      error: {
        code: typeof code === 'string' ? code : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

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

      // 2. 明示ログアウト後のスコープ復元: SCOPE_RESTORE_USER_ID Cookie（twitchUserIdのみ）から取得
      // clearSession()がログアウト時に設定する専用最小Cookie。
      // Read twitchUserId from minimal scope-restore cookie set by clearSession() on explicit logout.
      if (!twitchUserId) {
        const scopeRestoreUid = cookieStore.get(COOKIE_NAMES.SCOPE_RESTORE_USER_ID)?.value
        if (scopeRestoreUid) {
          twitchUserId = scopeRestoreUid
          logger.info('Login: extracted twitchUserId from scope restore cookie', {
            twitchUserId,
          })
        }
      }

      // 3. 自然失効後のスコープ復元: 期限切れセッションCookieからtwitchUserIdを取得
      // SCOPE_RESTORE_USER_ID はclearSession()でのみ設定されるため、セッションが明示ログアウト
      // なしに7日経過で自然失効した場合はこのフォールバックが必要。
      // 署名付きセッションは検証し、移行期間中の旧未署名Cookieもここだけは受け入れる。
      // parseSession()で全フィールドの型・存在を検証してからtwitchUserIdのみを使用する。
      // Fallback for natural session expiry (no explicit logout before 7-day timeout):
      // SCOPE_RESTORE_USER_ID is only set by clearSession(), so naturally-expired sessions
      // must fall back to the session cookie. Verify signed cookies, and temporarily
      // allow legacy unsigned cookies here so scope restoration keeps working.
      if (!twitchUserId) {
        const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value
        if (sessionCookie) {
          try {
            const payload = await verifySession(sessionCookie, { allowUnsignedLegacy: true })
            const parsed = parseSession(payload)
            twitchUserId = parsed.twitchUserId
            logger.info('Login: extracted twitchUserId from naturally expired session cookie', {
              twitchUserId,
            })
          } catch {
            // 構造検証失敗 = 破損/改ざんCookieなので無視
            // Structure validation failed = corrupted/tampered cookie, skip safely
          }
        }
      }

      // Validate Twitch user ID format before using in DB query.
      // Twitch IDは数字のみの文字列（最大15桁程度）。非数値が入る場合はCookie改ざん/
      // データ破損の可能性があり、不要なDBクエリとログ汚染を防ぐためスキップする。
      // Twitch user IDs are always numeric strings. Reject non-numeric values to prevent
      // unnecessary DB queries and log pollution from tampered or corrupted cookies.
      if (twitchUserId && !/^\d{1,20}$/.test(twitchUserId)) {
        logger.warn('Login: invalid twitchUserId format, skipping scope restoration', {
          format: 'non-numeric',
        })
        twitchUserId = null
      }

      if (twitchUserId) {
        // #663: 読み取り専用のため isPgReadEnabled() で分岐。
        const { data: user, error: dbError } = isPgReadEnabled()
          ? await fetchScopeRestorationUserPg(twitchUserId)
          : await getSupabaseAdmin()
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
