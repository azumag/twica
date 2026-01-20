import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser } from '@/lib/twitch/auth'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { handleAuthError } from '@/lib/auth-error-handler'
import { COOKIE_NAMES, SESSION_CONFIG, ERROR_MESSAGES, getSessionCookieOptions } from '@/lib/constants'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const identifier = `ip:${ip}`;
  const rateLimitResult = await checkRateLimit(rateLimits.authCallback, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)}`
    );
  }

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
    return handleAuthError(
      new Error('Missing OAuth parameters'),
      'missing_params',
      { code: !!code, state: !!state }
    )
  }

  // Verify state
  const cookieStore = await cookies()
  const storedState = cookieStore.get('twitch_auth_state')?.value

  if (!storedState || state !== storedState) {
    return handleAuthError(
      new Error('Invalid state parameter'),
      'invalid_state',
      { storedState: !!storedState, stateMatch: storedState === state }
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/twitch/callback`
    
    let tokens
    try {
      tokens = await exchangeCodeForTokens(code, redirectUri)
    } catch (error) {
      return handleAuthError(
        error,
        'twitch_auth_failed',
        { code: code.substring(0, 10) + '...' }
      )
    }

    let twitchUser
    try {
      twitchUser = await getTwitchUser(tokens.access_token)
    } catch (error) {
      return handleAuthError(
        error,
        'twitch_user_fetch_failed',
        { twitchUserId: tokens.access_token.substring(0, 10) + '...' }
      )
    }

    // Check if user can be a streamer (affiliate or partner)
    const canBeStreamer = twitchUser.broadcaster_type === 'affiliate' || twitchUser.broadcaster_type === 'partner'

    try {
      await supabaseAdmin
        .from('users')
        .upsert({
          twitch_user_id: twitchUser.id,
          twitch_username: twitchUser.login,
          twitch_display_name: twitchUser.display_name,
          twitch_profile_image_url: twitchUser.profile_image_url,
          twitch_access_token: tokens.access_token,
          twitch_refresh_token: tokens.refresh_token,
          twitch_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        }, {
          onConflict: 'twitch_user_id',
        })
    } catch (error) {
      return handleAuthError(
        error,
        'database_error',
        { operation: 'upsert_user', twitchUserId: twitchUser.id }
      )
    }

    if (canBeStreamer) {
      try {
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
      } catch (error) {
        return handleAuthError(
          error,
          'database_error',
          { operation: 'upsert_streamer', twitchUserId: twitchUser.id }
        )
      }
    }

    // Set session cookie with user info only (no tokens - Supabase Auth handles tokens)
    const sessionData = JSON.stringify({
      twitchUserId: twitchUser.id,
      twitchUsername: twitchUser.login,
      twitchDisplayName: twitchUser.display_name,
      twitchProfileImageUrl: twitchUser.profile_image_url,
      broadcasterType: twitchUser.broadcaster_type,
      expiresAt: Date.now() + SESSION_CONFIG.MAX_AGE_MS,
      version: 1,
    })

    // Log session data size for debugging
    logger.info('Auth callback: Setting session cookie', {
      sessionDataLength: sessionData.length,
      cookieName: COOKIE_NAMES.SESSION,
      twitchUserId: twitchUser.id,
    })

    const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`

    logger.info('Auth callback: Redirecting with session cookie', {
      twitchUserId: twitchUser.id,
      redirectUrl,
    })

    // Create redirect response with cookies
    const response = NextResponse.redirect(redirectUrl)

    // セッションCookieを設定（統一されたドメイン設定を使用）
    const cookieOptions = getSessionCookieOptions()

    logger.info('Auth callback: Setting cookie with options', {
      domain: cookieOptions.domain,
      secure: cookieOptions.secure,
    })

    response.cookies.set(COOKIE_NAMES.SESSION, sessionData, cookieOptions)

    // Clear state cookie
    response.cookies.delete('twitch_auth_state')

    // Log the Set-Cookie header for debugging
    const setCookieHeader = response.headers.get('Set-Cookie')
    logger.info('Auth callback: Set-Cookie header', {
      hasCookieHeader: !!setCookieHeader,
      cookieHeaderLength: setCookieHeader?.length || 0,
    })

    return response
  } catch (error) {
    return handleAuthError(error, 'unknown_error')
  }
}
