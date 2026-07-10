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
import { validateCSRFToken } from '@/lib/csrf'
// -----------------------------------------------------------------------------
// #663 (#570/#572 パターン踏襲): pg 直結経路。
// このルート自体の DB アクセスは users.twitch_scopes の読み取りのみのため
// isPgReadEnabled() で分岐する。書き込み（deleteTwitchTokens）は共有関数のまま呼び、
// その内部で isPgWriteEnabled() により独立して経路が選ばれる（pg-read = 読み取り
// のみ pg、書き込みは PostgREST という運用モードそのもの。token-manager.ts の
// getTwitchAccessToken と同じ設計判断）。既存 supabase-js 実装は無変更で残す。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { isPgMissingColumnError } from '@/lib/db/errors'
import { users as usersTable } from '@/lib/db/schema'

// 有効な追加スコープのリスト（セキュリティ: 許可されたスコープのみ受け付ける）
// List of valid additional scopes (security: only accept allowed scopes)
const VALID_ADDITIONAL_SCOPES: string[] = Object.values(ADDITIONAL_SCOPES)

/**
 * 再認証前の既存スコープ取得の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - users.twitch_user_id は UNIQUE（migration 00001）のため最大 1 行。
 *   .maybeSingle() は LIMIT 1 + rows[0] ?? null で同じ外部挙動（0 行はエラーではなく null）。
 * - twitch_scopes は text[] 列のため必ず Drizzle スキーマ経由で読む
 *   （src/lib/db/client.ts の fetch_types: false の注意書き参照）。
 * - エラーは throw のまま呼び出し元へ伝播させ、ハンドラ側で PGRST204 相当
 *   （SQLSTATE 42703）の継続 / それ以外の 503 を既存経路と突き合わせる。
 */
async function fetchUserScopesForReauthPg(
  twitchUserId: string
): Promise<{ twitch_scopes: string[] | null } | null> {
  const rows = await withDbRetry(
    async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db
        .select({ twitch_scopes: usersTable.twitch_scopes })
        .from(usersTable)
        .where(eq(usersTable.twitch_user_id, twitchUserId))
        .limit(1)
    },
    'reauth(scope fetch)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true },
  )
  return rows[0] ?? null
}

export async function POST(request: Request) {
  try {
    // 状態変更 API のため CSRF 検証をレートリミットより先に実行する。
    // 既存トークン削除と再認証 URL 発行を伴うため GET クロスサイト誘導で発火させない。
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

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
    // #663: このルートの DB アクセスは読み取り専用のため isPgReadEnabled() で分岐。
    // フラグ未設定時（既定 'postgrest'）は else 節の既存 supabase-js 実装が従来どおり動く。
    let user: { twitch_scopes: string[] | null } | null
    if (isPgReadEnabled()) {
      try {
        user = await fetchUserScopesForReauthPg(session.twitchUserId)
      } catch (scopeFetchError) {
        // PGRST204（列がスキーマキャッシュに無い）は pg 直結では SQLSTATE 42703 に
        // 相当する。既存経路はこのコードのみ続行（error 時は data=null →
        // preservedScopes=[]）するため、同じ外部挙動に合わせて user=null で継続する。
        // それ以外の DB エラーは既存経路と同じログ + 503 応答。
        if (!isPgMissingColumnError(scopeFetchError)) {
          logger.error('Re-auth scope fetch failed', {
            twitchUserId: session.twitchUserId,
            error:
              scopeFetchError instanceof Error
                ? scopeFetchError.message
                : String(scopeFetchError),
            code: (scopeFetchError as { code?: string })?.code,
          })
          return NextResponse.json(
            { error: 'Failed to prepare re-authorization. Please try again.' },
            { status: 503 }
          )
        }
        user = null
      }
    } else {
      const supabaseAdmin = getSupabaseAdmin()
      const { data, error: scopeFetchError } = await supabaseAdmin
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
      user = data
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
