import { NextResponse } from 'next/server'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { cookies } from 'next/headers'

export async function GET() {
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`

  // Generate state for CSRF protection
  const state = crypto.randomUUID()

  // Store state in cookie
  const cookieStore = await cookies()
  cookieStore.set('twitch_auth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
  })

  const authUrl = getTwitchAuthUrl(redirectUri, state)

  return NextResponse.redirect(authUrl)
}
