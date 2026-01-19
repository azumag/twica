import { cookies } from 'next/headers'
import { BROADCASTER_TYPE, COOKIE_NAMES } from './constants'
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
    
    return parsed as Session
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid session format: ${error.message}`)
    }
    throw new Error('Invalid session format')
  }
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    return null
  }

  try {
    const session = parseSession(sessionCookie)

    if (session.expiresAt && Date.now() > session.expiresAt) {
      await clearSession();
      try {
        const { clearCSRFToken } = await import('./csrf')
        await clearCSRFToken()
      } catch {
        // CSRFトークンクリアはセッションクリリアの失敗を意味しない
      }
      return null;
    }

    return session
  } catch (error) {
    logger.error('[Session] Failed to parse session cookie:', error);
    return null
  }
}

export function canUseStreamerFeatures(session: Session | null): boolean {
  if (!session) return false
  return session.broadcasterType === BROADCASTER_TYPE.AFFILIATE || session.broadcasterType === BROADCASTER_TYPE.PARTNER
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAMES.SESSION)
}
