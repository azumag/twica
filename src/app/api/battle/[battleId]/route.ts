import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { ERROR_MESSAGES, CPU_CARD_STRINGS } from '@/lib/constants'
import type {
  BattleLog,
  BattleCard,
  Card,
  UserCardWithDetails,
  CardWithStreamer
} from '@/types/database'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。読み取り専用の GET ハンドラのため
// isPgReadEnabled() で分岐する。フラグ未設定時(既定 'postgrest')はこれらの
// モジュールの実行パスに一切入らないため、import が存在するだけでは挙動に
// 影響しない(tests/setup.ts の getDb throw スタブが「postgrest 経路で getDb が
// 呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  battles as battlesTable,
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

// Interface for the battle query result from Supabase
interface BattleQueryResult {
  id: string
  result: 'win' | 'lose' | 'draw'
  turn_count: number
  battle_log: unknown
  user_card: {
    user_id: string
    card_id: string
    obtained_at: string
    card: CardWithStreamer
  }[]
  opponent_card: CardWithStreamer[]
}

// Type guard for validating card data
function isValidCard(card: unknown): card is Card {
  if (!card || typeof card !== 'object') return false
  const c = card as Card
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.hp === 'number' &&
    typeof c.atk === 'number' &&
    typeof c.def === 'number' &&
    typeof c.spd === 'number' &&
    typeof c.skill_type === 'string' &&
    typeof c.skill_name === 'string' &&
    typeof c.skill_power === 'number' &&
    typeof c.rarity === 'string'
  )
}

// Type guard for validating battle log
function isValidBattleLog(log: unknown): log is BattleLog[] {
  if (!Array.isArray(log)) return false
  return log.every(item => {
    if (!item || typeof item !== 'object') return false
    const l = item as BattleLog
    return (
      typeof l.turn === 'number' &&
      (l.actor === 'user' || l.actor === 'opponent') &&
      (l.action === 'attack' || l.action === 'skill') &&
      typeof l.message === 'string'
    )
  })
}

/**
 * GET /api/battle/[battleId] の pg 直結データ取得 (#663)
 *
 * PostgREST 経路の 2 クエリ(users / battles + user_card / opponent_card 埋め込み)と
 * 同一の意味論で取得し、後続の整形ロジックを両経路で完全に共有できるよう、
 * PostgREST の「実行時」形状へ再構成して返す。
 *
 * PostgREST 実装との対応:
 * - users の .maybeSingle() は twitch_user_id の UNIQUE 制約(00001)により最大 1 行、
 *   battles の .maybeSingle() は id が PK のため最大 1 行。いずれも LIMIT 1 +
 *   rows[0] ?? null が同じ外部挙動。エラー・0 行とも既存実装と同じ
 *   handleDatabaseError のコンテキスト文字列で 500 を返す(battleId が UUID 形式で
 *   ない場合の 22P02 も、PostgREST 経路が battleError → 500 になるのと同じく
 *   catch → 500 に落ちる)。
 * - 埋め込みの実行時形状(重要な既知事項): PostgREST は多対一の埋め込み
 *   (battles.user_card_id → user_cards / battles.opponent_card_id → cards の FK に
 *   よる to-one 検出)を「オブジェクト(不一致時は null)」で返す。一方、この route の
 *   既存コードは BattleQueryResult 型でこれらを「配列」として扱っており
 *   (userCardDataRaw[0] / opponentCardRaw.length)、実行時形状と食い違っている
 *   (同じ埋め込みを使う battle/stats route はオブジェクトとして正しく扱っている)。
 *   パリティ最優先(挙動不変)の要件により、pg 経路もこの実行時形状(オブジェクト)を
 *   忠実に再構成して共有ロジックへ渡す — 型と実行時形状の食い違い自体の修正は
 *   本移行の範囲外(修正する場合は postgrest/pg 両経路の整形ロジックを同時に直す
 *   べき事項であり、別イシューで扱う)。
 * - null 判定の根拠は共有モジュール src/lib/db/battle-card-embed.ts の
 *   toUserCardEmbed と同じ(user_cards.user_id / streamers.twitch_user_id は
 *   NOT NULL、cards.id は PK のため、各列の null = leftJoin 不一致 = PostgREST の
 *   埋め込み null)。
 * - 日付列は応答に含まれない(obtained_at は形状パリティのために埋めるのみで
 *   未消費)ため、表現差の正規化は不要。
 *
 * 読み取り専用クエリのため、いずれも冪等(idempotent: true)としてリトライを
 * opt-in する。
 */
async function getBattleQueryResultPg(
  twitchUserId: string,
  battleId: string
): Promise<NextResponse | Record<string, unknown>> {
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
      'battleGet(users)',
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
            // user_card 埋め込み(user_cards + card:cards + streamer:streamers)。
            // 列セットは battle/stats route と完全に同一のため共有モジュールの
            // USER_CARD_EMBED_COLUMNS を使う(#663)。
            ...USER_CARD_EMBED_COLUMNS,
            // opponent_card 埋め込み(battles.opponent_card_id → cards)
            opp_id: opponentCardsAlias.id,
            opp_name: opponentCardsAlias.name,
            opp_hp: opponentCardsAlias.hp,
            opp_atk: opponentCardsAlias.atk,
            opp_def: opponentCardsAlias.def,
            opp_spd: opponentCardsAlias.spd,
            opp_skill_type: opponentCardsAlias.skill_type,
            opp_skill_name: opponentCardsAlias.skill_name,
            opp_skill_power: opponentCardsAlias.skill_power,
            opp_image_url: opponentCardsAlias.image_url,
            opp_rarity: opponentCardsAlias.rarity,
          })
          .from(battlesTable)
          .leftJoin(userCardsTable, eq(battlesTable.user_card_id, userCardsTable.id))
          .leftJoin(cardsTable, eq(userCardsTable.card_id, cardsTable.id))
          .leftJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .leftJoin(opponentCardsAlias, eq(battlesTable.opponent_card_id, opponentCardsAlias.id))
          .where(and(eq(battlesTable.id, battleId), eq(battlesTable.user_id, userId)))
          .limit(1)
      },
      'battleGet(battles)',
      { idempotent: true },
    )
    const row = rows[0] ?? null
    if (!row) {
      return handleDatabaseError(new Error('Battle not found'), 'Failed to fetch battle data')
    }

    // PostgREST の実行時形状(多対一の埋め込みはオブジェクトまたは null)へ再構成。
    // user_card 側は battle/stats route と同一ロジックのため共有モジュールの
    // toUserCardEmbed を使う(#663)。opponent_card は列セットが異なる(streamer を
    // 含まずカード全列を持つ)ためこのファイル固有のまま(共通化の対象外)。
    return {
      id: row.id,
      result: row.result,
      turn_count: row.turn_count,
      battle_log: row.battle_log,
      user_card: toUserCardEmbed(row),
      opponent_card:
        row.opp_id === null
          ? null
          : {
              id: row.opp_id,
              name: row.opp_name,
              hp: row.opp_hp,
              atk: row.opp_atk,
              def: row.opp_def,
              spd: row.opp_spd,
              skill_type: row.opp_skill_type,
              skill_name: row.opp_skill_name,
              skill_power: row.opp_skill_power,
              image_url: row.opp_image_url,
              rarity: row.opp_rarity,
            },
    }
  } catch (error) {
    return handleDatabaseError(error, 'Failed to fetch battle data')
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ battleId: string }> }
) {
  try {
    const session = await getSession()

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleGet, identifier)

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
    // 渡すための代入行追加のみ)。取得結果へ集約後の整形処理は両経路で完全に共有する
    // (下記、無変更。既存コードの配列アクセスと実行時形状(オブジェクト)の食い違いも
    // 含めてそのまま維持する — getBattleQueryResultPg の doc コメント参照)。
    let battleDataRaw: unknown

    if (isPgReadEnabled()) {
      const { battleId } = await context.params
      const pgResult = await getBattleQueryResultPg(session.twitchUserId, battleId)
      if (pgResult instanceof NextResponse) {
        return pgResult
      }
      battleDataRaw = pgResult
    } else {
      const supabaseAdmin = getSupabaseAdmin()
      const { battleId } = await context.params

      // Get user data
      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, twitch_user_id')
        .eq('twitch_user_id', session.twitchUserId)
        .maybeSingle()

      if (userError || !userData) {
        return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
      }

      // Get battle with all card details (including opponent card)
      const { data: battleData, error: battleError } = await supabaseAdmin
        .from('battles')
        .select(`
          id,
          result,
          turn_count,
          battle_log,
          user_card:user_cards(
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
          ),
          opponent_card:cards(
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
            rarity
          )
        `)
        .eq('id', battleId)
        .eq('user_id', userData.id)
        .maybeSingle()

      if (battleError || !battleData) {
        return handleDatabaseError(battleError ?? new Error('Battle not found'), "Failed to fetch battle data")
      }

      battleDataRaw = battleData
    }

    // Type the battle data using proper types
    const battle = battleDataRaw as BattleQueryResult
    const opponentCardRaw = battle.opponent_card

    // Validate opponent card
    const opponentCard = opponentCardRaw && opponentCardRaw.length > 0 && isValidCard(opponentCardRaw[0]) ? opponentCardRaw[0] : null

    // Validate and extract battle log early
    const battleLogRaw = battle.battle_log
    const logs = isValidBattleLog(battleLogRaw) ? battleLogRaw : []

    // Validate user card data with null safety
    const userCardDataRaw = battle.user_card
    if (!userCardDataRaw || typeof userCardDataRaw !== 'object') {
      return handleApiError(new Error('Invalid user card data'), "Battle Get API")
    }

    const userCardData = userCardDataRaw[0] as unknown as UserCardWithDetails
    const userCardRaw = userCardData.card
    if (!isValidCard(userCardRaw)) {
      return handleApiError(new Error('Invalid card data'), "Battle Get API")
    }

    const userCard = userCardRaw

    if (!opponentCard) {
      // If opponent card not found (might be CPU), create a default
      const cpuCard: BattleCard = {
        id: 'cpu-unknown',
        name: CPU_CARD_STRINGS.DEFAULT_NAME,
        hp: 100,
        currentHp: 0, // CPU card - no battle history
        atk: 30,
        def: 15,
        spd: 5,
        skill_type: 'attack',
        skill_name: CPU_CARD_STRINGS.DEFAULT_SKILL_NAME,
        skill_power: 10,
        image_url: null,
        rarity: 'common'
      }

      const userBattleCard: BattleCard = {
        id: userCard.id,
        name: userCard.name,
        hp: userCard.hp,
        currentHp: 0, // HP not tracked for CPU cards
        atk: userCard.atk,
        def: userCard.def,
        spd: userCard.spd,
        skill_type: userCard.skill_type,
        skill_name: userCard.skill_name,
        skill_power: userCard.skill_power,
        image_url: userCard.image_url,
        rarity: userCard.rarity
      }

      return NextResponse.json({
        battleId: battle.id,
        status: 'completed',
        result: battle.result,
        turnCount: battle.turn_count,
        userCard: userBattleCard,
        opponentCard: cpuCard,
        logs: logs
      })
    }

    // Calculate final HP from battle log (already validated above)
    let userHp = userCard.hp
    let opponentHp = opponentCard.hp

    logs.forEach(log => {
      if (log.actor === 'user' && log.damage) {
        opponentHp -= log.damage
      } else if (log.actor === 'opponent' && log.damage) {
        userHp -= log.damage
      }
      if (log.actor === 'user' && log.heal) {
        userHp = Math.min(userCard.hp, userHp + log.heal)
      } else if (log.actor === 'opponent' && log.heal) {
        opponentHp = Math.min(opponentCard.hp, opponentHp + log.heal)
      }
    })

    const userBattleCard: BattleCard = {
      id: userCard.id,
      name: userCard.name,
      hp: userCard.hp,
      currentHp: Math.max(0, userHp),
      atk: userCard.atk,
      def: userCard.def,
      spd: userCard.spd,
      skill_type: userCard.skill_type,
      skill_name: userCard.skill_name,
      skill_power: userCard.skill_power,
      image_url: userCard.image_url,
      rarity: userCard.rarity
    }

    const opponentBattleCard: BattleCard = {
      id: opponentCard.id,
      name: opponentCard.name.startsWith(CPU_CARD_STRINGS.NAME_PREFIX) ? opponentCard.name : `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}`,
      hp: opponentCard.hp,
      currentHp: Math.max(0, opponentHp),
      atk: opponentCard.atk,
      def: opponentCard.def,
      spd: opponentCard.spd,
      skill_type: opponentCard.skill_type,
      skill_name: opponentCard.skill_name,
      skill_power: opponentCard.skill_power,
      image_url: opponentCard.image_url,
      rarity: opponentCard.rarity
    }

    return NextResponse.json({
      battleId: battle.id,
      status: 'completed',
      result: battle.result,
      turnCount: battle.turn_count,
      userCard: userBattleCard,
      opponentCard: opponentBattleCard,
      logs: logs
    })

  } catch (error) {
    return handleApiError(error, "Battle Get API")
  }
}
