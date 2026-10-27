import { type NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger.server'
import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'
import { getSqlState } from '@/lib/db/errors'
import { isCanonicalUuid } from '@/lib/uuid-validation'
import { userCollectionHiddenStreamers as hiddenStreamersTable } from '@/lib/db/schema'
import type { ApiRateLimitResponse } from '@/types/api'

/**
 * POST /api/collection/hidden-streamers (#1953)
 *
 * マイコレクション一覧(/dashboard/collection)で、配信者のコレクションを
 * 非表示にする / 再表示する。
 *
 * body: { streamerId: string(UUID), hidden: boolean }
 *   - hidden: true  → INSERT ... ON CONFLICT DO NOTHING
 *   - hidden: false → DELETE
 * どちらも冪等。連打・別タブでの二重操作・リトライで同じリクエストが重複しても
 * 最終状態は同じで、エラーにもならない(announcements/read と同じ方針)。
 * 非表示は「一覧の見せ方」だけの設定で、カード所持・直リンク・統計には影響しない。
 *
 * 処理順は announcements/read と同じ: CSRF検証 → セッション → レートリミット →
 * 入力検証。未認証・不正オリジンのリクエストでレート制限の枠や DB を消費しない。
 */
export async function POST(request: NextRequest) {
  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // レートリミット（認証後にユーザーID単位で制限）
    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimit = await checkRateLimit(rateLimits.collectionHiddenStreamers, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)),
          },
        }
      )
    }

    // 不正な JSON は例外ではなく 400 にする（500 でエラーログを汚さない）
    const body: unknown = await request.json().catch(() => null)
    const { streamerId, hidden } = (body && typeof body === 'object' ? body : {}) as {
      streamerId?: unknown
      hidden?: unknown
    }

    // streamerId は UUID 形式のみ、hidden は真偽値のみ受け付ける。
    // "false" のような文字列を truthy として扱う取り違えを避けるため boolean 厳密一致。
    if (typeof streamerId !== 'string' || !isCanonicalUuid(streamerId) || typeof hidden !== 'boolean') {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 })
    }

    try {
      await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          if (hidden) {
            // 既に非表示なら何もしない。hidden_at は INSERT 時の DEFAULT now() のみで、
            // 重複操作で「非表示にした日時」が書き換わることもない。
            return db
              .insert(hiddenStreamersTable)
              .values({ twitch_user_id: session.twitchUserId, streamer_id: streamerId })
              .onConflictDoNothing({
                target: [hiddenStreamersTable.twitch_user_id, hiddenStreamersTable.streamer_id],
              })
          }
          // 非表示でない配信者への再表示は 0 行削除で成功する（冪等）。
          // 条件は必ず twitch_user_id とセットにし、他の視聴者の設定には触れない。
          return db
            .delete(hiddenStreamersTable)
            .where(
              and(
                eq(hiddenStreamersTable.twitch_user_id, session.twitchUserId),
                eq(hiddenStreamersTable.streamer_id, streamerId)
              )
            )
        },
        'collection/hidden-streamers',
        // 固定値の INSERT ON CONFLICT DO NOTHING / DELETE なので、接続断リトライで
        // 二重に実行されても結果は変わらない。
        { idempotent: true }
      )
    } catch (error) {
      // 23503 foreign_key_violation: 存在しない streamer_id（FK → streamers）。
      // クライアントの入力不正なので 500 ではなく 400 にする。
      if (getSqlState(error) === '23503') {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 })
      }
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('Error in collection hidden-streamers API', { error })
    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
  }
}
