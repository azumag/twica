import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { checkRateLimit, getClientIp, rateLimits } from '@/lib/rate-limit'
import { getBaseUrl } from '@/lib/url-utils'
import { handleLinkedAccountCallback } from '@/lib/twitch/linked-account-auth'
import { guardWriteRedirect } from '@/lib/maintenance/guard'

function redirectToSettings(baseUrl: string, params: Record<string, string>) {
  const searchParams = new URLSearchParams(params)
  return NextResponse.redirect(`${baseUrl}/dashboard/settings?${searchParams.toString()}`)
}

export async function GET(request: NextRequest) {
  // #694 Stage 3: GETだがBot連携情報の書き込み副作用を持つため、middlewareの
  // 一律ブロック対象外。route先頭で個別にmaintenance guardをかける。
  // config/maintenance-write-surfaces.json の /api/auth/bot/callback エントリ
  // （maintenanceBehavior: "redirect"）に対応。
  const maintenanceRedirect = guardWriteRedirect({
    operation: 'auth.bot.callback',
    redirectTo: '/?maintenance=1',
  })
  if (maintenanceRedirect) {
    return maintenanceRedirect
  }

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

  return handleLinkedAccountCallback({
    baseUrl,
    code,
    redirectUri: `${baseUrl}/api/auth/bot/callback`,
  })
}
