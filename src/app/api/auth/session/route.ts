import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSession } from '@/lib/session'
import { COOKIE_NAMES } from '@/lib/constants'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Debug: log cookie info
  const cookieStore = await cookies()
  const allCookies = cookieStore.getAll()
  const sessionCookieValue = cookieStore.get(COOKIE_NAMES.SESSION)?.value

  logger.info('Session API: Cookie debug', {
    cookieCount: allCookies.length,
    cookieNames: allCookies.map(c => c.name),
    hasSessionCookie: !!sessionCookieValue,
    sessionCookieLength: sessionCookieValue?.length || 0,
  })

  // Use getSession() which uses cookies() from next/headers
  // This is consistent with how other API routes read the session
  const session = await getSession()

  if (!session) {
    logger.info('Session API: No session returned from getSession()')
    return NextResponse.json({ session: null })
  }

  logger.info('Session API: Session found', {
    twitchUserId: session.twitchUserId,
  })

  // Return session info without sensitive data
  return NextResponse.json({
    session: {
      twitchUserId: session.twitchUserId,
      twitchUsername: session.twitchUsername,
      twitchDisplayName: session.twitchDisplayName,
      twitchProfileImageUrl: session.twitchProfileImageUrl,
      broadcasterType: session.broadcasterType,
    }
  })
}
