import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getTwitchAuthUrl, ADDITIONAL_SCOPES } from '@/lib/twitch/auth'
import { API_ROUTES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { randomBytesHex } from '@/lib/crypto-utils'

// 有効な追加スコープのリスト（セキュリティ: 許可されたスコープのみ受け付ける）
// List of valid additional scopes (security: only accept allowed scopes)
const VALID_ADDITIONAL_SCOPES: string[] = Object.values(ADDITIONAL_SCOPES)

export async function POST(request: Request) {
  try {
    const session = await getSession()
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const result = await checkRateLimit(rateLimits.authReauth, identifier)
    if (!result.success) {
      return NextResponse.json({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, { status: 429 })
    }

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // リクエストボディから追加スコープを取得（オプション）
    // Get additional scopes from request body (optional)
    let additionalScopes: string[] = []
    try {
      const body = await request.json()
      if (body.additionalScopes && Array.isArray(body.additionalScopes)) {
        // 有効なスコープのみをフィルタリング（セキュリティ対策）
        // Filter to only valid scopes (security measure)
        additionalScopes = body.additionalScopes.filter((scope: string) =>
          VALID_ADDITIONAL_SCOPES.includes(scope)
        )
      }
    } catch {
      // JSONパースエラーは無視（ボディが空の場合も含む）
      // Ignore JSON parse errors (including empty body)
    }

    await deleteTwitchTokens(session.twitchUserId)
    logger.info(`Deleted Twitch tokens for user: ${session.twitchUserId}`)

    // Use Web Crypto API for random bytes generation (Cloudflare Workers compatible)
    // Web Crypto APIを使用してランダムバイトを生成（Cloudflare Workers互換）
    const state = randomBytesHex(32)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const redirectUri = `${baseUrl}${API_ROUTES.AUTH_TWITCH_CALLBACK}`

    // 追加スコープがある場合はそれを含めた認証URLを生成
    // Generate auth URL with additional scopes if provided
    const loginUrl = getTwitchAuthUrl(redirectUri, state, additionalScopes.length > 0 ? additionalScopes : undefined)

    logger.info('Re-auth URL generated', {
      twitchUserId: session.twitchUserId,
      hasAdditionalScopes: additionalScopes.length > 0,
      additionalScopes,
    })

    return NextResponse.json({
      success: true,
      loginUrl,
      state, // stateを返してクライアント側でCookieに保存できるようにする
    })
  } catch (error) {
    return handleApiError(error, 'Re-auth API: POST')
  }
}
