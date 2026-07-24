
import { getSession } from '@/lib/session'
import { type NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { userCards as userCardsTable, users as usersTable } from '@/lib/db/schema'

interface UserCardsDriverError {
  message: string
}

/**
 * users 取得の pg 直結実装 (#663)
 * （migration 00001）により最大 1 行のため LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。
 */
async function fetchUserPg(
  twitchUserId: string
): Promise<{ data: { id: string; twitch_user_id: string } | null; error: UserCardsDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: usersTable.id, twitch_user_id: usersTable.twitch_user_id })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'user-cards(fetch user)',
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * user_cards 取得の pg 直結実装 (#663)
 * 回避という既存意図をそのまま引き継ぐ。
 */
async function fetchUserCardsPg(
  userId: string
): Promise<{
  data: Array<{ id: string; user_id: string; card_id: string; obtained_at: string | null }> | null
  error: UserCardsDriverError | null
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: userCardsTable.id,
            user_id: userCardsTable.user_id,
            card_id: userCardsTable.card_id,
            obtained_at: userCardsTable.obtained_at,
          })
          .from(userCardsTable)
          .where(eq(userCardsTable.user_id, userId))
          .limit(10000)
      },
      'user-cards(fetch cards)',
      { idempotent: true },
    )
    return { data: rows, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier)

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      )
    }

    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    // Get user data
    // ユーザーデータを取得
    // #663: 読み取り専用のため PlanetScale の単一接続を使用。
    const { data: userData, error: userError } = await fetchUserPg(session.twitchUserId)

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get user's cards with details
    // ユーザーのカード詳細を取得
    const { data: userCards, error: cardsError } = await fetchUserCardsPg(userData.id)

    if (cardsError) {
      return handleDatabaseError(cardsError, "Failed to fetch user cards")
    }

    return NextResponse.json(userCards || [])

  } catch (error) {
    return handleApiError(error, "User Cards API")
  }
}
