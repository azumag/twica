import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_NAMES } from '@/lib/constants'
import { parseSession } from '@/lib/session'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  // Debug: log all cookies from request
  const allCookies = request.cookies.getAll()
  const cookieHeader = request.headers.get('cookie')
  logger.info('Session API: Cookie debug', {
    cookieHeaderPresent: !!cookieHeader,
    cookieHeaderLength: cookieHeader?.length || 0,
    cookiesFromRequest: allCookies.map(c => c.name),
  })

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
