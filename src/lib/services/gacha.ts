import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { normalizeDropRate } from '@/lib/card-utils'
import { Result, ok, err } from '@/types/result'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'
import { withRetry } from '@/lib/supabase/retry'
// #573: ガチャ経路(チャネルポイント消費を伴う課金系クリティカルパス)の pg 直結分岐用。
// フラグ未設定時(既定 'postgrest')はこれらのモジュールの実行パスに一切入らないため、
// import が存在するだけでは挙動に影響しない(#570 の設計。tests/setup.ts の getDb
// throw スタブも「postgrest 経路で getDb が呼ばれない」ことを構造的に保証している)。
import { getDb } from '@/lib/db/client'
import { getGachaDbDriver } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { isPgFunctionNotFoundError } from '@/lib/db/errors'
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError } from '@/lib/card-issuance'
import {
  isMissingCollectionNameColumn,
  isMissingRarityWeightsScopeColumnError,
  isMissingPackRarityWeightsColumnError,
} from '@/lib/collections/collection-existence'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { computeEffectiveWeights, resolveRarityWeightsForPool } from '@/lib/rarity-weight-calculator'

export interface GachaCard {
  id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  drop_rate: number
  max_issuance_count?: number | null
}

/**
 * パック内レアリティ自動配分(Issue #579, #576 フェーズ2)に必要な、配信者の
 * レアリティ重み設定。executeGacha に collectionName と一緒に渡し、抽選プールが
 * 特定パックに絞られている場合のみ effectiveWeight 計算に使う。省略時/各
 * フィールドが undefined の場合は resolveRarityWeightsForPool が安全側
 * (手動モード維持 or グローバル配分)にフォールバックする。
 */
export interface RarityWeightsDrawConfig {
  rarityWeightsScope?: string | null
  rarityWeights?: Record<string, number> | null
  packRarityWeights?: Record<string, Record<string, number>> | null
}

/**
 * EventSub用ストリーマー情報（チャット通知設定を含む）
 * executeGachaForEventSub でストリーマークエリを1回に統合するために使用
 */
export interface EventSubStreamerInfo {
  id: string
  chat_announcement_enabled: boolean
  chat_announcement_template: string | null
  chat_announcement_multi_template: string | null
  chat_announcement_multi_show_cards: boolean
  // Issue #597: {packName} プレースホルダでデフォルト(未分類)パックの表示名
  // オーバーライドとして使う(#554 の default_card_pack_name)。raid gacha 経路
  // (executeGachaForRaidEvent)はパックに絞られることが無いため未取得のまま
  // (undefined)でもよいよう optional にする。
  default_card_pack_name?: string | null
}

export interface GachaResult {
  card: GachaCard
  cards?: GachaCard[]
  userTwitchUsername: string
  rewardId?: string | null
  // Issue #597: 抽選をパックに絞った際の collection_name(DEFAULT_PACK_SENTINEL
  // を含む)。無制限抽選(パック指定なし)の場合は null/undefined。チャット通知
  // の {packName} プレースホルダ解決に使う。
  collectionName?: string | null
  /** EventSub経由の場合のみ設定。クエリ統合のためガチャ結果と一緒に返す */
  streamer?: EventSubStreamerInfo
}

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? ''
  return error?.code === 'PGRST204' || message.includes('draw_count') || message.includes('is_raid_limited')
}

const ADDITIONAL_REWARD_OPTIONS_UNAVAILABLE = 'Additional reward options unavailable'

/**
 * execute_gacha_transaction RPC (migration 00070, RETURNS JSONB) の戻り値の形状。
 * plpgsql 側の jsonb_build_object が返すプレーンオブジェクトで、PostgREST .rpc() の
 * data と pg 直結(postgres.js)の rows[0].result は同一形状になる(#573)。
 * 3キーとも「返らないことがある」(例: is_duplicate:true の early return では
 * limit_reached / history_id が無い)ため全て optional。既存コードも
 * rpcResult?.is_duplicate / rpcResult?.limit_reached と optional アクセスで
 * 消費しており、この型はその実態を明文化したもの。
 */
interface GachaTransactionRpcResult {
  is_duplicate?: boolean
  limit_reached?: boolean
  history_id?: string | null
}

/**
 * pg 直結経路のエラーを PostgREST .rpc() の error と同じ「code + message」形状へ
 * 正規化するための最小型(#573)。postgres.js は PostgrestError と異なりエラーを
 * throw するため、executeGacha 内の既存エラー分岐(42883→legacy フォールバック、
 * reportError + err())を両経路で共有するにはこの形への詰め替えが必要。
 * code を optional にしているのは、接続断系(CONNECTION_CLOSED 等)や
 * 非 Error オブジェクトが throw された場合に SQLSTATE が存在しないため。
 */
interface GachaRpcDriverError {
  code?: string
  message: string
}

/**
 * get_issued_card_counts RPC (migration 00069) の JSONB 戻り値
 * ({ "<card_id>": <count>, ... }) を Map<card_id, count> にパースする。
 * Issue #548: 旧実装の issuedCounts と完全に同じ形状を維持する。
 *
 * RPC が未デプロイ/エラー時のフォールバック(select+in→JS集計)と混線しないよう、
 * 想定外の形(null/配列/非オブジェクト)は空Mapとして扱い、呼び出し側で例外を
 * 起こさない防御的パースにする。
 */
function parseIssuedCardCountsRpc(rpcResult: unknown): Map<string, number> {
  const counts = new Map<string, number>()
  if (!rpcResult || typeof rpcResult !== 'object' || Array.isArray(rpcResult)) {
    return counts
  }
  for (const [cardId, rawCount] of Object.entries(rpcResult as Record<string, unknown>)) {
    const count = Number(rawCount)
    if (Number.isFinite(count)) {
      counts.set(cardId, count)
    }
  }
  return counts
}

function isStreamerSettingsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? ''
  return error?.code === 'PGRST204'
    || message.includes('raid_gacha_active_until')
    || message.includes('raid_gacha_draw_count')
    || message.includes('chat_announcement_multi_template')
    || message.includes('chat_announcement_multi_show_cards')
    || message.includes('channel_point_collection_name')
}

function isRaidGachaActive(activeUntil: string | null | undefined, now = new Date()): boolean {
  if (!activeUntil) return false
  const activeUntilTime = Date.parse(activeUntil)
  return Number.isFinite(activeUntilTime) && activeUntilTime > now.getTime()
}

/**
 * Issue #512: N連ドローの各カードに割り当てる event_id を計算する。
 * 1枚目は eventId そのもの、2枚目以降は `${eventId}:${連番}` を使う
 * (execute_gacha_transaction RPC の event_id UNIQUE制約により1枚ずつ
 * 独立して重複検知できるようにするため)。executeGachaDraws のループと
 * countCompletedDrawPrefix の両方がこの式を使う — 別々に書くと将来
 * ズレて再開位置の判定が壊れるため、共通化して1箇所にする。
 */
function buildDrawEventId(eventId: string | undefined, index: number): string | undefined {
  if (!eventId) return eventId
  return index > 0 ? `${eventId}:${index + 1}` : eventId
}

export class GachaService {
  private supabase = getSupabaseAdmin()

  async executeGacha(
    streamerId: string,
    userTwitchId: string,
    userTwitchUsername: string,
    eventId?: string,
    rewardCost?: number,
    // Issue #393: when set, restrict the draw pool to this card pack. NULL/undefined
    // keeps the legacy "all active cards" behavior.
    collectionName?: string | null,
    // Issue #579 (#576 フェーズ2): パック内レアリティ自動配分に使う配信者の
    // 重み設定。collectionName が未指定の場合や手動モードの場合は無視され、
    // 従来どおり drop_rate ベースの抽選になる。
    weightsConfig?: RarityWeightsDrawConfig,
    // Issue #591: Twitchチャネルポイント報酬ID(streamer_additional_gacha_rewards.reward_id
    // / GachaResult.rewardId と同じ形の値、cards.id とは無関係)。execute_gacha_transaction
    // RPC経由でgacha_history.reward_idに永続化することで、Realtime broadcastが届かない
    // ポーリング経路(/api/overlay/[streamerId]/events)でも報酬別効果音ルール
    // (gacha-sound-rules.ts の targetType: 'reward', #451/#586)が発火するようにする。
    // EventSub経由(executeGachaForEventSub)のみ利用可能。レイドガチャ
    // (executeGachaForRaidEvent)はチャネルポイント報酬に紐付かないため常にundefined。
    rewardId?: string | null
  ): Promise<Result<GachaResult>> {
    try {
      // Get active cards for this streamer (optionally scoped to a pack).
      // collection_name は抽選後に下流で使われないため SELECT しない。これにより
      // パック未指定のガチャ(=大多数)はクエリが従来と完全に同一になり、列未デプロイの
      // デプロイ窓でも一切巻き込まれない。パック指定時のみ WHERE で列を参照する。
      // collection_name is not consumed downstream, so it is not selected. With no
      // pack requested the query is byte-identical to the legacy one (zero
      // deploy-window risk); the column is only referenced in the WHERE clause
      // when a specific pack is requested.
      // max_issuance_count is selected here (Issue #108) so per-card issuance caps
      // can be enforced below; it falls back to a column-less select via
      // isMissingCardIssuanceColumnError if the migration has not landed yet.
      //
      // Issue #108 + #393 combined: the pack filter (collectionName) must be
      // applied on BOTH the primary and the issuance-column-missing fallback
      // query below, or the fallback would silently ignore the requested pack
      // and draw from ALL of the streamer's cards during that deploy window.
      //
      // Issue #579 (#576 フェーズ2): intra_rarity_weight (migration 00026, 既存の
      // 安定列) はパック内レアリティ自動配分の計算にのみ必要なので、パック指定時
      // のみ SELECT に追加する。supabase-js は select() の *リテラル* 文字列から
      // Row 型を推論するため(変数文字列や三項式を渡すと型が崩れる)、列リストが
      // 異なる分岐ごとに select() 呼び出し自体を分ける。パック未指定クエリの
      // 列リストは従来(main の #108 実装)と完全に同一のまま維持する。
      let { data: cards, error: cardsError } = await withRetry(
        () => {
          if (collectionName) {
            let query = this.supabase
              .from('cards')
              .select('id, name, description, image_url, rarity, drop_rate, max_issuance_count, intra_rarity_weight')
              .eq('streamer_id', streamerId)
              .eq('is_active', true)

            // Issue #555: DEFAULT_PACK_SENTINEL means "draw only from unclassified
            // cards" (collection_name IS NULL) — the inverse of a normal named-pack
            // filter, which needs `.eq(...)` against a literal string value.
            // `.eq('collection_name', DEFAULT_PACK_SENTINEL)` would never match any
            // card (no card's collection_name literally equals that sentinel), so
            // this must branch to `.is(...)` instead.
            query = collectionName === DEFAULT_PACK_SENTINEL
              ? query.is('collection_name', null)
              : query.eq('collection_name', collectionName)

            return query
          }

          return this.supabase
            .from('cards')
            .select('id, name, description, image_url, rarity, drop_rate, max_issuance_count')
            .eq('streamer_id', streamerId)
            .eq('is_active', true)
        },
        'gacha:executeGacha:cards',
      )

      if (cardsError && isMissingCardIssuanceColumnError(cardsError)) {
        const fallbackResult = await withRetry(
          () => {
            // Issue #579: fallback 側もパック指定時は intra_rarity_weight を含める
            // (含めないと発行上限列のデプロイ窓中だけパック内自動配分が
            // intra=デフォルト1.0 扱いになり配分が静かにズレる)。列リストが
            // 異なるため primary クエリと同様に select() を分岐ごとに分ける。
            if (collectionName) {
              let query = this.supabase
                .from('cards')
                .select('id, name, description, image_url, rarity, drop_rate, intra_rarity_weight')
                .eq('streamer_id', streamerId)
                .eq('is_active', true)

              query = collectionName === DEFAULT_PACK_SENTINEL
                ? query.is('collection_name', null)
                : query.eq('collection_name', collectionName)

              return query
            }

            return this.supabase
              .from('cards')
              .select('id, name, description, image_url, rarity, drop_rate')
              .eq('streamer_id', streamerId)
              .eq('is_active', true)
          },
          'gacha:executeGacha:cards:fallback',
        )
        cards = fallbackResult.data?.map((card) => ({
          ...card,
          max_issuance_count: null,
        })) ?? null
        cardsError = fallbackResult.error
      }

      if (cardsError) {
        // Deploy-window safety: a pack was requested but the collection_name
        // column is not migrated yet. Refuse rather than silently drawing from
        // ALL cards (which would be the wrong pool). Only reachable when a pack
        // is requested, since otherwise the query never references the column.
        // 列未デプロイ時、指定パックを誤って全カード抽選に落とさず拒否する。
        if (collectionName && isMissingCollectionNameColumn(cardsError)) {
          return err('Card collections are not deployed yet')
        }
        return err(`Database error: ${cardsError.message}`)
      }

      if (!cards || cards.length === 0) {
        return err(collectionName ? 'No cards available for this collection' : 'No cards available for this streamer')
      }

      const limitedCards = cards.filter((card) => card.max_issuance_count !== null && card.max_issuance_count !== undefined)
      let availableCards = cards
      if (limitedCards.length > 0) {
        const issuedCountsResult = await this.getIssuedCounts(limitedCards.map((card) => card.id))
        if (!issuedCountsResult.success) {
          return err(issuedCountsResult.error)
        }
        const issuedCounts = issuedCountsResult.data

        availableCards = cards.filter((card) => {
          if (card.max_issuance_count === null || card.max_issuance_count === undefined) return true
          return (issuedCounts.get(card.id) || 0) < card.max_issuance_count
        })
      }

      if (availableCards.length === 0) {
        return err(CARD_ISSUANCE_MESSAGES.soldOut)
      }

      // Select a card based on drop rates — unless the pool is pack-scoped AND
      // the streamer is in rarity auto mode, in which case the effective
      // per-card weight computed from the pack's rarity distribution
      // (Issue #579, #576 フェーズ2) is used for selection instead.
      // resolveRarityWeightsForPool returns null for manual mode / unrestricted
      // draws / no config, in which case behavior is unchanged (drop_rate
      // renormalized within the pool).
      //
      // Issue #108 との合成順序: 実効重みは「発行上限フィルタ後の availableCards」
      // をプールとして計算する。売り切れカードは抽選プールに存在しないため、
      // その分の配分は残りのカードへ比例再分配される(#576 設計の欠落レアリティと
      // 同じ規則)。
      // ドロップ率に基づいてカードを選択（パック指定+自動モード時はパック内
      // 実効重みで選択、それ以外は従来どおり drop_rate ベース）
      const resolvedRarityWeights = collectionName
        ? resolveRarityWeightsForPool(
            weightsConfig?.rarityWeightsScope,
            weightsConfig?.rarityWeights,
            weightsConfig?.packRarityWeights,
            collectionName
          )
        : null

      // R1 (PR #450 レビュー follow-up): execute_gacha_transaction は、選択した
      // カードが「同時実行中の別ドローに先に発行枠を取られた」または「選択後に
      // 行自体が消えた」場合に limit_reached:true を返す(migration 00067
      // L44-65: FOR UPDATE ロック取得後の NOT FOUND / 上限到達チェックは、どちらも
      // gacha_history への INSERT (L67) より前に return するため、副作用ゼロで
      // 中断される)。したがって同じ eventId で RPC を再実行しても二重付与や
      // 二重履歴は発生しない — 安全に「選び直して再試行」できる。
      //
      // 修正前は limit_reached を「抽選全体の失敗」として即 soldOut を返して
      // いたため、フェッチ済みプールの残り(多くの場合 90% 以上を占める無制限
      // カード)がまだ選べるにもかかわらず、ユーザーはチャネルポイントを消費した
      // 上でカードを受け取れなかった。max_issuance_count=1 の「ユニークカード」
      // 争奪タイミング(バーストで同一カードに複数ドローが殺到する場面)で最も
      // 深刻だった。
      //
      // 対策: limit_reached を受けたら、選ばれたカードだけをローカルの抽選
      // プールから除外し、残りのプールに対して選択ロジック(実効重み/手動を
      // 問わず selectCardFromPool に共通化)を再実行してから RPC を呼び直す。
      // MAX_LIMIT_REACHED_RETRIES=5 で打ち切るのは、(a) 少数の上限カードへの
      // バーストであれば数回の再選択で豊富な残りプールへ確実に落ちる一方、
      // (b) 何らかの異常(例: プール全体が上限到達直前)で毎回 limit_reached が
      // 続く場合に、1回のガチャで無制限に RPC を叩き続けてDB/RPCへ負荷を
      // かけ続けることを防ぐため。プールが尽きた場合、または再試行上限に
      // 達した場合のみ soldOut を返す。
      const MAX_LIMIT_REACHED_RETRIES = 5
      let pool = availableCards

      for (let attempt = 1; ; attempt += 1) {
        const selectedCard = this.selectCardFromPool(pool, resolvedRarityWeights)

        if (!selectedCard) {
          return err('Failed to select card')
        }

        // gacha_history, users, user_cards を1トランザクションでアトミックに実行
        // 従来は3回の個別DB操作で中間状態（履歴あり・カード未付与）が発生しえた
        //
        // #573: ガチャ書き込み(課金系・EventSub 高頻度のクリティカルパス)の pg 直結分岐。
        // 全体フラグ(DB_DRIVER)ではなく getGachaDbDriver() で分岐する:
        // GACHA_DB_DRIVER はガチャ経路「だけ」を全体フラグと独立に即時ロールバック/
        // 先行切替できる緊急スイッチ(本番障害時の影響範囲を最小化する独立レバー。
        // src/lib/db/flags.ts 参照)。フラグ未設定時は従来どおり下の supabase-js
        // (PostgREST)経路が無変更のまま実行される。
        //
        // 分岐は「RPC を実行して { data, error } を得る」部分だけに絞る。pg 側
        // (executeGachaTransactionRpcPg)が PostgREST .rpc() と同一の { data, error }
        // 形状へ正規化して返すため、この直後のエラー分岐(42883→executeGachaLegacy
        // フォールバック、reportError + err())と is_duplicate / limit_reached の
        // 後続処理(limit_reached 再抽選ループ含む)は両経路で完全に共有される —
        // 経路によって外部挙動が変わる余地を分岐点1箇所に閉じ込めるための設計。
        const { data: rpcResult, error: rpcError } = getGachaDbDriver() === 'pg'
          ? await this.executeGachaTransactionRpcPg({
              eventId: eventId || null,
              userTwitchId,
              userTwitchUsername,
              cardId: selectedCard.id,
              streamerId,
              rewardCost: rewardCost ?? null,
              rewardId: rewardId ?? null,
            })
          : await withRetry(
              () => this.supabase.rpc('execute_gacha_transaction', {
                p_event_id: eventId || null,
                p_user_twitch_id: userTwitchId,
                p_user_twitch_username: userTwitchUsername,
                p_card_id: selectedCard.id,
                p_streamer_id: streamerId,
                p_reward_cost: rewardCost ?? null,
                p_reward_id: rewardId ?? null,
              }),
              'gacha:executeGacha:rpc',
            )

        if (rpcError) {
          // RPC関数が未デプロイの場合（マイグレーション前）は旧ロジックにフォールバック
          // 無停止デプロイ時にアプリコードが先にデプロイされても、
          // ユーザーのチャネルポイントが消費されカード未付与になることを防ぐ
          // TODO: マイグレーション適用確認後にフォールバックを削除
          //
          // Issue #591 (p_reward_id追加): PostgREST はRPCを名前付き引数で呼ぶため、
          // 本アプリコードが先にデプロイされ p_reward_id を送っても、DB側が
          // migration 00070 未適用(旧6引数版のまま)だと該当パラメータ名を
          // 解決できず 42883 になる — 00033 で p_reward_cost を追加した際と
          // 全く同じ性質のデプロイ窓リスクであり、この既存フォールバックが
          // そのまま吸収する。列とRPCは同一migrationファイル内でアトミックに
          // 追加されるため、この42883の間は gacha_history.reward_id 列も
          // 未デプロイ — だからこそ下の executeGachaLegacy は reward_id を
          // 書き込まない(書けば列不在でPGRST204になるため、詳細は
          // executeGachaLegacy 内のコメント参照)。
          if (rpcError.code === '42883') {
            logger.warn('execute_gacha_transaction not found, falling back to legacy operations', {
              streamerId, userTwitchId, eventId,
            })
            return this.executeGachaLegacy(streamerId, userTwitchId, userTwitchUsername, selectedCard, eventId, rewardCost)
          }

          await reportError(new Error(`Gacha RPC failed: ${rpcError.message}`), {
            context: 'gacha:executeGacha:rpc',
            streamerId,
            userTwitchId,
            eventId,
          })
          return err(`Failed to execute gacha transaction: ${rpcError.message}`)
        }

        // EventSub重複通知の場合（event_idが既に処理済み）
        if (rpcResult?.is_duplicate) {
          return err('Duplicate event')
        }

        if (rpcResult?.limit_reached) {
          pool = pool.filter((card) => card.id !== selectedCard.id)
          if (attempt >= MAX_LIMIT_REACHED_RETRIES || pool.length === 0) {
            return err(CARD_ISSUANCE_MESSAGES.soldOut)
          }
          continue
        }

        return ok({
          card: selectedCard,
          userTwitchUsername,
        })
      }
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }

  /**
   * execute_gacha_transaction RPC の pg 直結(postgres.js)実装 (#573)。
   * GACHA_DB_DRIVER=pg (または DB_DRIVER=pg かつ GACHA_DB_DRIVER 未設定)のときのみ
   * executeGacha から呼ばれる。PostgREST .rpc() と同一の { data, error } 形状を
   * 返すことで、呼び出し側の後続分岐(42883 フォールバック・is_duplicate・
   * limit_reached 再抽選)を両経路で共有する。
   *
   * 名前付き引数(p_event_id => ...)で呼ぶ理由: 位置引数だと将来のパラメータ追加・
   * 並び替えで「隣の引数へズレたまま型だけ合ってしまう」取り違え事故(課金系では
   * 致命的)を検出できない。migration 00070 のシグネチャ(7引数、末尾2つは
   * DEFAULT NULL)と名前で1対1対応させ、PostgREST .rpc() が名前付きで呼ぶ挙動とも
   * 揃える。値はすべて postgres.js のバインドパラメータとして送られるため
   * SQL インジェクションは構造的に不可能。uuid 引数は明示 ::uuid キャストで
   * 型解決を固定する(integer も同様)。text 引数は unknown のまま送っても
   * 名前付き引数の関数解決で text へ一意に強制されるためキャスト不要。
   *
   * jsonb 戻り値: postgres.js は fetch_types:false (src/lib/db/client.ts)でも
   * json/jsonb (OID 114/3802) の組み込みパーサ(JSON.parse)を常に登録している
   * (node_modules/postgres/src/types.js の types.json.from: [114, 3802] で確認)。
   * したがって RETURNS JSONB の値は rows[0].result で既に JS オブジェクトになって
   * おり、PostgREST .rpc() の data ({ is_duplicate?, limit_reached?, history_id? })
   * と同一形状。drizzle() が上書きするのは timestamp/date 系パーサのみで
   * json/jsonb には影響しない。
   *
   * リトライ: withDbRetry(..., { idempotent: eventId !== null })。
   * - eventId が非 null の場合のみリトライを許可する。RPC は gacha_history へ
   *   ON CONFLICT (event_id) DO NOTHING で INSERT し(migration 00070)、重複時は
   *   users/user_cards への書き込み前に is_duplicate:true で early return するため、
   *   同一 event_id での再実行は副作用ゼロ(=冪等)。接続断リトライ後の
   *   is_duplicate:true は「初回が実はコミットされていた」ケースを含むが、これは
   *   EventSub 再送と同じ err('Duplicate event') 扱いが正しい(カードは初回実行分が
   *   既に付与済みで、二重付与も未付与も起きない)。
   * - demo ガチャ(src/app/api/gacha/route.ts、eventId=null)は冪等キーが無く、
   *   再実行のたびに新しい履歴行+カード付与が発生するためリトライ禁止
   *   (withDbRetry の既定 idempotent:false は接続断=「コミット済みか不明」を
   *   二重排出させないための安全側動作。src/lib/db/retry.ts 参照)。既存 postgrest
   *   経路の withRetry は eventId に関わらず 502/503 をリトライするが、あちらは
   *   HTTP ゲートウェイ層のエラー分類であり、pg 直結では接続断の結果不明性を
   *   優先して非冪等時はリトライしない(意図的な安全側の差)。
   * - リトライ回数・バックオフは既存 withRetry と同一の既定値
   *   ([100,300,1000]ms・最大3回)で、冪等時のリトライ特性は両経路で揃う。
   */
  private async executeGachaTransactionRpcPg(params: {
    eventId: string | null
    userTwitchId: string
    userTwitchUsername: string
    cardId: string
    streamerId: string
    rewardCost: number | null
    rewardId: string | null
  }): Promise<{ data: GachaTransactionRpcResult | null; error: GachaRpcDriverError | null }> {
    try {
      // セキュリティレビュー指摘対応: 接続断リトライが実際に発生したかどうかを
      // 観測するため、queryFn の実行回数をクロージャでカウントする(外部挙動は不変)。
      let attemptCount = 0
      const data = await withDbRetry(
        async () => {
          attemptCount += 1
          // 規約: getDb() は queryFn の中で呼ぶ(リクエストスコープ破棄からの回復には
          // クライアント再取得が必要。src/lib/db/retry.ts 参照)
          const { sql } = await getDb()
          const rows = await sql<{ result: GachaTransactionRpcResult | null }[]>`
            select execute_gacha_transaction(
              p_event_id => ${params.eventId},
              p_user_twitch_id => ${params.userTwitchId},
              p_user_twitch_username => ${params.userTwitchUsername},
              p_card_id => ${params.cardId}::uuid,
              p_streamer_id => ${params.streamerId}::uuid,
              p_reward_cost => ${params.rewardCost}::integer,
              p_reward_id => ${params.rewardId}
            ) as result
          `
          return rows[0]?.result ?? null
        },
        'gacha:executeGacha:rpc(pg)',
        { idempotent: params.eventId !== null },
      )
      // 2回以上実行された(=接続断リトライが発生した)後の is_duplicate / limit_reached
      // は、「初回実行が実はコミット済みで応答だけ失われた」ケースを含む。
      // - is_duplicate: ON CONFLICT (event_id) により再実行が重複扱いになった
      // - limit_reached: migration 00070 の評価順序では発行上限チェックが event_id
      //   重複チェックより先に走るため、発行上限付きカードでは重複でも上限到達として
      //   返る(その後の再抽選 → is_duplicate → err('Duplicate event') に至る)
      // どちらもカード付与・ポイント消費は初回分の1回で正しく完結している
      // (データ不整合なし)が、視聴者への演出・チャット通知が欠落する。ログ無しでは
      // 本物の EventSub 再送の is_duplicate と区別できないため、warn で観測可能に
      // する(既知の稀な事象。plpgsql の評価順序修正は migration が必要なため
      // Phase 2 対応。docs/db-driver-migration.md 参照)。戻り値は変更しない。
      // ログにトークン等の秘密情報は含めない。
      if (attemptCount >= 2 && (data?.is_duplicate || data?.limit_reached)) {
        logger.warn(
          `[db:pg] gacha rpc returned ${data.is_duplicate ? 'is_duplicate' : 'limit_reached'} after connection retry — 初回実行がコミット済みだった可能性があり、その場合視聴者への演出が欠落する(既知の稀な事象、docs/db-driver-migration.md 参照)`,
          {
            eventId: params.eventId,
            streamerId: params.streamerId,
            userTwitchId: params.userTwitchId,
            cardId: params.cardId,
            attempts: attemptCount,
          },
        )
      }
      return { data, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // 42883 (undefined_function) = RPC 未デプロイのデプロイ窓。code:'42883' へ
      // 正規化して返し、呼び出し側の既存分岐(rpcError.code === '42883' →
      // executeGachaLegacy)にそのまま乗せる。executeGachaLegacy は postgrest 実装の
      // まま変更しない: 異常時(マイグレーションとコードのデプロイ順ズレ)に頼る
      // 最後の安全弁は、本番実績のある既存経路へ逃がすほうが「新経路の不具合が
      // フォールバック先まで巻き込む」リスクを避けられるため(#573 の設計判断)。
      // isPgFunctionNotFoundError を明示的に使うのは、検知ロジックを
      // src/lib/db/errors.ts に一元化し、将来判定方法が変わっても正規化後の
      // code が '42883' で安定するようにするため。
      if (isPgFunctionNotFoundError(error)) {
        return { data: null, error: { code: '42883', message } }
      }

      // その他のエラー(接続断・SQLSTATE 各種・非 Error throw)は code をそのまま
      // 透過し、呼び出し側の既存分岐で PostgREST エラーと同じ外部挙動
      // (reportError + err('Failed to execute gacha transaction: ...'))になる。
      const code = (error as { code?: unknown } | null)?.code
      return {
        data: null,
        error: { code: typeof code === 'string' ? code : undefined, message },
      }
    }
  }

  /**
   * 発行上限付きカード(max_issuance_count が設定されたカード)について、
   * card_id ごとの発行済み枚数を取得する。
   *
   * Issue #548: 旧実装は user_cards から該当card_idの行を .in() で全件フェッチし、
   * アプリ側(JS)で card_id ごとに1行ずつ数えていた。発行数が多い人気の限定
   * カードほど、件数を知りたいだけなのに数千行をDBからアプリへ転送することになり、
   * 転送量・メモリ・レイテンシが発行済み枚数に比例して線形に悪化していた。
   * get_issued_card_counts RPC (migration 00069) はDB側で GROUP BY / COUNT(*) を
   * 実行し、{ "<card_id>": <count> } 形式のJSONBオブジェクト1個だけを返す。
   * これにより転送量は「発行上限付きカードの種類数」(通常一桁〜十数件)にしか
   * 依存しなくなる。
   *
   * 無停止デプロイの過渡期でRPCが未デプロイ(42883)の場合は、旧来の
   * select+in によるフェッチ→JS集計にフォールバックする。Map<card_id, count>
   * の中身は両経路で完全に同一になるため、呼び出し側(executeGacha)の
   * フィルタリングロジックへの影響はない。
   */
  private async getIssuedCounts(cardIds: string[]): Promise<Result<Map<string, number>>> {
    // #573: get_issued_card_counts はガチャ実行フロー(executeGacha)の内部呼び出しで
    // あるため、全体フラグ(DB_DRIVER)ではなく execute_gacha_transaction と同じ
    // getGachaDbDriver() で分岐する。GACHA_DB_DRIVER=postgrest による緊急ロール
    // バックのとき、この呼び出しだけ pg 直結に残る「経路の食い違い」を作らない —
    // ロールバックは1つのレバーでガチャ実行フロー全体を旧経路へ戻せる必要がある。
    if (getGachaDbDriver() === 'pg') {
      try {
        const rpcData = await withDbRetry(
          async () => {
            // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
            const { sql } = await getDb()
            // migration 00069 の定義は RETURNS JSONB ({ "<card_id>": <count> })。
            // RETURNS TABLE ではないため行集合展開(select * from fn(...))は不要で、
            // スカラー SELECT + rows[0].result で PostgREST .rpc() の data と同一
            // 形状のオブジェクトが得られる(jsonb→JS オブジェクト変換の根拠は
            // executeGachaTransactionRpcPg の doc コメント参照)。両経路とも
            // 同じ parseIssuedCardCountsRpc に通すため Map の中身も完全一致する。
            //
            // p_card_ids (uuid[]) の渡し方: postgres.js は fetch_types:false
            // (src/lib/db/client.ts)では配列型の型情報(typeArrayMap)を接続時に
            // 取得しないため、JS 配列をそのままバインドすると PG の配列リテラル
            // ではなく 'id1,id2' 形式の壊れたテキストに直列化される
            // (node_modules/postgres/src/types.js の inferType が配列を unknown
            // 扱いにし、connection.js の Bind が '' + x で文字列化するため。
            // sql.array() ヘルパーも typeArrayMap が空のため同様に壊れる)。
            // その値は関数解決に失敗して 42883 を誘発し、下の「未デプロイ」
            // フォールバックへ*静かに常時*落ちてしまう(性能改善 #548 が無効化
            // されたままアラートも出ない)。これを避けるため、カンマ結合した
            // テキスト1個をバインドし DB 側で string_to_array(...)::uuid[] に
            // 展開する。値は常にバインドパラメータのままなので SQL インジェク
            // ションは構造的に不可能。cardIds は DB 由来の UUID(16進+ハイフン)
            // でカンマを含まず、区切りが曖昧になることもない。
            const rows = await sql<{ result: unknown }[]>`
              select get_issued_card_counts(
                p_card_ids => string_to_array(${cardIds.join(',')}, ',')::uuid[]
              ) as result
            `
            return rows[0]?.result
          },
          'gacha:executeGacha:issuedCounts(pg)',
          // 読み取り専用(migration 00069 で STABLE 宣言)のため冪等としてリトライを
          // opt-in する。リトライ回数・バックオフは既存 postgrest 経路の withRetry
          // (オプション未指定)と同じ既定値([100,300,1000]ms・最大3回)で特性が揃う。
          { idempotent: true },
        )
        return ok(parseIssuedCardCountsRpc(rpcData))
      } catch (error) {
        if (!isPgFunctionNotFoundError(error)) {
          // 既存 postgrest 経路の非 42883 エラーと同じ外部挙動(`Database error:`
          // プレフィックスの err)に揃える。
          return err(`Database error: ${error instanceof Error ? error.message : String(error)}`)
        }
        // 42883 = RPC 未デプロイのデプロイ窓。異常時は本番実績のある既存経路へ
        // 逃がす方針(#573、executeGachaTransactionRpcPg と同じ判断)に従い、下の
        // 既存 postgrest 実装へフォールスルーする。既存実装は自身の 42883
        // フォールバック(select+in→JS 集計)を持つため最終的に旧来の集計へ到達
        // する。PostgREST rpc の1往復が余分に挟まるが、マイグレーション未適用の
        // 過渡期にのみ発生する一時状態であり、select+in 集計ロジックをここへ
        // 複製する(恒久的な重複コード)より安全と判断した。
        logger.warn('get_issued_card_counts pg path unavailable (42883), falling back to postgrest path', {
          cardCount: cardIds.length,
        })
      }
    }

    const { data: rpcData, error: rpcError } = await withRetry(
      () => this.supabase.rpc('get_issued_card_counts', { p_card_ids: cardIds }),
      'gacha:executeGacha:issuedCounts',
    )

    if (!rpcError) {
      return ok(parseIssuedCardCountsRpc(rpcData))
    }

    if (rpcError.code !== '42883') {
      return err(`Database error: ${rpcError.message}`)
    }

    logger.warn('get_issued_card_counts not deployed, falling back to per-row aggregation', {
      cardCount: cardIds.length,
    })

    const { data: issuedRows, error: issuedError } = await this.supabase
      .from('user_cards')
      .select('card_id')
      .in('card_id', cardIds)

    if (issuedError) {
      return err(`Database error: ${issuedError.message}`)
    }

    const issuedCounts = new Map<string, number>()
    for (const row of issuedRows || []) {
      const cardId = (row as { card_id?: string }).card_id
      if (!cardId) continue
      issuedCounts.set(cardId, (issuedCounts.get(cardId) || 0) + 1)
    }
    return ok(issuedCounts)
  }

  /**
   * 抽選プールから1枚選択し、返却/RPC送信用に再構築したカードを返す。
   * executeGacha の初回選択と、limit_reached 時の再抽選(R1: PR #450
   * follow-up)の両方から呼ばれる共通ロジック。呼び出しごとに(縮小した)
   * プールを渡すことで、pack-scoped 自動配分の effectiveWeight もその都度
   * プール全体で再計算され、正しく再正規化される(normalizeDropRate による
   * 型保証含め、executeGacha 直書き時と同じ挙動を維持)。
   *
   * プールが空、または全カードの選択重みが0で選択不能な場合は null を返す。
   */
  private selectCardFromPool<
    T extends {
      id: string
      name: string
      description: string | null
      image_url: string | null
      rarity: GachaCard['rarity']
      drop_rate: unknown
      max_issuance_count?: number | null
      intra_rarity_weight?: number | null
    }
  >(pool: T[], resolvedRarityWeights: Record<string, number> | null): GachaCard | null {
    if (pool.length === 0) {
      return null
    }

    // drop_rate の正規化(DECIMAL文字列→number)は選択方式に関わらず必ず先に
    // 通す。返却カードの再構築(下記)もこの正規化済み配列を参照することで、
    // 生 rows の文字列 drop_rate が GachaResult/broadcast へ漏れないようにする
    // (従来は selectWeightedCard の戻り値=正規化済みクローンをそのまま返して
    // いたため保証されていた性質。再構築方式でも同じ保証を維持する)。
    const normalizedCards = normalizeDropRate(pool)

    // 選択プールは「id + 選択重み」だけの最小型に落とす(WeightedCard)。
    // 両分岐の配列型が異なるユニオンのままだと selectWeightedCard の
    // ジェネリック推論が単一の T を選べないため、明示的に共通型へ寄せる。
    const selectionPool: Array<{ id: string; drop_rate: number }> = resolvedRarityWeights
      ? computeEffectiveWeights(normalizedCards, resolvedRarityWeights).map(({ card, effectiveWeight }) => ({
          id: card.id,
          drop_rate: effectiveWeight,
        }))
      : normalizedCards

    const picked = selectWeightedCard(selectionPool)

    if (!picked) {
      return null
    }

    // 選択には effectiveWeight (パック内実効重み) を drop_rate の代わりに
    // 使うことがあるが、返す値・下流に渡す値は必ず元カード(正規化済み)から
    // 再構築する。effectiveWeight は選択専用の一時的な重みであり実際の
    // drop_rate とは異なる値になりうるため、gacha_history や配信オーバーレイ
    // へのブロードキャストペイロードに漏れてはならない。intra_rarity_weight も
    // GachaCard 型に存在しないフィールドなので同様に除外する。
    const originalCard = normalizedCards.find((card) => card.id === picked.id)
    if (!originalCard) {
      return null
    }

    return {
      id: originalCard.id,
      name: originalCard.name,
      description: originalCard.description,
      image_url: originalCard.image_url,
      rarity: originalCard.rarity,
      drop_rate: originalCard.drop_rate,
      // Issue #108: legacy フォールバック(executeGachaLegacy)が発行上限の
      // 再チェックに参照するため、再構築後も必ず引き継ぐ。
      max_issuance_count: originalCard.max_issuance_count ?? null,
    }
  }

  /**
   * Issue #512: N連ドロー(executeGachaDraws)の [eventId, eventId:2, ...] のうち、
   * 先頭から連続して何件が既に gacha_history に存在する(=完了済みである)かを
   * 数える。EventSub再送(redelivery)がバッチ途中までしか完了していない
   * ドローのリトライを兼ねるケースで、どこから再開すべきかを判定するために使う。
   *
   * event_id は migration 00001 で TEXT UNIQUE(グローバルに一意)なので、
   * 単純な IN 句の存在チェックだけで安全に判定できる(排他ロックは不要 —
   * 既にCOMMIT済みの行を読むだけで書き込みとは競合しない)。「先頭から連続」で
   * カウントを打ち切るのは、ドローループが index=0 から順番にしか進まないため
   * 通常は歯抜けが起きない前提の下、万一歯抜けがあってもそこで止めて以降を
   * 未完了扱いにする(実際には完了していない枠を誤ってスキップしない)安全側の
   * 判定にするため。
   */
  private async countCompletedDrawPrefix(eventId: string, drawCount: number): Promise<Result<number>> {
    const candidateEventIds = Array.from(
      { length: drawCount },
      (_, index) => buildDrawEventId(eventId, index) as string
    )

    const { data, error } = await withRetry(
      () => this.supabase
        .from('gacha_history')
        .select('event_id')
        .in('event_id', candidateEventIds),
      'gacha:executeGachaDraws:completedPrefix',
    )

    if (error) {
      return err(`Database error: ${error.message}`)
    }

    const completedEventIds = new Set(
      (data ?? []).map((row) => (row as { event_id: string | null }).event_id)
    )
    let prefixCount = 0
    while (prefixCount < drawCount && completedEventIds.has(candidateEventIds[prefixCount])) {
      prefixCount += 1
    }
    return ok(prefixCount)
  }

  private async executeGachaDraws(
    streamerId: string,
    userTwitchId: string,
    userTwitchUsername: string,
    drawCount: number,
    eventId?: string,
    rewardCost?: number,
    // Issue #393: pack scope forwarded to each individual draw.
    collectionName?: string | null,
    // Issue #579 (#576 フェーズ2): 各ドローに同じ重み設定を forward する
    // (複数枚ドローでも同じレアリティ配分を一貫して適用するため)。
    weightsConfig?: RarityWeightsDrawConfig,
    // Issue #591: 各ドローに同じ報酬IDを forward する。rewardCost(下記
    // drawRewardCost)とは異なり index===0 に限定しない — reward_cost は
    // 「引換1回で消費した合計ポイント数」なので1件だけに紐付けるが、
    // reward_id は「どの報酬から起点になったガチャか」というN連の全カード
    // 共通の属性であり、ポーリング経路(events API)は履歴行ごとに独立して
    // サウンドルールを判定する(pickSoundBearingCardIndexへ1件ずつ渡す)ため、
    // 1枚目以外が reward_id=null のままだと2枚目以降だけ報酬別ルールが
    // 発火しないバグになる。
    rewardId?: string | null
  ): Promise<Result<GachaResult>> {
    const cards: GachaCard[] = []
    let firstResult: GachaResult | null = null

    // Issue #512: EventSub再送がバッチ途中(例: 5連中2枚目まで成功、3枚目で
    // 失敗)のリトライを兼ねる場合、常に index=0 からやり直すと1枚目が
    // is_duplicate と判定された時点でバッチ全体を「重複だから何もしない」と
    // 打ち切ってしまい、3枚目以降が永久に実行されないバグがあった(下記
    // resumeFromIndex 起点のループで解消)。単発ドロー(drawCount<=1)は
    // 「1枚目のis_duplicate=バッチ全体が重複」が常に正しくこの問題が起きない
    // ため、追加クエリも不要(ホットパスである単発ガチャに毎回1クエリ増える
    // 無駄を避ける)。
    let resumeFromIndex = 0
    if (eventId && drawCount > 1) {
      const prefixResult = await this.countCompletedDrawPrefix(eventId, drawCount)
      if (!prefixResult.success) {
        return err(prefixResult.error)
      }
      resumeFromIndex = prefixResult.data

      // 全ドローが既に完了済み = 設定変更を挟まない通常のEventSub再送
      // (完全な重複)。呼び出し元は単発ドローの is_duplicate と同じ
      // 'Duplicate event' を「正常系・再通知不要」として静かにスキップする
      // 既存分岐を持つため、同じ文言を返して単発ドローと観測可能な挙動を揃える。
      if (resumeFromIndex >= drawCount) {
        return err('Duplicate event')
      }
    }

    for (let index = resumeFromIndex; index < drawCount; index += 1) {
      const drawEventId = buildDrawEventId(eventId, index)
      const drawRewardCost = index === 0 ? rewardCost : undefined
      const result = await this.executeGacha(
        streamerId,
        userTwitchId,
        userTwitchUsername,
        drawEventId,
        drawRewardCost,
        collectionName,
        weightsConfig,
        rewardId
      )

      if (!result.success) {
        // resumeFromIndex(過去のリトライで既に完了した分)も合わせた、この
        // バッチ全体での確定済み枚数。cards.length だけで判定すると、再開
        // 直後の1件目で早速エラーになった場合に「0枚成功」扱いになり、実際は
        // resumeFromIndex 枚が既に確定済みであるにもかかわらず生の
        // soldOut/DBエラーがそのまま呼び出し元に伝播してしまう(soldOut側の
        // 全額返還処理などが、既に一部カードを受け取ったユーザーに対して
        // 誤って走りかねない)。
        const totalCompleted = resumeFromIndex + cards.length
        if (totalCompleted > 0 && result.error !== 'Duplicate event') {
          logger.warn('Multi-draw gacha stopped after partial success', {
            streamerId,
            userTwitchId,
            eventId,
            resumedFromIndex: resumeFromIndex,
            completedDraws: totalCompleted,
            requestedDraws: drawCount,
            error: result.error,
          })
          // Issue #512: 以前はここで break し、firstResult があれば ok(部分的な
          // cards配列)を返していた。呼び出し元はこれを「N連が要求どおり完了
          // した」結果と区別できず、視聴者はチャネルポイントを消費したのに
          // 一部カードしか受け取れないまま何のエラーも報告されなかった
          // (通知の drawCount 表示も cards.length にフォールバックするため、
          // 要求連数より少ない結果がそのまま「成功」として表示されてしまう)。
          // エラーを返して呼び出し元の reportError 経路に乗せる。既に成功
          // した分は gacha_history 上ロールバックしない(取り消す手段が
          // なく、ユーザーは既にカードを受け取っているため取り消すべきでも
          // ない)ため、EventSub再送があれば上の resumeFromIndex 起点の
          // 再開ロジックにより残りだけ再試行される。
          return err(
            `Partial gacha completion: ${totalCompleted}/${drawCount} draws succeeded before error: ${result.error}`
          )
        }
        return result
      }

      cards.push(result.data.card)
      firstResult ??= result.data
    }

    if (!firstResult) {
      return err('Failed to execute gacha draws')
    }

    return ok({
      ...firstResult,
      cards,
    })
  }

  /**
   * RPC関数未デプロイ時のフォールバック: 旧ロジック（個別DB操作）でガチャを実行
   * マイグレーション適用前のデプロイ中間状態でユーザーへのカード未付与を防ぐ
   * アトミック性は保証されないが、カード付与されないよりは良い
   * TODO: マイグレーション適用確認後にこのメソッドを削除
   */
  private async executeGachaLegacy(
    streamerId: string, userTwitchId: string, userTwitchUsername: string,
    selectedCard: GachaCard, eventId?: string, rewardCost?: number
  ): Promise<Result<GachaResult>> {
    // Legacy パスは execute_gacha_transaction RPC が未デプロイの一時的状態のためのフォールバック。
    // この経路では FOR UPDATE による行ロックが取れず、発行枚数チェックと INSERT を
    // アトミックに実行できないため、上限超過の race condition を防げない。
    // よって発行可能枚数 (max_issuance_count) が設定されたカードは legacy パスでは抽選対象外とする。
    // limited カードは migration 適用後の RPC パス経由でのみ付与可能。
    // The legacy fallback runs only while execute_gacha_transaction is missing on the DB.
    // Without FOR UPDATE row locking we cannot enforce issuance limits atomically here,
    // so refuse to issue limited cards via this path to avoid over-issuing.
    //
    // R2 (PR #450 レビュー follow-up): この拒否は「本物の soldOut (発行枚数上限に
    // 到達済み)」とは全く別の異常系(RPC関数が本番に存在しない = マイグレーション
    // 未適用のはずが後続コードだけ先にデプロイされた不整合状態)である。以前は
    // soldOut と同一の文字列を返していたため、eventsub route.ts のソフトフェイル
    // 抑止フィルタ(発行枚数上限到達は運用上正常なので reportError しない)に巻き
    // 込まれ、この深刻な不整合が本番で一切アラートされなかった。専用の
    // limitUnavailable を返すことで、genuine soldOut の抑止は維持したまま、この
    // ケースだけ確実に reportError が発火するようにする。
    if (selectedCard.max_issuance_count !== null && selectedCard.max_issuance_count !== undefined) {
      logger.warn('Legacy fallback: refused to issue limited card (RPC not deployed yet)', {
        streamerId, userTwitchId, eventId, cardId: selectedCard.id,
      })
      return err(CARD_ISSUANCE_MESSAGES.limitUnavailable)
    }

    // gacha_history upsert（冪等性のためevent_idで重複チェック）
    //
    // Issue #591: ここでは意図的に reward_id を書き込まない。この legacy パスに
    // 到達するのは execute_gacha_transaction RPC が 42883 (未デプロイ) の場合のみ
    // で、gacha_history.reward_id 列と当該RPCは同一migrationファイル(00070)で
    // アトミックに追加されるため、RPCが無い=列も無い状態が保証される。ここで
    // reward_id キーを含めると、PostgREST の書き込み経路は列不在を PGRST204
    // として返す — つまり「RPC未デプロイ時の安全弁」であるこの legacy パス
    // 自体を、列追加のせいで壊してしまう。ポーリング経路の報酬別サウンドは
    // このデプロイ窓の間だけ rarity/all ルールにフォールバックする(=許容範囲)。
    const { error: historyError } = await this.supabase
      .from('gacha_history')
      .upsert({
        event_id: eventId || null,
        user_twitch_id: userTwitchId,
        user_twitch_username: userTwitchUsername,
        card_id: selectedCard.id,
        streamer_id: streamerId,
        reward_cost: rewardCost ?? null,
      }, {
        onConflict: 'event_id',
        ignoreDuplicates: true,
      })

    if (historyError) {
      return err(`Failed to record history: ${historyError.message}`)
    }

    // users upsert
    const { data: user } = await this.supabase
      .from('users')
      .upsert({
        twitch_user_id: userTwitchId,
        twitch_username: userTwitchUsername,
        twitch_display_name: userTwitchUsername,
      }, {
        onConflict: 'twitch_user_id',
        ignoreDuplicates: true,
      })
      .select('id')
      .maybeSingle()

    // user_cards insert
    if (user) {
      const { error: collectionError } = await this.supabase
        .from('user_cards')
        .insert({
          user_id: user.id,
          card_id: selectedCard.id,
          obtained_at: new Date().toISOString(),
        })

      if (collectionError && collectionError.code !== '23505') {
        logger.warn('Legacy fallback: Failed to add to collection:', collectionError.message)
      }
    }

    return ok({ card: selectedCard, userTwitchUsername })
  }

  /**
   * Execute gacha for EventSub channel point redemption
   * Checks both main reward and additional rewards for matching reward ID.
   * Streamer query includes chat announcement settings to avoid a second query in route.ts.
   *
   * EventSubチャネルポイント引き換え用のガチャ実行
   * メイン報酬と追加報酬の両方で報酬IDの一致をチェック。
   * route.ts での2回目のクエリを排除するため、チャット通知設定も同時に取得する。
   */
  async executeGachaForEventSub(
    event: {
      broadcaster_user_id: string
      user_id: string
      user_login: string
      user_name: string
      reward: { id: string; cost?: number }
    },
    eventId?: string
  ): Promise<Result<GachaResult>> {
    try {
      // chat_announcement_enabled/template も同時取得してクエリ統合（CPU時間削減）
      // rarity_weights / rarity_weights_scope / pack_rarity_weights は Issue #579
      // (#576 フェーズ2) のパック内レアリティ自動配分に使う。
      // default_card_pack_name (migration 00063, Issue #554) は {packName} プレースホルダで
      // デフォルト(未分類)パックの表示名オーバーライドとして使う(Issue #597)。
      let { data: streamer, error: streamerError } = await withRetry(
        () => this.supabase
          .from('streamers')
          .select('id, channel_point_reward_id, channel_point_collection_name, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until, rarity_weights, rarity_weights_scope, pack_rarity_weights, default_card_pack_name')
          .eq('twitch_user_id', event.broadcaster_user_id)
          .maybeSingle(),
        'gacha:executeGachaForEventSub:streamer',
      )

      // Issue #579 (#576 フェーズ2): rarity_weights_scope / pack_rarity_weights は
      // migration 00065(#578)で追加された列で、channel_point_collection_name
      // (00061)より後発のため、この2列だけが欠落し他の列は揃っている状態が
      // 現実的な唯一のデプロイ窓シナリオ(逆に collection_name だけが欠落する
      // ケースでは、より後発のこの2列も必然的に欠落している)。両者は同一
      // マイグレーションファイルで追加され常に一緒にデプロイされるため、
      // 既存の1列ずつ剥がすチェイン方式ではなく1回のリトライにまとめる。
      // rarity_weights (安定した既存列, migration 00025) は保持したまま
      // 再取得する。欠落時は rarity_weights_scope=null
      // (resolveRarityWeightsForPool は null/undefined を 'global' として扱う)
      // / pack_rarity_weights=null (パック別上書きなし) を安全側デフォルトとする。
      if (
        streamerError &&
        (isMissingRarityWeightsScopeColumnError(streamerError) || isMissingPackRarityWeightsColumnError(streamerError))
      ) {
        // default_card_pack_name (00063) は rarity_weights_scope/pack_rarity_weights
        // (00065) より先行するマイグレーションのため、この分岐に来る時点で確実に
        // デプロイ済み。選択して問題ない。
        const weightsFallback = await withRetry(
          () => this.supabase
            .from('streamers')
            .select('id, channel_point_reward_id, channel_point_collection_name, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until, rarity_weights, default_card_pack_name')
            .eq('twitch_user_id', event.broadcaster_user_id)
            .maybeSingle(),
          'gacha:executeGachaForEventSub:streamer:weights-fallback',
        )
        streamer = weightsFallback.data
          ? { ...weightsFallback.data, rarity_weights_scope: null, pack_rarity_weights: null }
          : weightsFallback.data
        streamerError = weightsFallback.error
      }

      // Issue #393: targeted fallback when ONLY channel_point_collection_name is
      // missing (00061 deploy window). Re-select WITHOUT that column but WITH all
      // the other columns intact — crucially raid_gacha_active_until — so that
      // raid-limited rewards are NOT wrongly skipped (which would consume channel
      // points without running gacha). Runs before the broad
      // isStreamerSettingsSchemaError fallback, which would otherwise null out
      // raid_gacha_active_until. 列が複数欠落していれば後続の広域 fallback が拾う。
      // rarity_weights_scope/pack_rarity_weights はこの分岐に来る時点で確実に
      // 未デプロイ(上のコメント参照)なので選択せず null 固定にする。
      if (streamerError && isMissingCollectionNameColumn(streamerError)) {
        const collectionFallback = await withRetry(
          () => this.supabase
            .from('streamers')
            .select('id, channel_point_reward_id, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until, rarity_weights')
            .eq('twitch_user_id', event.broadcaster_user_id)
            .maybeSingle(),
          'gacha:executeGachaForEventSub:streamer:collection-fallback',
        )
        streamer = collectionFallback.data
          ? {
              ...collectionFallback.data,
              channel_point_collection_name: null,
              rarity_weights_scope: null,
              pack_rarity_weights: null,
              // default_card_pack_name (00063) は channel_point_collection_name (00061)
              // より後発のマイグレーションのため、この分岐に来る時点で確実に未デプロイ。
              // 選択せず null 固定にする(Issue #597)。
              default_card_pack_name: null,
            }
          : collectionFallback.data
        streamerError = collectionFallback.error
      }

      if (isStreamerSettingsSchemaError(streamerError)) {
        const fallbackResult = await withRetry(
          () => this.supabase
            .from('streamers')
            .select('id, channel_point_reward_id, chat_announcement_enabled, chat_announcement_template')
            .eq('twitch_user_id', event.broadcaster_user_id)
            .maybeSingle(),
          'gacha:executeGachaForEventSub:streamer:fallback',
        )
        streamer = fallbackResult.data
          ? {
              ...fallbackResult.data,
              // 列未デプロイ時は全カード対象 (NULL) として扱う
              channel_point_collection_name: null,
              chat_announcement_multi_template: null,
              chat_announcement_multi_show_cards: true,
              raid_gacha_active_until: null,
              // Issue #579: この分岐も同じ理由でレアリティ重み列は未取得のため
              // 手動モード相当(rarity_weights=null)に倒す。
              rarity_weights: null,
              rarity_weights_scope: null,
              pack_rarity_weights: null,
              // Issue #597: この分岐は channel_point_collection_name(00061)より
              // 前段の欠落まで拾う最も古いフォールバックのため、default_card_pack_name
              // (00063)も確実に未デプロイ。選択せず null 固定にする。
              default_card_pack_name: null,
            }
          : fallbackResult.data
        streamerError = fallbackResult.error
      }

      if (streamerError) {
        return err(`Database error fetching streamer: ${streamerError.message}`)
      }

      if (!streamer) {
        return err('Streamer not found')
      }

      // ガチャ実行用のヘルパー: 結果にストリーマー情報を付加して返す
      // Issue #393: collectionName を受け取り、指定パックに抽選対象を絞る
      const executeAndAttachStreamer = async (
        drawCount = 1,
        collectionName?: string | null
      ): Promise<Result<GachaResult>> => {
        const result = await this.executeGachaDraws(
          streamer.id,
          event.user_id,
          event.user_name,
          drawCount,
          eventId,
          event.reward.cost,
          collectionName,
          {
            rarityWeightsScope: streamer.rarity_weights_scope,
            rarityWeights: streamer.rarity_weights,
            packRarityWeights: streamer.pack_rarity_weights,
          },
          // Issue #591: gacha_history.reward_id に永続化するため、実際に
          // マッチした報酬ID(メイン報酬 or 追加報酬、いずれも event.reward.id
          // は同一のEventSub通知由来)をそのまま forward する。
          event.reward.id
        )
        if (!result.success) return result
        return ok({
          ...result.data,
          rewardId: event.reward.id,
          // Issue #597: {packName} プレースホルダ解決用に、この抽選が絞られた
          // パックの collection_name をそのまま結果に持たせる。
          collectionName: collectionName ?? null,
          streamer: {
            id: streamer.id,
            chat_announcement_enabled: streamer.chat_announcement_enabled,
            chat_announcement_template: streamer.chat_announcement_template,
            chat_announcement_multi_template: streamer.chat_announcement_multi_template,
            chat_announcement_multi_show_cards: streamer.chat_announcement_multi_show_cards ?? true,
            default_card_pack_name: streamer.default_card_pack_name ?? null,
          },
        })
      }

      // Check if the reward ID matches the main reward
      // メイン報酬のIDと一致するかチェック
      if (streamer.channel_point_reward_id === event.reward.id) {
        // Issue #393: メイン報酬に紐付くパックで抽選対象を絞る
        return await executeAndAttachStreamer(1, streamer.channel_point_collection_name)
      }

      // Check if the reward ID matches any additional reward
      // 追加報酬のいずれかと一致するかチェック
      let { data: additionalReward, error: additionalError } = await withRetry(
        () => this.supabase
          .from('streamer_additional_gacha_rewards')
          .select('id, draw_count, is_raid_limited, collection_name')
          .eq('streamer_id', streamer.id)
          .eq('reward_id', event.reward.id)
          .maybeSingle(),
        'gacha:executeGachaForEventSub:additionalReward',
      )

      // Deploy-window fallback: only the collection_name column is missing.
      // Handled separately from raid-option errors so we don't needlessly block
      // the additional reward gacha (it just falls back to "all cards").
      // collection_name 列のみ未デプロイなら null fallback（追加報酬ガチャは止めない）。
      if (additionalError && isMissingCollectionNameColumn(additionalError)) {
        const fallbackResult = await withRetry(
          () => this.supabase
            .from('streamer_additional_gacha_rewards')
            .select('id, draw_count, is_raid_limited')
            .eq('streamer_id', streamer.id)
            .eq('reward_id', event.reward.id)
            .maybeSingle(),
          'gacha:executeGachaForEventSub:additionalReward:collection-fallback',
        )
        additionalReward = fallbackResult.data
          ? { ...fallbackResult.data, collection_name: null }
          : fallbackResult.data
        additionalError = fallbackResult.error
      }

      if (isRaidOptionsSchemaError(additionalError)) {
        logger.warn('Additional reward options schema is unavailable; refusing to execute a 1-draw fallback', {
          rewardId: event.reward.id,
          streamerId: streamer.id,
          error: additionalError?.message,
        })
        return err(ADDITIONAL_REWARD_OPTIONS_UNAVAILABLE)
      }

      // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
      if (additionalError) {
        logger.warn(`Error checking additional reward: ${additionalError.message}`)
        return err(`Database error checking additional reward: ${additionalError.message}`)
      }

      if (additionalReward) {
        if (additionalReward.is_raid_limited && !isRaidGachaActive(streamer.raid_gacha_active_until)) {
          logger.info('Raid-limited gacha skipped because raid gacha is inactive', {
            rewardId: event.reward.id,
            streamerId: streamer.id,
            raidGachaActiveUntil: streamer.raid_gacha_active_until,
          })
          return err('Raid-limited reward inactive')
        }

        // Additional reward matched, execute gacha
        // 追加報酬が一致したのでガチャを実行
        const drawCount = Math.min(Math.max(Number(additionalReward.draw_count ?? 1), 1), 10)
        logger.info(`Gacha triggered by additional reward: rewardId=${event.reward.id}, streamerId=${streamer.id}, drawCount=${drawCount}, raidLimited=${Boolean(additionalReward.is_raid_limited)}, collectionName=${additionalReward.collection_name ?? 'all'}`)
        // Issue #393: 追加報酬に紐付くパックで抽選対象を絞る
        return await executeAndAttachStreamer(drawCount, additionalReward.collection_name)
      }

      return err('Reward ID mismatch')
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }

  async executeGachaForRaidEvent(
    event: {
      to_broadcaster_user_id: string
      from_broadcaster_user_id: string
      from_broadcaster_user_login?: string
      from_broadcaster_user_name?: string
    },
    eventId?: string
  ): Promise<Result<GachaResult>> {
    try {
      let { data: streamer, error: streamerError } = await this.supabase
        .from('streamers')
        .select('id, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_draw_count')
        .eq('twitch_user_id', event.to_broadcaster_user_id)
        .maybeSingle()

      if (isStreamerSettingsSchemaError(streamerError)) {
        const fallbackResult = await this.supabase
          .from('streamers')
          .select('id, chat_announcement_enabled, chat_announcement_template')
          .eq('twitch_user_id', event.to_broadcaster_user_id)
          .maybeSingle()
        streamer = fallbackResult.data
          ? {
              ...fallbackResult.data,
              chat_announcement_multi_template: null,
              chat_announcement_multi_show_cards: true,
              raid_gacha_draw_count: 0,
            }
          : fallbackResult.data
        streamerError = fallbackResult.error
      }

      if (streamerError || !streamer) {
        return err('Streamer not found')
      }

      const drawCount = Math.min(Math.max(Number(streamer.raid_gacha_draw_count ?? 0), 0), 10)
      if (drawCount < 1) {
        return err('Raid gacha disabled')
      }

      const userName = event.from_broadcaster_user_name || event.from_broadcaster_user_login || event.from_broadcaster_user_id
      const result = await this.executeGachaDraws(
        streamer.id,
        event.from_broadcaster_user_id,
        userName,
        drawCount,
        eventId,
        undefined
      )

      if (!result.success) return result

      return ok({
        ...result.data,
        streamer: {
          id: streamer.id,
          chat_announcement_enabled: streamer.chat_announcement_enabled,
          chat_announcement_template: streamer.chat_announcement_template,
          chat_announcement_multi_template: streamer.chat_announcement_multi_template,
          chat_announcement_multi_show_cards: streamer.chat_announcement_multi_show_cards ?? true,
        },
      })
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }
}
