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
// -----------------------------------------------------------------------------
// #663 (#570/#572 パターン踏襲): pg 直結経路。
// このルートの DB アクセスは streamers の存在チェック（読み取り）のみのため
// isPgReadEnabled() で分岐する。既存 supabase-js 実装は無変更で残し（else 節への
// 再インデントのみ）、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { streamers as streamersTable } from '@/lib/db/schema'

/**
 * BOT 連携開始前の配信者存在チェックの pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - streamers.twitch_user_id は UNIQUE（migration 00001）のため最大 1 行。
 *   .maybeSingle() は LIMIT 1 + rows[0] ?? null で同じ外部挙動（0 行はエラーではなく null）。
 * - 既存実装は分割代入で error を受け取らず data の有無だけを見る（DB エラー時も
 *   data=null → 403）。pg 直結ではエラーが throw になるため catch で null に落とし、
 *   「DB エラー時も 403」という同じ外部挙動（ログなし）に合わせる
 *   （token-manager.ts の getCustomBotAccountDisplayForStreamerPg と同じ判断）。
 */
async function findStreamerForBotConnectPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'botConnect(streamer)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return rows[0] ?? null
  } catch {
    // 既存経路は error を受け取らず data=null → 403 になる。同じ外部挙動に合わせる。
    return null
  }
}

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

    // #663: 読み取り専用（streamers の存在チェックのみ）のため isPgReadEnabled() で
    // 分岐。フラグ未設定時（既定 'postgrest'）は else 節の既存 supabase-js 実装が
    // 従来どおり実行される（挙動不変が最重要安全要件）。
    let streamer: { id: string } | null
    if (isPgReadEnabled()) {
      streamer = await findStreamerForBotConnectPg(session.twitchUserId)
    } else {
      const supabaseAdmin = getSupabaseAdmin()
      const { data } = await supabaseAdmin
        .from('streamers')
        .select('id')
        .eq('twitch_user_id', session.twitchUserId)
        .maybeSingle()
      streamer = data
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

    const state = randomBytesHex(32)
    const baseUrl = getBaseUrl(request)
    const redirectUri = `${baseUrl}${API_ROUTES.AUTH_TWITCH_CALLBACK}`
    const loginUrl = getTwitchAuthUrl(redirectUri, state, [ADDITIONAL_SCOPES.CHAT_WRITE])

    const response = NextResponse.json({ success: true, loginUrl })
    response.cookies.set(COOKIE_NAMES.BOT_AUTH_STATE, state, STATE_COOKIE_OPTIONS)
    return response
  } catch (error) {
    return handleApiError(error, 'BOT Auth Connect API: POST')
  }
}
