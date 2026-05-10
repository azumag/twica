import { NextRequest, NextResponse } from 'next/server'

import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { API_ROUTES, COOKIE_NAMES, ERROR_MESSAGES, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { validateCSRFToken } from '@/lib/csrf'
import { randomBytesHex } from '@/lib/crypto-utils'
import { getBaseUrl } from '@/lib/url-utils'
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'

export async function POST(request: NextRequest) {
  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

    const session = await getSession()
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.authReauth, identifier)
    if (!rateLimitResult.success) {
      return NextResponse.json({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, { status: 429 })
    }

    if (!session || !canUseStreamerFeatures(session)) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    const supabaseAdmin = getSupabaseAdmin()
    const { data: streamer } = await supabaseAdmin
      .from('streamers')
      .select('id')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

    const state = randomBytesHex(32)
    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}${API_ROUTES.AUTH_BOT_CALLBACK}`
    const loginUrl = getTwitchAuthUrl(redirectUri, state, [ADDITIONAL_SCOPES.CHAT_WRITE])

    const response = NextResponse.json({ success: true, loginUrl })
    response.cookies.set(COOKIE_NAMES.BOT_AUTH_STATE, state, STATE_COOKIE_OPTIONS)
    return response
  } catch (error) {
    return handleApiError(error, 'BOT Auth Connect API: POST')
  }
}
