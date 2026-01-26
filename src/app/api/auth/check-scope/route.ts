import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { hasScope } from '@/lib/twitch/token-manager'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/auth'

// 有効なスコープのリスト（セキュリティ: 許可されたスコープのみ確認可能）
// List of valid scopes (security: only allow checking permitted scopes)
const VALID_SCOPES: string[] = Object.values(ADDITIONAL_SCOPES)

/**
 * スコープ確認API
 * Check if the current user has a specific Twitch scope granted
 *
 * GET /api/auth/check-scope?scope=user:write:chat
 * Response: { hasScope: boolean }
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    // authReauthと同じレート制限を使用（スコープ確認も認証関連の操作）
    // Use same rate limit as authReauth (scope check is also an auth-related operation)
    const result = await checkRateLimit(rateLimits.authReauth, identifier)

    if (!result.success) {
      return NextResponse.json({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, { status: 429 })
    }

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // クエリパラメータからスコープを取得
    // Get scope from query parameter
    const scope = request.nextUrl.searchParams.get('scope')

    if (!scope) {
      return NextResponse.json({ error: 'Missing scope parameter' }, { status: 400 })
    }

    // 許可されたスコープかどうかを確認（セキュリティ対策）
    // Verify the scope is in the allowed list (security measure)
    if (!VALID_SCOPES.includes(scope)) {
      return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
    }

    // ユーザーがそのスコープを持っているかチェック
    // Check if the user has the requested scope
    const hasScopeResult = await hasScope(session.twitchUserId, scope)

    return NextResponse.json({ hasScope: hasScopeResult })
  } catch (error) {
    return handleApiError(error, 'Check-scope API: GET')
  }
}
