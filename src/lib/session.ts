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
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    return null
  }

  try {
    const session = JSON.parse(sessionCookie) as Session

    if (session.expiresAt && Date.now() > session.expiresAt) {
      await clearSession();
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
