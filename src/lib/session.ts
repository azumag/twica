import { cookies } from 'next/headers'
import { cache } from 'react'
import { BROADCASTER_TYPE, COOKIE_NAMES, getDeleteCookieOptions, getSessionCookieOptions } from './constants'
import { constantTimeEqual, hmacSha256 } from './crypto-utils'
import { logger } from './logger'

export interface Session {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string
  broadcasterType: string // 'affiliate' | 'partner' | ''
  expiresAt: number // Unix timestamp (milliseconds)
  csrfTokenHash?: string
  version: number // Optimistic locking
}

/**
 * セッションCookieにHMAC-SHA256署名を付与する
 * Sign session cookie data with HMAC-SHA256.
 *
 * フォーマット: {base64url_payload}.{hex_signature}
 * 環境変数 SESSION_COOKIE_SECRET が未設定の場合は署名なしで返却（後方互換性のため警告を出す）。
 *
 * Format: {base64url_payload}.{hex_signature}
 * Falls back to unsigned payload if SESSION_COOKIE_SECRET is not set (logs warning for backward compat).
 */
export async function signSession(payload: string): Promise<string> {
  const secret = process.env.SESSION_COOKIE_SECRET
  if (!secret) {
    // シークレット未設定時は警告を出して未署名のままにする（既存セッションの互換性維持）
    // Warn and return unsigned if secret not configured (preserves existing sessions)
    logger.warn('[Session] SESSION_COOKIE_SECRET not set - session cookie is unsigned. Set this env var to enable tamper protection.')
    return payload
  }
  const signature = await hmacSha256(secret, payload)
  return `${payload}.${signature}`
}

/**
 * 署名付きセッションCookieを検証し、ペイロードを返す
 * Verify a signed session cookie and return the raw payload.
 *
 * 署名検証に失敗した場合は例外を投げる。
 * SESSION_COOKIE_SECRET 未設定の場合は署名なしとして扱う（後方互換性）。
 *
 * Throws on signature mismatch.
 * Falls back to unsigned if SESSION_COOKIE_SECRET is not set (backward compat).
 */
export async function verifySession(signed: string): Promise<string> {
  const secret = process.env.SESSION_COOKIE_SECRET
  if (!secret) {
    // シークレット未設定時は署名なしとして扱う
    // Treat as unsigned if secret not configured
    return signed
  }

  // {payload}.{signature} 形式を分割
  const lastDot = signed.lastIndexOf('.')
  if (lastDot === -1) {
    // 署名なしの旧フォーマット（シークレット設定後の移行期間中に発生しうる）
    // Unsigned legacy format (may occur during migration after secret is first set)
    logger.warn('[Session] Session cookie has no signature - rejecting. User must re-login.')
    throw new Error('Session cookie is not signed')
  }

  const payload = signed.substring(0, lastDot)
  const providedSig = signed.substring(lastDot + 1)

  // HMAC-SHA256で署名を再計算し、定数時間比較でタイミング攻撃を防ぐ
  // Recompute signature and compare in constant time to prevent timing attacks
  const expectedSig = await hmacSha256(secret, payload)
  if (!constantTimeEqual(providedSig, expectedSig)) {
    logger.warn('[Session] Session cookie signature mismatch - possible tampering detected.')
    throw new Error('Session cookie signature invalid')
  }

  return payload
}

export function parseSession(raw: string): Session {
  try {
    const parsed = JSON.parse(raw)
    
    // Validate all required fields
    const requiredFields = [
      'twitchUserId',
      'twitchUsername', 
      'twitchDisplayName',
      'twitchProfileImageUrl',
      'broadcasterType',
      'expiresAt',
      'version'
    ] as const
    
    for (const field of requiredFields) {
      if (parsed[field] === undefined || parsed[field] === null) {
        throw new Error(`Invalid session: missing required field '${field}'`)
      }
    }
    
    // Validate field types
    if (typeof parsed.twitchUserId !== 'string') {
      throw new Error('Invalid session: twitchUserId must be a string')
    }
    if (typeof parsed.twitchUsername !== 'string') {
      throw new Error('Invalid session: twitchUsername must be a string')
    }
    if (typeof parsed.twitchDisplayName !== 'string') {
      throw new Error('Invalid session: twitchDisplayName must be a string')
    }
    if (typeof parsed.twitchProfileImageUrl !== 'string') {
      throw new Error('Invalid session: twitchProfileImageUrl must be a string')
    }
    if (typeof parsed.broadcasterType !== 'string') {
      throw new Error('Invalid session: broadcasterType must be a string')
    }
    if (typeof parsed.expiresAt !== 'number') {
      throw new Error('Invalid session: expiresAt must be a number')
    }
    if (typeof parsed.version !== 'number') {
      throw new Error('Invalid session: version must be a number')
    }
    if (!Number.isInteger(parsed.version)) {
      throw new Error('Invalid session: version must be an integer')
    }
    if (parsed.version < 1) {
      throw new Error('Invalid session: version must be greater than or equal to 1')
    }
    if (parsed.version > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid session: version exceeds maximum safe integer value')
    }
    
    return parsed as Session
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid session format: ${error.message}`)
    }
    throw new Error('Invalid session format')
  }
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
    // 署名検証: SESSION_COOKIE_SECRET が設定されている場合はHMAC-SHA256で検証する
    // Verify signature if SESSION_COOKIE_SECRET is set (HMAC-SHA256)
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
    logger.error('[Session] Failed to parse session cookie:', error);
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
      const payload = await verifySession(existingCookie)
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
