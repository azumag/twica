import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Use getSession() which uses cookies() from next/headers
  // This is consistent with how other API routes read the session
  const session = await getSession()

  if (!session) {
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
}
