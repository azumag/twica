import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { toBattleCard, playBattle, generateCPUOpponent, type BattleCardData } from '@/lib/battle'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleDatabaseError } from '@/lib/error-handler'
import { reportBattleError } from '@/lib/sentry/error-handler'
import { setUserContext, setRequestContext, setGameContext } from '@/lib/sentry/user-context'
import { ERROR_MESSAGES } from '@/lib/constants'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import type { BattleLog, Card, CardWithStreamer, Json } from '@/types/database'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。この POST ハンドラは battles への
// INSERT(書き込み)を含むため、読み取り(users / user_cards / cards)も含めた
// リクエスト内の全 DB アクセスを isPgWriteEnabled() で分岐する(読み書きで経路が
// 混ざると障害切り分けが困難になるため。sub-check.ts 冒頭のフラグ使い分け方針と
// 同じ)。pg-read モードでは本ハンドラは従来の PostgREST 経路のまま動く。
// フラグ未設定時(既定 'postgrest')はこれらのモジュールの実行パスに一切入らない
// ため、import が存在するだけでは挙動に影響しない(tests/setup.ts の getDb throw
// スタブが「postgrest 経路で getDb が呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  battles as battlesTable,
  cards as cardsTable,
  streamers as streamersTable,
  userCards as userCardsTable,
  users as usersTable,
} from '@/lib/db/schema'
// card:cards(streamer:streamers(...)) 埋め込みの再構成ロジックは battle/stats・
// battle/[battleId] と実質同一のため共有モジュールへ切り出した(#663 コードレビュー
// 指摘)。この route は user_cards を直接クエリしトップレベルで user_cards.card_id
// を 'card_id' として使うため、cards.id 側は 'c_' プレフィックス版を使う
// (共有モジュールの doc コメント参照)。
import { CARD_EMBED_COLUMNS_C_PREFIX, toCardEmbedCPrefixed } from '@/lib/db/battle-card-embed'

/**
 * pg 直結クエリの結果を PostgREST の { data, error } 応答形状へ正規化するための
 * 最小型 (#663)。postgres.js はエラーを throw するため、既存の
 * 「if (xxxError || !xxxData) return handleDatabaseError(...)」というエラー分岐を
 * 両経路で共有するにはこの形への詰め替えが必要(support/activate route の
 * ActivateSupportCodeRpcDriverError と同じ設計)。
 */
interface PgQueryResult<T> {
  data: T | null
  error: unknown
}

/**
 * users の 1 行取得の pg 直結実装 (#663)。
 * 既存の .maybeSingle() は twitch_user_id の UNIQUE 制約(migration 00001)により
 * 最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchBattleStartUserPg(
  twitchUserId: string
): Promise<PgQueryResult<{ id: string; twitch_user_id: string }>> {
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
      'battleStart(users)',
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * user_cards + card:cards(+ streamer:streamers) 埋め込み取得の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .eq('id', userCardId).eq('user_id', ...).maybeSingle() は user_cards.id が PK の
 *   ため最大 1 行 → LIMIT 1 + rows[0] ?? null が同じ外部挙動。userCardId が UUID
 *   形式でない場合も、PostgREST 経路の 22P02 エラー(→ handleDatabaseError で 500)と
 *   同じく throw → error 返却 → 500 に落ちる。
 * - 埋め込みは PostgREST の実行時形状(多対一はオブジェクトまたは null)へ再構成する。
 *   card の存在判定は cards.id(PK)、streamer の存在判定は streamers.twitch_user_id
 *   (NOT NULL)の null 判定で行う(leftJoin 不一致 = PostgREST の埋め込み null)。
 *   user_cards.card_id は NOT NULL + FK(00001)のため実運用で card が null になる
 *   ことはないが、防御的挙動(card 欠落時は後続の toBattleCard で throw → 500)を
 *   PostgREST 経路と一致させるため再現する。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchBattleStartUserCardPg(
  userCardId: string,
  userId: string
): Promise<PgQueryResult<Record<string, unknown>>> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({
            user_id: userCardsTable.user_id,
            card_id: userCardsTable.card_id,
            // cards + streamer 埋め込み列は共有モジュールの 'c_' プレフィックス版
            // (トップレベルの user_cards.card_id と衝突しない列名。詳細は
            // ファイル冒頭 import のコメント・共有モジュールの doc コメント参照)
            ...CARD_EMBED_COLUMNS_C_PREFIX,
          })
          .from(userCardsTable)
          .leftJoin(cardsTable, eq(userCardsTable.card_id, cardsTable.id))
          .leftJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(and(eq(userCardsTable.id, userCardId), eq(userCardsTable.user_id, userId)))
          .limit(1)
      },
      'battleStart(user_cards)',
      { idempotent: true },
    )
    const row = rows[0] ?? null
    if (!row) {
      return { data: null, error: null }
    }
    return {
      data: {
        user_id: row.user_id,
        card_id: row.card_id,
        card: toCardEmbedCPrefixed(row),
      },
      error: null,
    }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * CPU 対戦相手候補(アクティブな全カード)取得の pg 直結実装 (#663)。
 *
 * 既存クエリは limit 指定なし = PostgREST サーバの max-rows 既定(このリポジトリ
 * では 1000 件。user-cards route の既存コメント「PostgRESTデフォルト1000件制限」
 * 参照)で打ち切られるため、LIMIT 1000 を明示して同じ上限に揃える(CPU 対戦相手の
 * 抽選母集団を両経路で一致させる)。並び順はどちらの経路も未指定(順序不定)で
 * 同一の性質。drop_rate は既存 select に含まれるが generateCPUOpponent では
 * 未使用(形状パリティのために選択のみ)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchActiveCardsForCpuPg(): Promise<PgQueryResult<Record<string, unknown>[]>> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({
            id: cardsTable.id,
            name: cardsTable.name,
            hp: cardsTable.hp,
            atk: cardsTable.atk,
            def: cardsTable.def,
            spd: cardsTable.spd,
            skill_type: cardsTable.skill_type,
            skill_name: cardsTable.skill_name,
            skill_power: cardsTable.skill_power,
            image_url: cardsTable.image_url,
            rarity: cardsTable.rarity,
            drop_rate: cardsTable.drop_rate,
          })
          .from(cardsTable)
          .where(eq(cardsTable.is_active, true))
          .limit(1000)
      },
      'battleStart(cards)',
      { idempotent: true },
    )
    return { data: rows, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * battles への対戦結果 INSERT の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .insert({...}).select().maybeSingle() は「挿入行の全列を返す」ため、Drizzle の
 *   .returning()(引数なし = 全列)+ rows[0] ?? null が同じ外部挙動。
 *
 * 冪等性判断(重要 — リトライ不可の根拠):
 * この INSERT には一意制約・冪等キーが無く、さらに migration 00002 の
 * AFTER INSERT トリガー update_battle_stats が battle_stats の対戦数/勝敗数を
 * インクリメントする。接続断は「クエリの結果不明」(サーバーに届いて COMMIT 済み
 * の可能性がある)を意味するため、自動リトライすると対戦履歴の二重記録 +
 * battle_stats の二重カウント(勝率の恒久的な歪み)が起きうる。よって非冪等
 * (withDbRetry 既定 = リトライなし)として扱い、失敗はそのまま 500 でユーザーへ
 * 返す(ユーザーは対戦を再実行すればよく、二重カウントの方が実害が大きい)。
 */
async function insertBattlePg(values: {
  user_id: string
  user_card_id: string
  opponent_card_id: string | null
  opponent_card_data: Record<string, unknown> | null
  result: 'win' | 'lose' | 'draw'
  turn_count: number
  battle_log: BattleLog[]
}): Promise<PgQueryResult<Record<string, unknown>>> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .insert(battlesTable)
          .values({
            user_id: values.user_id,
            user_card_id: values.user_card_id,
            opponent_card_id: values.opponent_card_id,
            // jsonb 列への値。実行時は PostgREST 経路と同じ JSON.stringify で
            // 直列化される(interface 型に index signature が無く Json 型へ構造的に
            // 代入できないための型キャストであり、値の変換はしない)
            opponent_card_data: values.opponent_card_data as Json | null,
            result: values.result,
            turn_count: values.turn_count,
            battle_log: values.battle_log as unknown as Json,
          })
          .returning()
      },
      'battleStart(insert battles)',
      // 非冪等のため withDbRetry の第3引数(idempotent オプション)は渡さない
      // (既定 false = 接続断でもリトライしない。上記 doc コメント参照)
    )
    return { data: (rows[0] ?? null) as Record<string, unknown> | null, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  setRequestContext(requestId, '/api/battle/start')

  let session: { twitchUserId: string; twitchUsername: string; broadcasterType?: string } | null = null

  try {
    // Content-Type validation - must be the first check
    const contentTypeValidation = validateContentType(request, 'application/json')
    if (contentTypeValidation) {
      return contentTypeValidation
    }

    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    session = await getSession()

    if (session) {
      setUserContext({
        twitchUserId: session.twitchUserId,
        twitchUsername: session.twitchUsername,
        broadcasterType: session.broadcasterType,
      })
    }

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleStart, identifier)

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

    // #663: 書き込みを含むハンドラのため、以降の全 DB アクセスを isPgWriteEnabled()
    // で分岐する(ファイル冒頭のコメント参照)。判定はここで 1 回だけ行って固定し、
    // リクエスト処理の途中で環境変数が変わっても経路が混在しないようにする。
    // pg 側の各ヘルパーは PostgREST と同一の { data, error } 形状へ正規化して返す
    // ため、直後の既存エラー分岐・整形ロジックはそのまま両経路で共有される。
    const usePgWrite = isPgWriteEnabled()

    const supabaseAdmin = getSupabaseAdmin()

    // Get user data
    const { data: userData, error: userError } = usePgWrite
      ? await fetchBattleStartUserPg(session.twitchUserId)
      : await supabaseAdmin
          .from('users')
          .select('id, twitch_user_id')
          .eq('twitch_user_id', session.twitchUserId)
          .maybeSingle()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Battle Start API: Failed to fetch user data")
    }

    const body = await request.json()
    const { userCardId } = body

    if (userCardId) {
      setGameContext({ cardId: userCardId })
    }

    if (!userCardId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.USER_CARD_ID_REQUIRED },
        { status: 400 }
      )
    }

    // Get user's card with details / Get all active cards for CPU opponent
    //
    // #663: pg 経路では fetchBattleStartUserCardPg(ユーザーカード取得)と
    // fetchActiveCardsForCpuPg(CPU 対戦相手候補プール取得)は userCardId 判明後は
    // 互いに独立した読み取り専用クエリのため Promise.all で並列化する
    // (コードレビュー指摘)。PostgREST 経路(usePgWrite === false)は本移行のスコープ
    // 外のため既存の逐次呼び出しのまま変更しない。
    // 注意: 並列化により、ユーザーカードが不正/未所持だった場合でも CPU カード
    // プールのクエリは実行される(元の逐次実装は userCardError で早期 return して
    // いたため実行されなかった)。最終的なレスポンス(userCardError を優先して
    // 500 を返す)は変わらないため外部挙動への影響はない。
    let userCardData: unknown
    let userCardError: unknown
    let allCards: unknown
    let allCardsError: unknown

    if (usePgWrite) {
      const [userCardResult, allCardsResult] = await Promise.all([
        fetchBattleStartUserCardPg(userCardId, userData.id),
        fetchActiveCardsForCpuPg(),
      ])
      userCardData = userCardResult.data
      userCardError = userCardResult.error
      allCards = allCardsResult.data
      allCardsError = allCardsResult.error
    } else {
      const userCardRes = await supabaseAdmin
        .from('user_cards')
        .select(`
            user_id,
            card_id,
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
          `)
        .eq('id', userCardId)
        .eq('user_id', userData.id)
        .maybeSingle()
      userCardData = userCardRes.data
      userCardError = userCardRes.error

      const allCardsRes = await supabaseAdmin
        .from('cards')
        .select('id, name, hp, atk, def, spd, skill_type, skill_name, skill_power, image_url, rarity, drop_rate')
        .eq('is_active', true)
      allCards = allCardsRes.data
      allCardsError = allCardsRes.error
    }

    if (userCardError || !userCardData) {
      return handleDatabaseError(userCardError ?? new Error('Card not found or not owned by user'), "Battle Start API: Failed to fetch user card")
    }

    if (allCardsError) {
      return handleDatabaseError(allCardsError, "Battle Start API: Failed to fetch cards for CPU opponent")
    }

    // 型上は allCards が null を許容する(fetchActiveCardsForCpuPg / PostgREST の
    // { data, error } 形状がいずれも data: T[] | null のため)が、実装上はエラーが
    // 無ければ必ず配列(空配列を含む)が返る。null はどちらの経路でも本来発生しない
    // 異常系だが、型を偽らず安全側で弾く(announcements.ts の
    // `if (announcements.length === 0) return []` と同じ、安全側フォールバックの
    // 流儀。ここは「空配列」ではなく「取得失敗扱い」として 500 を返す ——
    // generateCPUOpponent に null を渡すとランタイムエラーになるため)。
    if (!allCards) {
      return handleDatabaseError(new Error('Cards data unexpectedly null'), "Battle Start API: Failed to fetch cards for CPU opponent")
    }

    // Define proper types for Supabase query results
    interface UserCardQueryResult {
      user_id: string
      card_id: string
      card: CardWithStreamer
    }

    // Convert to BattleCard format with proper types
    const userCardQuery = userCardData as unknown as UserCardQueryResult
    const userCardDataForBattle = userCardQuery.card
    // pg 経路の fetchActiveCardsForCpuPg は Record<string, unknown>[] を返す
    // (cards の hp/atk/def/spd/skill_type/skill_name/skill_power/image_url は DDL に
    // NOT NULL が無く Drizzle 型上は null 許容になるため、BattleCardData の非 null
    // フィールドへ構造的に代入できない)。PostgREST 経路は getSupabaseAdmin() が
    // 非ジェネリックな SupabaseClient を返すため型上は any であり、同じ実行時形状を
    // 暗黙に信頼している。generateCardStats がカード生成時に必ず全フィールドへ値を
    // 埋めるため実運用で null にならないことは変わらないので、pg 経路も同じ前提で
    // キャストする(値の変換はしない。allCardsError / !allCards の分岐を通過済みの
    // ためここでは形状のみの問題)。
    const opponentBattleCard = generateCPUOpponent(allCards as (Card | BattleCardData)[])
    const userBattleCard = toBattleCard(userCardDataForBattle)

    // Play the battle
    const battleResult = await playBattle(userBattleCard, opponentBattleCard)

    // Prepare opponent card data for storage
    const opponentCardData = opponentBattleCard.id.startsWith('cpu-') ? {
      id: opponentBattleCard.id,
      name: opponentBattleCard.name,
      hp: opponentBattleCard.hp,
      atk: opponentBattleCard.atk,
      def: opponentBattleCard.def,
      spd: opponentBattleCard.spd,
      skill_type: opponentBattleCard.skill_type,
      skill_name: opponentBattleCard.skill_name,
      image_url: opponentBattleCard.image_url,
      rarity: opponentBattleCard.rarity
    } : null

    // Store battle in database
    const { data: battleData, error: battleError } = usePgWrite
      ? await insertBattlePg({
          user_id: userData.id,
          user_card_id: userCardId,
          opponent_card_id: opponentBattleCard.id.startsWith('cpu-') ? null : opponentBattleCard.id,
          opponent_card_data: opponentCardData,
          result: battleResult.result,
          turn_count: battleResult.turnCount,
          battle_log: battleResult.logs
        })
      : await supabaseAdmin
          .from('battles')
          .insert({
            user_id: userData.id,
            user_card_id: userCardId,
            opponent_card_id: opponentBattleCard.id.startsWith('cpu-') ? null : opponentBattleCard.id,
            opponent_card_data: opponentCardData,
            result: battleResult.result,
            turn_count: battleResult.turnCount,
            battle_log: battleResult.logs
          })
          .select()
          .maybeSingle()

    if (battleData) {
      setGameContext({
        battleId: battleData.id,
        outcome: battleResult.result
      })
    }

    if (battleError) {
      return handleDatabaseError(battleError, "Battle Start API: Failed to save battle")
    }

    // Return battle result with card details
    return NextResponse.json({
      battleId: battleData.id,
      result: battleResult.result,
      turnCount: battleResult.turnCount,
      userCard: {
        id: userBattleCard.id,
        name: userBattleCard.name,
        hp: userBattleCard.hp,
        currentHp: battleResult.userHp,
        atk: userBattleCard.atk,
        def: userBattleCard.def,
        spd: userBattleCard.spd,
        skill_type: userBattleCard.skill_type,
        skill_name: userBattleCard.skill_name,
        image_url: userBattleCard.image_url,
        rarity: userBattleCard.rarity
      },
      opponentCard: {
        id: opponentBattleCard.id,
        name: opponentBattleCard.name,
        hp: opponentBattleCard.hp,
        currentHp: battleResult.opponentHp,
        atk: opponentBattleCard.atk,
        def: opponentBattleCard.def,
        spd: opponentBattleCard.spd,
        skill_type: opponentBattleCard.skill_type,
        skill_name: opponentBattleCard.skill_name,
        image_url: opponentBattleCard.image_url,
        rarity: opponentBattleCard.rarity
      },
      logs: battleResult.logs
    })

  } catch (error) {
    // reportBattleError が [Battle Error] タイプで Supabase 記録 + console.error を行う
    if (session) {
      await reportBattleError(error, {
        battleId: undefined, // Not created yet due to error
        userId: session.twitchUserId,
        round: undefined, // Battle hasn't started
      })
    } else {
      await reportBattleError(error, {})
    }

    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
  }
}
