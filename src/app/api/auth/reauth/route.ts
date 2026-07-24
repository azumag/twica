import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { deleteTwitchTokens } from '@/lib/twitch/token-manager'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { API_ROUTES, COOKIE_NAMES, STATE_COOKIE_OPTIONS } from '@/lib/constants'

import { logger } from '@/lib/logger.server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { randomBytesHex } from '@/lib/crypto-utils'
import { getBaseUrl } from '@/lib/url-utils'
import { validateCSRFToken } from '@/lib/csrf'
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { isPgMissingColumnError } from '@/lib/db/errors'
import { users as usersTable } from '@/lib/db/schema'

// 有効な追加スコープのリスト（セキュリティ: 許可されたスコープのみ受け付ける）
// List of valid additional scopes (security: only accept allowed scopes)
const VALID_ADDITIONAL_SCOPES: string[] = Object.values(ADDITIONAL_SCOPES)

/**
 * 既存の追加スコープ取得の pg 直結実装 (#663)
 *
 * twitch_user_id は UNIQUE（migration 00001）のため LIMIT 1 で取得する。
 * twitch_scopes 列が未配備の 42703 だけを「スコープなし」として許容し、
 * それ以外の DB エラーは呼び出し元へ返して 503 にする。
 */
async function fetchPreservedScopesPg(
  twitchUserId: string
): Promise<{ data: { twitch_scopes: string[] | null } | null; error: { code?: string; message: string } | null }> {
  try {
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
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      return { data: null, error: { code: '42703', message: 'twitch_scopes column not found' } }
    }
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
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

    // リクエストボディから追加スコープ・returnToを取得（オプション）
    // Get additional scopes and returnTo from request body (optional)
    let requestedScopes: string[] = []
    // #788 子C #791: アカウント設定からのstep-up再認証がcallback後に同じページへ
    // 戻れるよう、任意のreturnToを受け付ける。login/route.tsの既存パターン
    // （'/'始まり・'//'非始まりの同一origin相対パスのみ許可）を踏襲する。
    let returnTo: string | undefined
    try {
      const body = await request.json()
      if (body.additionalScopes && Array.isArray(body.additionalScopes)) {
        // 有効なスコープのみをフィルタリング（セキュリティ対策）
        // Filter to only valid scopes (security measure)
        requestedScopes = body.additionalScopes.filter((scope: string) =>
          VALID_ADDITIONAL_SCOPES.includes(scope)
        )
      }
      if (
        typeof body.returnTo === 'string' &&
        body.returnTo.startsWith('/') &&
        !body.returnTo.startsWith('//')
      ) {
        returnTo = body.returnTo
      }
    } catch {
      // JSONパースエラーは無視（ボディが空の場合も含む）
      // Ignore JSON parse errors (including empty body)
    }

    // 既存の追加スコープも再認証要求に含める（user:write:chat などの消失防止）
    // Include already granted additional scopes so re-auth does not drop existing permissions.
    // #663: 読み取り専用のため PlanetScale の単一接続を使用。
    const { data: user, error: scopeFetchError } = await fetchPreservedScopesPg(session.twitchUserId)

    // 42703 は twitch_scopes 列未配備のデプロイ窓だけを表す。その他の失敗は
    // 認可スコープを黙って落とさず、再認証準備失敗として返す。
    if (scopeFetchError && scopeFetchError.code !== '42703') {
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

    // #788 子C #791: returnToが指定されていればcallback後の戻り先としてserver-side設定する
    // （clientがdocument.cookieを直接書く方式は取らない）
    if (returnTo) {
      response.cookies.set(COOKIE_NAMES.RETURN_TO, returnTo, STATE_COOKIE_OPTIONS)
    }

    return response
  } catch (error) {
    return handleApiError(error, 'Re-auth API: POST')
  }
}
