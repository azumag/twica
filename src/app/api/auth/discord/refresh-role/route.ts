import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { getDiscordAccessToken } from '@/lib/discord/token-manager'
import { getGuildMember } from '@/lib/discord/auth'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getEnvVar } from '@/lib/env-validation'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { ERROR_MESSAGES } from '@/lib/constants'
import { isDiscordEnabled } from '@/lib/discord/role-check'
import { logger } from '@/lib/logger'

/**
 * Discordサブスクライバーロールを手動リフレッシュ
 * キャッシュを無視してDiscord APIに直接問い合わせる
 */
export async function POST(request: Request) {
  try {
    // CSRF検証
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    if (!isDiscordEnabled()) {
      return NextResponse.json(
        { error: 'Discord integration is not configured' },
        { status: 404 }
      )
    }

    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.NOT_AUTHENTICATED },
        { status: 401 }
      )
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.discordRefreshRole, identifier)

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        { status: 429, headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        }}
      )
    }

    // Discordトークンを取得（期限切れ時は自動リフレッシュ）
    const accessToken = await getDiscordAccessToken(session.twitchUserId)
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Discord is not linked' },
        { status: 400 }
      )
    }

    const guildId = getEnvVar('DISCORD_GUILD_ID')!
    const subRoleId = getEnvVar('DISCORD_SUB_ROLE_ID')!

    // ギルドメンバー情報を取得してロールを確認
    const supabaseAdmin = getSupabaseAdmin()
    let hasSubRole = false

    try {
      const member = await getGuildMember(accessToken, guildId)
      hasSubRole = member.roles.includes(subRoleId)
    } catch (error) {
      logger.info('Discord refresh-role: Could not fetch guild member', {
        twitchUserId: session.twitchUserId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // DB更新: ロール確認結果を記録（ロールの有無に関わらず確認日時とフラグを更新）
    await supabaseAdmin
      .from('users')
      .update({
        discord_sub_verified_at: new Date().toISOString(),
        discord_has_sub_role: hasSubRole,
      })
      .eq('twitch_user_id', session.twitchUserId)

    logger.info('Discord role refreshed', {
      twitchUserId: session.twitchUserId,
      hasSubRole,
    })

    return NextResponse.json({ success: true, hasSubRole })
  } catch (error) {
    logger.error('Discord refresh-role error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
