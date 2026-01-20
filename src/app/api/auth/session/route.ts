import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_NAMES } from '@/lib/constants'
import { parseSession } from '@/lib/session'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Read session cookie directly from request
  const sessionCookie = request.cookies.get(COOKIE_NAMES.SESSION)?.value

  if (!sessionCookie) {
    logger.info('Session API: No session cookie found')
    return NextResponse.json({ session: null })
  }

  try {
    const session = parseSession(sessionCookie)

    // Check if session is expired
    if (session.expiresAt && Date.now() > session.expiresAt) {
      logger.info('Session API: Session expired')
      return NextResponse.json({ session: null })
    }

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
  } catch (error) {
    logger.error('Session API: Failed to parse session', { error })
    return NextResponse.json({ session: null })
  }
}
