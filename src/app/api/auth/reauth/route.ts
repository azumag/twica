import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { API_ROUTES, COOKIE_NAMES, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { randomBytesHex } from '@/lib/crypto-utils'
import { getBaseUrl } from '@/lib/url-utils'

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
    let requestedScopes: string[] = []
    try {
      const body = await request.json()
      if (body.additionalScopes && Array.isArray(body.additionalScopes)) {
        // 有効なスコープのみをフィルタリング（セキュリティ対策）
        // Filter to only valid scopes (security measure)
        requestedScopes = body.additionalScopes.filter((scope: string) =>
          VALID_ADDITIONAL_SCOPES.includes(scope)
        )
      }
    } catch {
      // JSONパースエラーは無視（ボディが空の場合も含む）
      // Ignore JSON parse errors (including empty body)
    }

    // 既存の追加スコープも再認証要求に含める（user:write:chat などの消失防止）
    // Include already granted additional scopes so re-auth does not drop existing permissions.
    const supabaseAdmin = getSupabaseAdmin()
    const { data: user, error: scopeFetchError } = await supabaseAdmin
      .from('users')
      .select('twitch_scopes')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    if (scopeFetchError && scopeFetchError.code !== 'PGRST204') {
      logger.error('Re-auth scope fetch failed', {
        twitchUserId: session.twitchUserId,
        error: scopeFetchError.message,
        code: scopeFetchError.code,
      })
      return NextResponse.json(
        { error: 'Failed to prepare re-authorization. Please try again.' },
        { status: 503 }
      )
    }

    const preservedScopes = (user?.twitch_scopes ?? []).filter((scope: string) =>
      VALID_ADDITIONAL_SCOPES.includes(scope)
    )
    const additionalScopes = Array.from(new Set([...preservedScopes, ...requestedScopes]))

    // Use Web Crypto API for random bytes generation (Cloudflare Workers compatible)
    // Web Crypto APIを使用してランダムバイトを生成（Cloudflare Workers互換）
    const state = randomBytesHex(32)
    // リクエストの host ヘッダーから動的にベースURLを取得
    // Cloudflare Workers では NEXT_PUBLIC_APP_URL がビルド時にインライン化されるため
    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}${API_ROUTES.AUTH_TWITCH_CALLBACK}`

    // 追加スコープがある場合はそれを含めた認証URLを生成
    // Generate auth URL with additional scopes if provided
    const loginUrl = getTwitchAuthUrl(redirectUri, state, additionalScopes.length > 0 ? additionalScopes : undefined)

    await deleteTwitchTokens(session.twitchUserId)
    logger.info(`Deleted Twitch tokens for user: ${session.twitchUserId}`)

    logger.info('Re-auth URL generated', {
      twitchUserId: session.twitchUserId,
      hasAdditionalScopes: additionalScopes.length > 0,
      requestedScopes,
      preservedScopes,
      additionalScopes,
    })

    const response = NextResponse.json({
      success: true,
      loginUrl,
      state, // stateを返してクライアント側でCookieに保存できるようにする
    })

    // callbackで再認証フローを識別するためにstateを保存
    // Store state marker so callback can identify re-auth flow
    response.cookies.set(COOKIE_NAMES.REAUTH_STATE, state, STATE_COOKIE_OPTIONS)

    return response
  } catch (error) {
    return handleApiError(error, 'Re-auth API: POST')
  }
}
