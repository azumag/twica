import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { exchangeCodeForTokens, getTwitchUser, isInvalidAuthorizationCodeError } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { checkRateLimit, getClientIp, rateLimits } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getBaseUrl } from '@/lib/url-utils'

function redirectToSettings(baseUrl: string, params: Record<string, string>) {
  const searchParams = new URLSearchParams(params)
  return NextResponse.redirect(`${baseUrl}/dashboard/settings?${searchParams.toString()}`)
}

export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl(request)
  const ip = getClientIp(request)
  const rateLimitResult = await checkRateLimit(rateLimits.authCallback, `ip:${ip}`)

  if (!rateLimitResult.success) {
    return redirectToSettings(baseUrl, { bot_error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED })
  }

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthError = searchParams.get('error')

  if (oauthError) {
    return redirectToSettings(baseUrl, { bot_error: oauthError })
  }

  if (!code || !state) {
    return redirectToSettings(baseUrl, { bot_error: 'missing_params' })
  }

  const cookieStore = await cookies()
  const storedState = cookieStore.get(COOKIE_NAMES.BOT_AUTH_STATE)?.value
  if (!storedState || state !== storedState) {
    return redirectToSettings(baseUrl, { bot_error: 'invalid_state' })
  }

  const session = await getSession()
  if (!session || !canUseStreamerFeatures(session)) {
    return redirectToSettings(baseUrl, { bot_error: ERROR_MESSAGES.UNAUTHORIZED })
  }

  const redirectUri = `${baseUrl}/api/auth/bot/callback`
  const response = redirectToSettings(baseUrl, { bot: 'connected' })

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri)
    if (!tokens.scope?.includes(ADDITIONAL_SCOPES.CHAT_WRITE)) {
      return redirectToSettings(baseUrl, { bot_error: 'missing_chat_scope' })
    }

    const botUser = await getTwitchUser(tokens.access_token)
    if (botUser.id === session.twitchUserId) {
      return redirectToSettings(baseUrl, { bot_error: 'same_account' })
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
    const supabaseAdmin = getSupabaseAdmin()
    const { error } = await supabaseAdmin
      .from('streamers')
      .update({
        bot_twitch_user_id: botUser.id,
        bot_twitch_username: botUser.login,
        bot_twitch_display_name: botUser.display_name,
        bot_twitch_access_token: tokens.access_token,
        bot_twitch_refresh_token: tokens.refresh_token,
        bot_twitch_token_expires_at: expiresAt.toISOString(),
      })
      .eq('twitch_user_id', session.twitchUserId)

    if (error) {
      logger.error('BOT auth callback: failed to save BOT account', {
        twitchUserId: session.twitchUserId,
        botTwitchUserId: botUser.id,
        error,
      })
      return redirectToSettings(baseUrl, { bot_error: 'database_error' })
    }

    logger.info('BOT account connected for chat announcements', {
      twitchUserId: session.twitchUserId,
      botTwitchUserId: botUser.id,
    })

    response.cookies.delete(COOKIE_NAMES.BOT_AUTH_STATE)
    return response
  } catch (error) {
    const errorType = isInvalidAuthorizationCodeError(error)
      ? 'invalid_authorization_code'
      : 'bot_auth_failed'
    logger.error('BOT auth callback failed', {
      twitchUserId: session.twitchUserId,
      errorType,
      error,
    })
    return redirectToSettings(baseUrl, { bot_error: errorType })
  }
}
