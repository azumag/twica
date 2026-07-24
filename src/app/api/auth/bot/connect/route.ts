import { type NextRequest, NextResponse } from 'next/server';

import { getSession, canUseStreamerFeatures } from '@/lib/session'

import { getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { API_ROUTES, COOKIE_NAMES, ERROR_MESSAGES, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { validateCSRFToken } from '@/lib/csrf'
import { randomBytesHex } from '@/lib/crypto-utils'
import { getBaseUrl } from '@/lib/url-utils'
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { streamers as streamersTable } from '@/lib/db/schema'

/**
 * streamer 存在確認の pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約
 * （migration 00001）により最大 1 行のため、LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。既存コードは error を確認しない（data のみ利用）ため、pg 版も
 * エラー時は null（配信者なし = 403）に落として throw しない。
 */
async function fetchStreamerIdPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'bot/connect(streamer)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return rows[0] ?? null
  } catch {
    // 既存 postgrest 経路は error を確認しない（data のみ利用）ため、pg 版も
    // 取得失敗時は null（=配信者なし扱い）に揃える。
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

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const streamer = await fetchStreamerIdPg(session.twitchUserId)

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
