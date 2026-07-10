import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。読み取り専用の GET ハンドラのため
// isPgReadEnabled() で分岐する。フラグ未設定時(既定 'postgrest')はこれらの
// モジュールの実行パスに一切入らないため、import が存在するだけでは挙動に
// 影響しない(tests/setup.ts の getDb throw スタブが「postgrest 経路で getDb が
// 呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { userCards as userCardsTable, users as usersTable } from '@/lib/db/schema'

/**
 * GET /api/user-cards の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - users の .maybeSingle() は twitch_user_id の UNIQUE 制約(migration 00001)に
 *   より最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 *   取得失敗(throw)・0 行(User not found)とも既存実装と同じ
 *   handleDatabaseError(..., 'Failed to fetch user data')(500)へ落とす。
 * - user_cards の .range(0, 9999) は「Range: 0-9999」(先頭 10000 件)の要求で、
 *   LIMIT 10000 が対応する。既存コードのコメントどおり PostgREST デフォルトの
 *   1000 件制限を回避する意図の値。※PostgREST 経路の実返却上限はサーバ側
 *   max-rows 設定にも依存する(既定 1000 のままなら range 指定でも 1000 件で
 *   打ち切られる)が、pg 経路はコード上の要求値である 10000 を上限とする
 *   (既存コードの意図に合わせる。1000 件超のカード所持は現実的にほぼ発生しない)。
 * - 応答は取得行(snake_case キー)をそのまま JSON で返す。obtained_at の既知の
 *   表現差: pg 直結は PG テキスト形式('2026-03-10 12:00:00.123456+00')、
 *   PostgREST は ISO 8601 を返す。この API の唯一の消費側
 *   (src/app/battle/page.tsx の loadData)は obtained_at を一切参照しない
 *   (カード選択 UI は id と card 情報のみ使用)ため、生文字列のまま返す
 *   (dashboard-data.ts:76-79 と同じ方針。文字列を直接表示・パースする消費側を
 *   追加する場合は overlay events route の正規化方式に従うこと)。
 *
 * 読み取り専用クエリのため、いずれも冪等(idempotent: true)としてリトライを
 * opt-in する。
 */
async function getUserCardsPg(twitchUserId: string): Promise<NextResponse> {
  let userData: { id: string; twitch_user_id: string } | null
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照)
        const { db } = await getDb()
        return db
          .select({ id: usersTable.id, twitch_user_id: usersTable.twitch_user_id })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'userCards(users)',
      { idempotent: true },
    )
    userData = rows[0] ?? null
  } catch (error) {
    // 既存実装: userError → handleDatabaseError(userError, 'Failed to fetch user data')
    return handleDatabaseError(error, 'Failed to fetch user data')
  }

  if (!userData) {
    // 既存実装: !userData → handleDatabaseError(new Error('User not found'), ...)
    return handleDatabaseError(new Error('User not found'), 'Failed to fetch user data')
  }
  // withDbRetry の queryFn(closure)から参照するため const に固定する
  const userId = userData.id

  try {
    const userCards = await withDbRetry(
      async () => {
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
          // .range(0, 9999) 対応(上の doc コメント参照)
          .limit(10000)
      },
      'userCards(user_cards)',
      { idempotent: true },
    )
    // 既存実装の `userCards || []` に対応(Drizzle は常に配列を返すためそのまま)
    return NextResponse.json(userCards)
  } catch (error) {
    return handleDatabaseError(error, 'Failed to fetch user cards')
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

    // #663: DB_DRIVER=pg-read/pg のときのみ pg 直結経路へ切り替える。
    // フラグ未設定時(既定 'postgrest')はこの分岐を素通りし、以下の既存
    // supabase-js 実装が従来と完全に同一に実行される(挙動不変が最重要安全要件)。
    if (isPgReadEnabled()) {
      return await getUserCardsPg(session.twitchUserId)
    }

    const supabaseAdmin = getSupabaseAdmin()

    // Get user data
    // ユーザーデータを取得
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, twitch_user_id')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get user's cards with details
    // ユーザーのカード詳細を取得
    // .range(0, 9999) でPostgRESTデフォルト1000件制限を回避
    const { data: userCards, error: cardsError } = await supabaseAdmin
      .from('user_cards')
      .select('id, user_id, card_id, obtained_at')
      .eq('user_id', userData.id)
      .range(0, 9999)

    if (cardsError) {
      return handleDatabaseError(cardsError, "Failed to fetch user cards")
    }

    return NextResponse.json(userCards || [])

  } catch (error) {
    return handleApiError(error, "User Cards API")
  }
}
