import { cookies } from 'next/headers'
import { cache } from 'react'
import { BROADCASTER_TYPE, COOKIE_NAMES, getDeleteCookieOptions, getSessionCookieOptions } from './constants'
import { logger } from './logger'
import { type SessionPayload, parseSession, verifySession } from './session-cookie'

export { parseSession, signSession, verifySession } from './session-cookie'

export type Session = SessionPayload

function isExpectedSessionCookieError(error: unknown): error is Error {
  return error instanceof Error && (
    error.message === 'Session cookie is not signed'
    || error.message === 'Session cookie signature invalid'
    || error.message === 'Session cookie cannot be verified without SESSION_COOKIE_SECRET'
    || error.message.startsWith('Invalid session format:')
  )
}

/**
 * Get session from cookies with request-level caching
 * Using React.cache() to avoid duplicate session reads within the same request.
 * Layout and page both call getSession(), but it will only execute once per request.
 *
 * React.cache()を使用してリクエスト内でセッションの重複読み取りを回避。
 * レイアウトとページの両方がgetSession()を呼び出すが、リクエストごとに1回のみ実行される。
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const start = Date.now();
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    logger.info(`[Perf] getSession (no cookie): ${Date.now() - start}ms`);
    return null
  }

  try {
    const payload = await verifySession(sessionCookie)
    const session = parseSession(payload)

    if (session.expiresAt && Date.now() > session.expiresAt) {
      logger.warn('[Session] Session expired')
      // 期限切れセッションCookieはミドルウェアで削除しない（スコープ保持のため）。
      // Cookie自体はCOOKIE_MAX_AGE_SECONDSの期限でブラウザが自動削除する。
      // Server ComponentからのCookie書き込みはNext.jsで禁止されている。
      // Expired session cookies are NOT deleted by middleware (preserved for scope restoration).
      // The cookie is automatically cleaned up by the browser when COOKIE_MAX_AGE_SECONDS expires.
      // Server Components cannot write cookies in Next.js.
      logger.info(`[Perf] getSession (expired): ${Date.now() - start}ms`);
      return null;
    }

    logger.info(`[Perf] getSession: ${Date.now() - start}ms`);
    return session
  } catch (error) {
    if (isExpectedSessionCookieError(error)) {
      logger.warn('[Session] Ignoring invalid session cookie', {
        reason: error.message,
      })
    } else {
      logger.error('[Session] Failed to parse session cookie:', error);
    }
    logger.info(`[Perf] getSession (error): ${Date.now() - start}ms`);
    return null
  }
})

export function canUseStreamerFeatures(session: Session | null): boolean {
  if (!session) return false
  return session.broadcasterType === BROADCASTER_TYPE.AFFILIATE || session.broadcasterType === BROADCASTER_TYPE.PARTNER
}

export async function clearSession(): Promise<void> {
  // Debug: Log stack trace to find who is calling clearSession
  const stack = new Error().stack
  logger.warn('[Session] clearSession called', {
    stack: stack?.split('\n').slice(1, 5).join(' | '),
  })

  const cookieStore = await cookies()
  const existingCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (existingCookie) {
    try {
      // ログアウト後スコープ復元のために twitchUserId のみ専用 Cookie に分離して保持する。
      // 全セッションデータを保持すると署名なしで改ざんが可能なため、
      // loginルートが必要とする twitchUserId だけを最小 Cookie に保存する。
      // loginルートはこの Cookie から twitchUserId を取得し、
      // DBの追加スコープ（user:write:chat等）を OAuthリクエストに含める。
      //
      // On logout, store only twitchUserId in a minimal dedicated cookie for scope restoration.
      // Keeping the full session (unsigned) would allow tampering; the login route only needs
      // twitchUserId to look up additional scopes (e.g., user:write:chat) from DB.
      const payload = await verifySession(existingCookie, { allowUnsignedLegacy: true })
      const parsed = parseSession(payload)
      cookieStore.set(COOKIE_NAMES.SCOPE_RESTORE_USER_ID, parsed.twitchUserId, getSessionCookieOptions())
    } catch {
      // Cookie解析失敗時はスコープ復元用Cookieを設定しない（追加スコープは失われるが安全側に倒す）
      // Skip scope restore cookie on parse failure (additional scopes lost, but fail safe)
    }
  }

  // セッションCookieをハードログアウト（削除）
  // Hard logout: always delete session cookie
  cookieStore.set(COOKIE_NAMES.SESSION, '', getDeleteCookieOptions())
}
