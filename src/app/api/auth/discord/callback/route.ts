import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeDiscordCode, getDiscordUser, getGuildMember } from '@/lib/discord/auth'
import { saveDiscordTokens } from '@/lib/discord/token-manager'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { getSession } from '@/lib/session'
import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { getBaseUrl } from '@/lib/url-utils'
import { getEnvVar } from '@/lib/env-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

/**
 * Discord OAuth2 コールバック
 * トークン交換、ユーザー情報取得、ロール確認、DB保存を行う
 */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl(request)

  const ip = getClientIp(request)
  const identifier = `ip:${ip}`
  const rateLimitResult = await checkRateLimit(rateLimits.discordCallback, identifier)

  if (!rateLimitResult.success) {
    return NextResponse.redirect(
      `${baseUrl}/dashboard/account?error=${encodeURIComponent(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)}`
    )
  }

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    logger.warn('Discord OAuth error:', { error })
    const response = NextResponse.redirect(
      `${baseUrl}/dashboard/account?discord_error=${encodeURIComponent(error)}`
    )
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  }

  if (!code || !state) {
    const response = NextResponse.redirect(
      `${baseUrl}/dashboard/account?discord_error=${encodeURIComponent('Missing OAuth parameters')}`
    )
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  }

  // State検証（CSRF保護）
  const cookieStore = await cookies()
  const storedState = cookieStore.get(COOKIE_NAMES.DISCORD_AUTH_STATE)?.value

  if (!storedState || state !== storedState) {
    logger.warn('Discord callback: Invalid state', {
      storedState: !!storedState,
      stateMatch: storedState === state,
    })
    const response = NextResponse.redirect(
      `${baseUrl}/dashboard/account?discord_error=${encodeURIComponent('Invalid state parameter')}`
    )
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  }

  // Twitchセッション確認
  const session = await getSession()
  if (!session) {
    const response = NextResponse.redirect(
      `${baseUrl}/?error=${encodeURIComponent(ERROR_MESSAGES.NOT_AUTHENTICATED)}`
    )
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/discord/callback`

    // トークン交換
    const tokens = await exchangeDiscordCode(code, redirectUri)

    // Discordユーザー情報取得
    const discordUser = await getDiscordUser(tokens.access_token)

    // トークンをDB保存
    await saveDiscordTokens(session.twitchUserId, tokens, discordUser.id)

    // ギルドメンバー情報からロールを確認
    const guildId = getEnvVar('DISCORD_GUILD_ID')!
    const subRoleId = getEnvVar('DISCORD_SUB_ROLE_ID')!

    let hasSubRole = false
    try {
      const member = await getGuildMember(tokens.access_token, guildId)
      hasSubRole = member.roles.includes(subRoleId)
    } catch (memberError) {
      // ギルドメンバー取得失敗（ギルド未参加等）はエラーではなくロールなしとして扱う
      // Guild member fetch failure (not in guild, etc.) is treated as no role, not an error
      logger.info('Discord callback: Could not fetch guild member', {
        twitchUserId: session.twitchUserId,
        error: memberError instanceof Error ? memberError.message : String(memberError),
      })
    }

    // ロール確認結果をDBに記録（ロールの有無に関わらず更新）
    const supabaseAdmin = getSupabaseAdmin()
    await supabaseAdmin
      .from('users')
      .update({
        discord_sub_verified_at: new Date().toISOString(),
        discord_has_sub_role: hasSubRole,
      })
      .eq('twitch_user_id', session.twitchUserId)

    logger.info('Discord OAuth callback completed', {
      twitchUserId: session.twitchUserId,
      discordUserId: discordUser.id,
      hasSubRole,
    })

    // state Cookieを削除してアカウント設定ページにリダイレクト
    const response = NextResponse.redirect(`${baseUrl}/dashboard/account`)
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  } catch (error) {
    logger.error('Discord callback error:', {
      twitchUserId: session.twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    const response = NextResponse.redirect(
      `${baseUrl}/dashboard/account?discord_error=${encodeURIComponent('Discord authentication failed')}`
    )
    response.cookies.delete(COOKIE_NAMES.DISCORD_AUTH_STATE)
    return response
  }
}
