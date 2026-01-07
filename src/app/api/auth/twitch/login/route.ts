import { NextRequest, NextResponse } from 'next/server'
import { getTwitchAuthUrl, STREAMER_SCOPES, USER_SCOPES } from '@/lib/twitch/auth'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const role = searchParams.get('role') || 'user' // 'streamer' or 'user'

  const scopes = role === 'streamer' ? STREAMER_SCOPES : USER_SCOPES
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`

  // Generate state for CSRF protection
  const state = crypto.randomUUID()
  const stateData = JSON.stringify({ state, role })

  // Store state in cookie
  const cookieStore = await cookies()
  cookieStore.set('twitch_auth_state', stateData, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
  })

  const authUrl = getTwitchAuthUrl(redirectUri, scopes, state)

  return NextResponse.redirect(authUrl)
}
