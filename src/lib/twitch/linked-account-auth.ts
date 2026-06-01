import { NextResponse } from 'next/server'

import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { exchangeCodeForTokens, getTwitchUser, isInvalidAuthorizationCodeError } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'

function redirectToSettings(baseUrl: string, params: Record<string, string>) {
  const searchParams = new URLSearchParams(params)
  return NextResponse.redirect(`${baseUrl}/dashboard/settings?${searchParams.toString()}`)
}

export async function handleLinkedAccountCallback({
  baseUrl,
  code,
  redirectUri,
}: {
  baseUrl: string
  code: string
  redirectUri: string
}) {
  const session = await getSession()
  if (!session || !canUseStreamerFeatures(session)) {
    return redirectToSettings(baseUrl, { bot_error: ERROR_MESSAGES.UNAUTHORIZED })
  }

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

    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from('streamers')
      .select('id')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    if (streamerError || !streamer) {
      logger.error('Linked account callback: failed to find streamer', {
        twitchUserId: session.twitchUserId,
        linkedTwitchUserId: botUser.id,
        error: streamerError,
      })
      return redirectToSettings(baseUrl, { bot_error: 'database_error' })
    }

    const botAccountFields = {
      twitch_user_id: botUser.id,
      twitch_username: botUser.login,
      twitch_display_name: botUser.display_name,
      twitch_access_token: tokens.access_token,
      twitch_refresh_token: tokens.refresh_token,
      twitch_token_expires_at: expiresAt.toISOString(),
      scopes: tokens.scope ?? [],
      status: 'active',
      last_error: null,
    }

    const { data: existingBotAccount, error: existingBotError } = await supabaseAdmin
      .from('twitch_bot_accounts')
      .select('id')
      .eq('owner_type', 'streamer')
      .eq('streamer_id', streamer.id)
      .maybeSingle()

    if (existingBotError) {
      logger.error('Linked account callback: failed to fetch existing linked account', {
        twitchUserId: session.twitchUserId,
        linkedTwitchUserId: botUser.id,
        error: existingBotError,
      })
      return redirectToSettings(baseUrl, { bot_error: 'database_error' })
    }

    const botAccountResult = existingBotAccount
      ? await supabaseAdmin
          .from('twitch_bot_accounts')
          .update(botAccountFields)
          .eq('id', existingBotAccount.id)
          .select('id')
          .single()
      : await supabaseAdmin
          .from('twitch_bot_accounts')
          .insert({
            ...botAccountFields,
            owner_type: 'streamer',
            streamer_id: streamer.id,
          })
          .select('id')
          .single()

    if (botAccountResult.error) {
      logger.error('Linked account callback: failed to save linked account', {
        twitchUserId: session.twitchUserId,
        linkedTwitchUserId: botUser.id,
        error: botAccountResult.error,
      })
      return redirectToSettings(baseUrl, { bot_error: 'database_error' })
    }

    const { error: senderSettingsError } = await supabaseAdmin
      .from('streamer_chat_sender_settings')
      .upsert({
        streamer_id: streamer.id,
        sender_mode: 'custom_bot',
        custom_bot_account_id: botAccountResult.data.id,
      })

    if (senderSettingsError) {
      logger.error('Linked account callback: failed to save chat sender settings', {
        twitchUserId: session.twitchUserId,
        linkedTwitchUserId: botUser.id,
        error: senderSettingsError,
      })
      return redirectToSettings(baseUrl, { bot_error: 'database_error' })
    }

    logger.info('Linked account connected for chat announcements', {
      twitchUserId: session.twitchUserId,
      linkedTwitchUserId: botUser.id,
    })

    response.cookies.delete(COOKIE_NAMES.BOT_AUTH_STATE)
    return response
  } catch (error) {
    const errorType = isInvalidAuthorizationCodeError(error)
      ? 'invalid_authorization_code'
      : 'bot_auth_failed'
    logger.error('Linked account callback failed', {
      twitchUserId: session.twitchUserId,
      errorType,
      error,
    })
    return redirectToSettings(baseUrl, { bot_error: errorType })
  }
}
