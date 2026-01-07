import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser } from '@/lib/twitch/auth'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${error}`
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=missing_params`
    )
  }

  // Verify state
  const cookieStore = await cookies()
  const storedStateData = cookieStore.get('twitch_auth_state')?.value

  if (!storedStateData) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=missing_state`
    )
  }

  const { state: storedState, role } = JSON.parse(storedStateData)

  if (state !== storedState) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=invalid_state`
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`
    const tokens = await exchangeCodeForTokens(code, redirectUri)
    const twitchUser = await getTwitchUser(tokens.access_token)

    if (role === 'streamer') {
      // Upsert streamer
      const { error: dbError } = await supabaseAdmin
        .from('streamers')
        .upsert({
          twitch_user_id: twitchUser.id,
          twitch_username: twitchUser.login,
          twitch_display_name: twitchUser.display_name,
          twitch_profile_image_url: twitchUser.profile_image_url,
        }, {
          onConflict: 'twitch_user_id',
        })

      if (dbError) {
        console.error('Database error:', dbError)
        return NextResponse.redirect(
          `${process.env.NEXT_PUBLIC_APP_URL}/?error=db_error`
        )
      }
    } else {
      // Upsert user
      const { error: dbError } = await supabaseAdmin
        .from('users')
        .upsert({
          twitch_user_id: twitchUser.id,
          twitch_username: twitchUser.login,
          twitch_display_name: twitchUser.display_name,
          twitch_profile_image_url: twitchUser.profile_image_url,
        }, {
          onConflict: 'twitch_user_id',
        })

      if (dbError) {
        console.error('Database error:', dbError)
        return NextResponse.redirect(
          `${process.env.NEXT_PUBLIC_APP_URL}/?error=db_error`
        )
      }
    }

    // Set session cookie with tokens and user info
    const sessionData = JSON.stringify({
      role,
      twitchUserId: twitchUser.id,
      twitchUsername: twitchUser.login,
      twitchDisplayName: twitchUser.display_name,
      twitchProfileImageUrl: twitchUser.profile_image_url,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    })

    cookieStore.set('twica_session', sessionData, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    })

    // Clear state cookie
    cookieStore.delete('twitch_auth_state')

    // Redirect based on role
    const redirectPath = role === 'streamer' ? '/dashboard' : '/collection'
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}${redirectPath}`)
  } catch (err) {
    console.error('Auth error:', err)
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=auth_failed`
    )
  }
}
