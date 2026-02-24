import { type Session } from '@/lib/session'

export { type Session } from '@/lib/session'

export async function fetchSession(): Promise<Session | null> {
  try {
    const response = await fetch('/api/session', {
      credentials: 'include'
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()

    if (!data || typeof data !== 'object') {
      return null
    }

    const requiredFields = [
      'twitchUserId',
      'twitchUsername',
      'twitchDisplayName',
      'twitchProfileImageUrl',
      'broadcasterType',
      'expiresAt',
      'version'
    ]

    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        return null
      }
    }

    if (typeof data.expiresAt !== 'number') return null
    if (typeof data.version !== 'number') return null

    return data as Session
  } catch {
    return null
  }
}
