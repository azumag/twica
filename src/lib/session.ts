import { cookies } from 'next/headers'
import { BROADCASTER_TYPE, COOKIE_NAMES } from './constants'

export interface Session {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string
  broadcasterType: string // 'affiliate' | 'partner' | ''
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    console.log('[Session] No twica_session cookie found. All cookies:', cookieStore.getAll().map(c => c.name));
    return null
  }

  console.log('[Session] Found session cookie, length:', sessionCookie.length);

  try {
    const session = JSON.parse(sessionCookie) as Session

    if (session.expiresAt && Date.now() > session.expiresAt) {
      console.log('[Session] Session expired at:', new Date(session.expiresAt).toISOString());
      return null
    }

    return session
  } catch (error) {
    console.error('[Session] Failed to parse session cookie:', error);
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
