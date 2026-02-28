import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { hasScope, validateTokenScopes } from '@/lib/twitch/token-manager'
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
    // スコープ確認は読み取り専用の低リスク操作なので、authReauthより緩い専用の制限を使用
    // authReauthと共有するとページロード時のcheckScopeだけでreauth用の枠を消費してしまうため
    // Use dedicated rate limit for scope checking (read-only, low-risk)
    // Sharing with authReauth would exhaust reauth quota just from page load scope checks
    const result = await checkRateLimit(rateLimits.authCheckScope, identifier)

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

    // DBにスコープがある場合、トークンの実スコープも検証する
    // DB/トークン乖離（別端末ログイン等）を検出し、UIに正しい状態を返す
    // ⚠️ GETはread-only: DB更新はせず、レスポンスで乖離を通知するのみ
    // When DB says scope exists, also verify against actual token scopes.
    // Detects DB/token divergence (e.g., login from another device).
    // GET is read-only: no DB mutation, only notifies divergence via response.
    if (hasScopeResult) {
      const tokenScopes = await validateTokenScopes(session.twitchUserId)
      if (tokenScopes !== null && !tokenScopes.includes(scope)) {
        // トークンにスコープがない → 乖離検出
        // DB更新はせず（GETでの状態変更回避）、needsReauthフラグで通知
        // Token lacks scope → divergence detected. No DB mutation (GET is read-only).
        return NextResponse.json({ hasScope: false, needsReauth: true })
      }
      // tokenScopes === null: ネットワーク障害等 → DB結果を信頼
      // tokenScopes === null: network failure etc. → trust DB result
    }

    return NextResponse.json({ hasScope: hasScopeResult })
  } catch (error) {
    return handleApiError(error, 'Check-scope API: GET')
  }
}
