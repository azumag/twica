import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getDiscordAuthUrl } from '@/lib/discord/auth'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { getSession } from '@/lib/session'
import { ERROR_MESSAGES, STATE_COOKIE_OPTIONS, COOKIE_NAMES } from '@/lib/constants'
import { getBaseUrl } from '@/lib/url-utils'
import { logger } from '@/lib/logger'
import { isDiscordEnabled } from '@/lib/discord/role-check'

/**
 * Discord OAuth2 認証開始
 * Twitchセッションが必要（ログイン済みユーザーのみDiscord連携可能）
 */
export async function GET(request: Request) {
  try {
    // Discord連携が設定されていない場合は404
    if (!isDiscordEnabled()) {
      return NextResponse.json(
        { error: 'Discord integration is not configured' },
        { status: 404 }
      )
    }

    const ip = getClientIp(request)
    const identifier = `ip:${ip}`
    const rateLimitResult = await checkRateLimit(rateLimits.discordLogin, identifier)

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

    // Twitchセッション確認（ログイン済みのみ）
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.NOT_AUTHENTICATED },
        { status: 401 }
      )
    }

    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}/api/auth/discord/callback`

    // CSRF保護用のstate生成
    const state = crypto.randomUUID()

    const cookieStore = await cookies()
    cookieStore.set(COOKIE_NAMES.DISCORD_AUTH_STATE, state, STATE_COOKIE_OPTIONS)

    const authUrl = getDiscordAuthUrl(redirectUri, state)

    logger.info('Discord OAuth login started', {
      twitchUserId: session.twitchUserId,
    })

    // redirect=true の場合はリダイレクト、それ以外はJSON
    const url = new URL(request.url)
    if (url.searchParams.get('redirect') === 'true') {
      return NextResponse.redirect(authUrl)
    }

    return NextResponse.json({ authUrl })
  } catch (error) {
    logger.error('Discord login error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
