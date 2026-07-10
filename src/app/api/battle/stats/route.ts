import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import type { UserCardWithDetails, BattleResult } from '@/types/database'
import { ERROR_MESSAGES, CPU_CARD_STRINGS } from '@/lib/constants'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。読み取り専用の GET ハンドラのため
// isPgReadEnabled() で分岐する。フラグ未設定時(既定 'postgrest')はこれらの
// モジュールの実行パスに一切入らないため、import が存在するだけでは挙動に
// 影響しない(tests/setup.ts の getDb throw スタブが「postgrest 経路で getDb が
// 呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { desc, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  battles as battlesTable,
  battleStats as battleStatsTable,
  cards as cardsTable,
  streamers as streamersTable,
  userCards as userCardsTable,
  users as usersTable,
} from '@/lib/db/schema'
// user_card:user_cards(card:cards(streamer:streamers(...))) 埋め込みの再構成ロジックは
// battle/stats・battle/[battleId] で完全に同一のため共有モジュールへ切り出した
// (#663 コードレビュー指摘: 3ファイルにほぼ同一のロジックが独立実装されていた)。
// 詳細・null 判定根拠は同モジュールの doc コメント参照。
import { USER_CARD_EMBED_COLUMNS, toUserCardEmbed } from '@/lib/db/battle-card-embed'

// battles から cards へは opponent_card_id 経由の参照もあるため、user_card 側の
// cards(user_cards.card_id 経由、USER_CARD_EMBED_COLUMNS 内)と区別する self-join 用エイリアス
const opponentCardsAlias = alias(cardsTable, 'opponent_cards')

/**
 * pg 直結経路の created_at (PG テキスト形式の文字列) を安全に ISO 8601 へ
 * 正規化する。パース不能な値が来た場合に `new Date(...).toISOString()` が
 * 投げる RangeError で API 全体が 500 落ちしないようにするガード。
 *
 * ロジックは src/lib/support-inquiries.ts の normalizePgTimestamp と同一
 * (Date.parse → NaN なら元の文字列をそのまま返す・NaN でなければ toISOString)。
 *
 * 判断: normalizePgTimestamp を import せずこの関数をコピーして持つ。
 * support-inquiries.ts は問い合わせ機能専用のデータアクセス層であり、
 * 無関係な battle ドメインの route からそこへ依存を張ると、ドメイン間の
 * 依存方向が不自然になる（同ファイルが今後変更されるたびに battle 側への
 * 影響を気にする必要が生じる）。関数自体は数行の汎用ロジックで再利用のための
 * 共有 lib への切り出しコストに見合う重複度でもないため、YAGNI に倣い
 * インライン複製で十分と判断した。
 */
function normalizePgTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString()
}

/**
 * battle_stats の行(既存応答が参照する列)。DDL(migration 00002)に NOT NULL が
 * 無く DEFAULT のみの列は number | null(実運用では AFTER INSERT トリガー
 * update_battle_stats が常に値を入れるため null はほぼ発生しないが、DDL を正と
 * する。PostgREST 経路も同じ生値を返すため両経路で同一)。
 */
interface BattleStatsRowShape {
  id: string
  total_battles: number | null
  wins: number | null
  losses: number | null
  draws: number | null
  win_rate: number | null
  updated_at: string | null
}

/**
 * GET /api/battle/stats の pg 直結データ取得 (#663)
 *
 * PostgREST 経路の 4 クエリ(users / battle_stats / battles(直近10件) /
 * battles(全件のカード別集計用))と同一の意味論で取得し、後続の整形ロジック
 * (battleHistory / cardPerformanceMap 構築)を両経路で完全に共有できるよう、
 * PostgREST の実行時形状(埋め込みはオブジェクト)へ再構成して返す。
 *
 * PostgREST 実装との対応:
 * - users / battle_stats の .maybeSingle(): users.twitch_user_id は UNIQUE(00001)、
 *   battle_stats.user_id は UNIQUE(00002)のため、LIMIT 1 + rows[0] ?? null が
 *   同じ外部挙動。エラー時はそれぞれ既存実装と同じ handleDatabaseError の
 *   コンテキスト文字列で 500 を返す。
 * - recentBattles: order('created_at', descending) + limit(10) は
 *   orderBy(desc(created_at)) + limit(10) が等価(PostgREST の desc も PostgreSQL
 *   既定の NULLS FIRST であり並びも一致)。
 * - cardStats: 既存クエリは limit 指定なし = PostgREST サーバの max-rows 既定
 *   (このリポジトリでは 1000 件。user-cards route の既存コメント
 *   「PostgRESTデフォルト1000件制限」参照)で打ち切られるため、LIMIT 1000 を
 *   明示して同じ上限に揃える。並び順はどちらの経路も未指定(順序不定)で同一の性質。
 * - created_at の正規化: pg 直結は PG テキスト形式('2026-03-10 12:00:00.123456+00')
 *   を返すが、この値は battleHistory.createdAt として API 応答に含まれ、消費側
 *   (src/app/battle/stats/page.tsx:269)がブラウザ上で new Date(createdAt) により
 *   パースして表示する。V8 以外のエンジン(Safari 等)ではスペース区切り +
 *   マイクロ秒 + '+00' オフセットのパースが保証されないため、overlay events route
 *   の方式に従いサーバ側で normalizePgTimestamp() により ISO 8601 に正規化して
 *   返す(PostgREST の ISO 8601 とはミリ秒精度・'Z' 終端の差があるが、どちらも全
 *   ブラウザで確実にパース可能な ISO 8601 であり同一時刻に解釈される)。
 *   万一 Date.parse できない想定外の値が来た場合は RangeError で API を
 *   500 落ちさせず、元の文字列をそのまま返す安全側に倒す(normalizePgTimestamp
 *   のコメント・src/lib/support-inquiries.ts の同名関数 参照)。
 *
 * 読み取り専用クエリのため、いずれも冪等(idempotent: true)としてリトライを
 * opt-in する。
 */
async function getBattleStatsDataPg(twitchUserId: string): Promise<
  | NextResponse
  | {
      battleStats: BattleStatsRowShape | null
      recentBattles: Record<string, unknown>[]
      cardStats: Record<string, unknown>[]
    }
> {
  let userData: { id: string; twitch_user_id: string } | null
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
        const { db } = await getDb()
        return db
          .select({ id: usersTable.id, twitch_user_id: usersTable.twitch_user_id })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'battleStats(users)',
      { idempotent: true },
    )
    userData = rows[0] ?? null
  } catch (error) {
    return handleDatabaseError(error, 'Failed to fetch user data')
  }
  if (!userData) {
    return handleDatabaseError(new Error('User not found'), 'Failed to fetch user data')
  }
  // withDbRetry の queryFn(closure)から参照するため const に固定する
  const userId = userData.id

  // battle_stats / recentBattles(直近10件) / cardStats(全対戦) の3クエリは、
  // userId さえ分かれば互いに独立した読み取り専用クエリ(idempotent: true)のため
  // Promise.all で並列実行する(#663 コードレビュー指摘)。
  //
  // 各クエリは自分のエラーを内部で捕捉して { error: NextResponse } として返し、
  // 成功時のみ { value } を返す(reject させて Promise.all 全体を reject させない)。
  // これにより、並列実行後のエラーチェックを元の逐次実行と同じ優先順位
  // (battleStats → recentBattles → cardStats)で行える。逐次実行時は先に失敗した
  // クエリのコンテキストで即座に 500 を返し後続クエリは実行されなかったが、並列化
  // すると複数クエリが同時に失敗しうるため、この優先順位チェックによって「最初に
  // 失敗するはずだったクエリのエラーメッセージ」を外部挙動として維持する。
  const [battleStatsOutcome, recentBattlesOutcome, cardStatsOutcome] = await Promise.all([
    (async (): Promise<{ value: BattleStatsRowShape | null } | { error: NextResponse }> => {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .select({
                id: battleStatsTable.id,
                total_battles: battleStatsTable.total_battles,
                wins: battleStatsTable.wins,
                losses: battleStatsTable.losses,
                draws: battleStatsTable.draws,
                win_rate: battleStatsTable.win_rate,
                updated_at: battleStatsTable.updated_at,
              })
              .from(battleStatsTable)
              .where(eq(battleStatsTable.user_id, userId))
              .limit(1)
          },
          'battleStats(battle_stats)',
          { idempotent: true },
        )
        return { value: rows[0] ?? null }
      } catch (error) {
        return { error: await handleDatabaseError(error, 'Failed to fetch battle stats') }
      }
    })(),
    (async (): Promise<{ value: Record<string, unknown>[] } | { error: NextResponse }> => {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .select({
                id: battlesTable.id,
                result: battlesTable.result,
                turn_count: battlesTable.turn_count,
                battle_log: battlesTable.battle_log,
                created_at: battlesTable.created_at,
                ...USER_CARD_EMBED_COLUMNS,
                opp_id: opponentCardsAlias.id,
                opp_name: opponentCardsAlias.name,
              })
              .from(battlesTable)
              .leftJoin(userCardsTable, eq(battlesTable.user_card_id, userCardsTable.id))
              .leftJoin(cardsTable, eq(userCardsTable.card_id, cardsTable.id))
              .leftJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
              .leftJoin(opponentCardsAlias, eq(battlesTable.opponent_card_id, opponentCardsAlias.id))
              .where(eq(battlesTable.user_id, userId))
              .orderBy(desc(battlesTable.created_at))
              .limit(10)
          },
          'battleStats(recent battles)',
          { idempotent: true },
        )
        return {
          value: rows.map((row) => ({
            id: row.id,
            result: row.result,
            turn_count: row.turn_count,
            battle_log: row.battle_log,
            // ブラウザ消費のため ISO 8601 へ正規化(上の doc コメント参照)。
            // created_at の DDL は DEFAULT now()(NOT NULL なし)のため null を許容する
            // (null の場合は PostgREST 経路も null をそのまま返すので変換しない)。
            // 変換自体は normalizePgTimestamp が NaN ガード付きで行う(想定外の
            // パース不能値でも RangeError を投げず元の文字列を返す安全側)。
            created_at: row.created_at === null ? null : normalizePgTimestamp(row.created_at),
            // 多対一の埋め込みは PostgREST の実行時形状どおり「オブジェクトまたは null」
            user_card: toUserCardEmbed(row),
            opponent_card: row.opp_id === null ? null : { id: row.opp_id, name: row.opp_name },
          })),
        }
      } catch (error) {
        return { error: await handleDatabaseError(error, 'Failed to fetch recent battles') }
      }
    })(),
    (async (): Promise<{ value: Record<string, unknown>[] } | { error: NextResponse }> => {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .select({
                result: battlesTable.result,
                ...USER_CARD_EMBED_COLUMNS,
              })
              .from(battlesTable)
              .leftJoin(userCardsTable, eq(battlesTable.user_card_id, userCardsTable.id))
              .leftJoin(cardsTable, eq(userCardsTable.card_id, cardsTable.id))
              .leftJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
              .where(eq(battlesTable.user_id, userId))
              // PostgREST サーバ max-rows 既定(1000件)との揃え(上の doc コメント参照)
              .limit(1000)
          },
          'battleStats(card stats)',
          { idempotent: true },
        )
        return {
          value: rows.map((row) => ({
            result: row.result,
            user_card: toUserCardEmbed(row),
          })),
        }
      } catch (error) {
        return { error: await handleDatabaseError(error, 'Failed to fetch card stats') }
      }
    })(),
  ])

  // 元の逐次実行と同じ優先順位でエラーをチェックする(コメント参照)
  if ('error' in battleStatsOutcome) {
    return battleStatsOutcome.error
  }
  if ('error' in recentBattlesOutcome) {
    return recentBattlesOutcome.error
  }
  if ('error' in cardStatsOutcome) {
    return cardStatsOutcome.error
  }

  return {
    battleStats: battleStatsOutcome.value,
    recentBattles: recentBattlesOutcome.value,
    cardStats: cardStatsOutcome.value,
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()

    // Common select pattern for user_card with card details
    const USER_CARD_SELECT = `
      user_id,
      card_id,
      obtained_at,
      card:cards(
        id,
        name,
        hp,
        atk,
        def,
        spd,
        skill_type,
        skill_name,
        skill_power,
        image_url,
        rarity,
        streamer:streamers(
          twitch_user_id
        )
      )
    `

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleStats, identifier)

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

    // #663: DB アクセス部分のみをフラグで分岐する(overlay events route と同じ構成)。
    // フラグ未設定(既定 'postgrest')時は else 節の既存 supabase-js 実装がそのまま
    // 実行され、挙動は完全に不変(クエリ部分は再インデント + 取得結果を共有変数へ
    // 渡すための変数名変更のみ)。3 データセットへ集約後の整形処理(battleHistory /
    // cardPerformanceMap 構築)は両経路で完全に共有する(下記、無変更)。
    let battleStats: BattleStatsRowShape | null
    let recentBattles: Record<string, unknown>[] | null
    let cardStats: Record<string, unknown>[] | null

    if (isPgReadEnabled()) {
      const pgResult = await getBattleStatsDataPg(session.twitchUserId)
      if (pgResult instanceof NextResponse) {
        return pgResult
      }
      ;({ battleStats, recentBattles, cardStats } = pgResult)
    } else {
      const supabaseAdmin = getSupabaseAdmin()

      // Get user data
      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, twitch_user_id')
        .eq('twitch_user_id', session.twitchUserId)
        .maybeSingle()

      if (userError || !userData) {
        return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
      }

      // Get user's battle stats
      const { data: battleStatsData, error: statsError } = await supabaseAdmin
        .from('battle_stats')
        .select('id, total_battles, wins, losses, draws, win_rate, updated_at')
        .eq('user_id', userData.id)
        .maybeSingle()

      // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
      if (statsError) {
        return handleDatabaseError(statsError, "Failed to fetch battle stats")
      }

      // Get recent battles with all card details (including opponent card)
      const { data: recentBattlesData, error: battlesError } = await supabaseAdmin
        .from('battles')
        .select(`
          id,
          result,
          turn_count,
          battle_log,
          created_at,
          user_card:user_cards(
            ${USER_CARD_SELECT}
          ),
          opponent_card:cards(
            id,
            name
          )
        `)
        .eq('user_id', userData.id)
        .order('created_at', { ascending: false })
        .limit(10)

      if (battlesError) {
        return handleDatabaseError(battlesError, "Failed to fetch recent battles")
      }

      // Get card-specific statistics
      const { data: cardStatsData, error: cardStatsError } = await supabaseAdmin
        .from('battles')
        .select(`
          result,
          user_card:user_cards(
            ${USER_CARD_SELECT}
          )
        `)
        .eq('user_id', userData.id)

      if (cardStatsError) {
        return handleDatabaseError(cardStatsError, "Failed to fetch card stats")
      }

      battleStats = battleStatsData
      recentBattles = recentBattlesData as unknown as Record<string, unknown>[] | null
      cardStats = cardStatsData as unknown as Record<string, unknown>[] | null
    }

    // Process battles without additional queries
    const battleHistory = (recentBattles || []).map((battle: Record<string, unknown>) => {
      const battleId = battle.id as string
      const result = battle.result as BattleResult
      const turnCount = battle.turn_count as number
      const createdAt = battle.created_at as string
      const userCard = battle.user_card
      const opponentCard = battle.opponent_card as { name: string } | null

      if (!userCard || typeof userCard !== 'object') {
        return {
          battleId,
          result,
          opponentCardName: opponentCard ? `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}` : CPU_CARD_STRINGS.DEFAULT_NAME,
          turnCount,
          createdAt,
          userCardName: 'Unknown Card'
        }
      }

      const userCardRecord = userCard as Record<string, unknown>
      const userCardData = userCardRecord?.card as { name: string } | null | undefined

      return {
        battleId,
        result,
        opponentCardName: opponentCard ? `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}` : CPU_CARD_STRINGS.DEFAULT_NAME,
        turnCount,
        createdAt,
        userCardName: userCardData?.name || 'Unknown Card'
      }
    })

    // Aggregate card statistics
    const cardPerformanceMap = new Map()
    for (const battle of cardStats || []) {
      const battleData = battle as Record<string, unknown>
      const userCard = battleData.user_card

      if (!userCard || typeof userCard !== 'object') continue

      const userCardRecord = userCard as Record<string, unknown>
      const userCardData = userCardRecord.card as UserCardWithDetails['card'] | null

      if (!userCardData) continue

      const cardId = userCardData.id
      const cardName = userCardData.name
      const cardImage = userCardData.image_url
      const cardRarity = userCardData.rarity

      if (!cardPerformanceMap.has(cardId)) {
        cardPerformanceMap.set(cardId, {
          cardId,
          cardName,
          cardImage,
          cardRarity,
          totalBattles: 0,
          wins: 0,
          losses: 0,
          draws: 0
        })
      }

      const stats = cardPerformanceMap.get(cardId)
      stats.totalBattles++

      if (battleData.result === 'win') stats.wins++
      else if (battleData.result === 'lose') stats.losses++
      else if (battleData.result === 'draw') stats.draws++
    }

    // Convert to array and calculate win rates
    const cardStatsArray = Array.from(cardPerformanceMap.values())
      .map(card => ({
        ...card,
        winRate: card.totalBattles > 0 ? (card.wins / card.totalBattles) * 100 : 0
      }))
      .sort((a, b) => b.winRate - a.winRate) // Sort by win rate descending

    // Return default stats if none exist
    const defaultStats = {
      total_battles: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      win_rate: 0
    }

    const stats = battleStats || defaultStats

    return NextResponse.json({
      totalBattles: stats.total_battles,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      winRate: stats.win_rate,
      recentBattles: battleHistory,
      cardStats: cardStatsArray
    })

  } catch (error) {
    return handleApiError(error, "Battle Stats API")
  }
}
