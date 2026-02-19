import { cookies } from 'next/headers'
import { cache } from 'react'
import { BROADCASTER_TYPE, COOKIE_NAMES, getDeleteCookieOptions } from './constants'
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
    const session = parseSession(sessionCookie)

    if (session.expiresAt && Date.now() > session.expiresAt) {
      logger.warn('[Session] Session expired')
      // Cookie cleanup is handled by middleware (updateSession)
      // ミドルウェア（updateSession）でCookieクリアを処理するため、ここではCookie操作しない
      // Server ComponentからのCookie書き込みはNext.jsで禁止されている
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
  // ドメイン設定されたCookieを確実に削除するため、maxAge=0で上書き
  cookieStore.set(COOKIE_NAMES.SESSION, '', getDeleteCookieOptions())
}
