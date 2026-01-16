import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser } from '@/lib/twitch/auth'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { COOKIE_NAMES } from '@/lib/constants'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent(error)}`
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent('missing_params')}`
    )
  }

  // Verify state
  const cookieStore = await cookies()
  const storedState = cookieStore.get('twitch_auth_state')?.value

  if (!storedState || state !== storedState) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent('invalid_state')}`
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`
    const tokens = await exchangeCodeForTokens(code, redirectUri)
    const twitchUser = await getTwitchUser(tokens.access_token)

    // Check if user can be a streamer (affiliate or partner)
    const canBeStreamer = twitchUser.broadcaster_type === 'affiliate' || twitchUser.broadcaster_type === 'partner'

    // Always upsert to users table
    await supabaseAdmin
      .from('users')
      .upsert({
        twitch_user_id: twitchUser.id,
        twitch_username: twitchUser.login,
        twitch_display_name: twitchUser.display_name,
        twitch_profile_image_url: twitchUser.profile_image_url,
      }, {
        onConflict: 'twitch_user_id',
      })

    // If affiliate/partner, also upsert to streamers table
    if (canBeStreamer) {
      await supabaseAdmin
        .from('streamers')
        .upsert({
          twitch_user_id: twitchUser.id,
          twitch_username: twitchUser.login,
          twitch_display_name: twitchUser.display_name,
          twitch_profile_image_url: twitchUser.profile_image_url,
        }, {
          onConflict: 'twitch_user_id',
        })
    }

    // Set session cookie with user info only (no tokens - Supabase Auth handles tokens)
    const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const sessionData = JSON.stringify({
      twitchUserId: twitchUser.id,
      twitchUsername: twitchUser.login,
      twitchDisplayName: twitchUser.display_name,
      twitchProfileImageUrl: twitchUser.profile_image_url,
      broadcasterType: twitchUser.broadcaster_type,
      expiresAt: Date.now() + SESSION_DURATION,
    })

    cookieStore.set(COOKIE_NAMES.SESSION, sessionData, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })

    // Clear state cookie
    cookieStore.delete('twitch_auth_state')

    // Always redirect to dashboard
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`)
  } catch (err) {
    logger.error('Auth error:', err)
    const errorMessage = err instanceof Error ? err.message : 'auth_failed'
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent(errorMessage)}`
    )
  }
}
