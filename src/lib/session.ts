import { cookies } from 'next/headers'

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
  const sessionCookie = cookieStore.get('twica_session')?.value

  if (!sessionCookie) {
    console.log('[Session] No twica_session cookie found');
    return null
  }

  try {
    const session = JSON.parse(sessionCookie) as Session
    return session
  } catch (error) {
    console.error('[Session] Failed to parse session cookie:', error);
    return null
  }
}

export function canUseStreamerFeatures(session: Session | null): boolean {
  if (!session) return false
  return session.broadcasterType === 'affiliate' || session.broadcasterType === 'partner'
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete('twica_session')
}
