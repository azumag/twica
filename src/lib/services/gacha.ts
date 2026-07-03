import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { normalizeDropRate } from '@/lib/card-utils'
import { Result, ok, err } from '@/types/result'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'
import { withRetry } from '@/lib/supabase/retry'
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
}

export interface GachaResult {
  card: GachaCard
  cards?: GachaCard[]
  userTwitchUsername: string
  rewardId?: string | null
  /** EventSub経由の場合のみ設定。クエリ統合のためガチャ結果と一緒に返す */
  streamer?: EventSubStreamerInfo
}

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? ''
  return error?.code === 'PGRST204' || message.includes('draw_count') || message.includes('is_raid_limited')
}

const ADDITIONAL_REWARD_OPTIONS_UNAVAILABLE = 'Additional reward options unavailable'

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
    weightsConfig?: RarityWeightsDrawConfig
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
        const { data: issuedRows, error: issuedError } = await this.supabase
          .from('user_cards')
          .select('card_id')
          .in('card_id', limitedCards.map((card) => card.id))

        if (issuedError) {
          return err(`Database error: ${issuedError.message}`)
        }

        const issuedCounts = new Map<string, number>()
        for (const row of issuedRows || []) {
          const cardId = (row as { card_id?: string }).card_id
          if (!cardId) continue
          issuedCounts.set(cardId, (issuedCounts.get(cardId) || 0) + 1)
        }

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

      // drop_rate の正規化(DECIMAL文字列→number)は選択方式に関わらず必ず先に
      // 通す。返却カードの再構築(下記)もこの正規化済み配列を参照することで、
      // 生 rows の文字列 drop_rate が GachaResult/broadcast へ漏れないようにする
      // (従来は selectWeightedCard の戻り値=正規化済みクローンをそのまま返して
      // いたため保証されていた性質。再構築方式でも同じ保証を維持する)。
      const normalizedCards = normalizeDropRate(availableCards)

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
        return err('Failed to select card')
      }

      // 選択には effectiveWeight (パック内実効重み) を drop_rate の代わりに
      // 使うことがあるが、返す値・下流に渡す値は必ず元カード(正規化済み)から
      // 再構築する。effectiveWeight は選択専用の一時的な重みであり実際の
      // drop_rate とは異なる値になりうるため、gacha_history や配信オーバーレイ
      // へのブロードキャストペイロードに漏れてはならない。intra_rarity_weight も
      // GachaCard 型に存在しないフィールドなので同様に除外する。
      const originalCard = normalizedCards.find((card) => card.id === picked.id)
      if (!originalCard) {
        return err('Failed to select card')
      }
      const selectedCard: GachaCard = {
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

      // gacha_history, users, user_cards を1トランザクションでアトミックに実行
      // 従来は3回の個別DB操作で中間状態（履歴あり・カード未付与）が発生しえた
      const { data: rpcResult, error: rpcError } = await withRetry(
        () => this.supabase.rpc('execute_gacha_transaction', {
          p_event_id: eventId || null,
          p_user_twitch_id: userTwitchId,
          p_user_twitch_username: userTwitchUsername,
          p_card_id: selectedCard.id,
          p_streamer_id: streamerId,
          p_reward_cost: rewardCost ?? null,
        }),
        'gacha:executeGacha:rpc',
      )

      if (rpcError) {
        // RPC関数が未デプロイの場合（マイグレーション前）は旧ロジックにフォールバック
        // 無停止デプロイ時にアプリコードが先にデプロイされても、
        // ユーザーのチャネルポイントが消費されカード未付与になることを防ぐ
        // TODO: マイグレーション適用確認後にフォールバックを削除
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
        return err(CARD_ISSUANCE_MESSAGES.soldOut)
      }

      return ok({
        card: selectedCard,
        userTwitchUsername,
      })
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
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
    weightsConfig?: RarityWeightsDrawConfig
  ): Promise<Result<GachaResult>> {
    const cards: GachaCard[] = []
    let firstResult: GachaResult | null = null

    for (let index = 0; index < drawCount; index += 1) {
      const drawEventId = eventId && index > 0 ? `${eventId}:${index + 1}` : eventId
      const drawRewardCost = index === 0 ? rewardCost : undefined
      const result = await this.executeGacha(
        streamerId,
        userTwitchId,
        userTwitchUsername,
        drawEventId,
        drawRewardCost,
        collectionName,
        weightsConfig
      )

      if (!result.success) {
        if (cards.length > 0 && result.error !== 'Duplicate event') {
          logger.warn('Multi-draw gacha stopped after partial success', {
            streamerId,
            userTwitchId,
            eventId,
            completedDraws: cards.length,
            requestedDraws: drawCount,
            error: result.error,
          })
          break
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
    if (selectedCard.max_issuance_count !== null && selectedCard.max_issuance_count !== undefined) {
      logger.warn('Legacy fallback: refused to issue limited card (RPC not deployed yet)', {
        streamerId, userTwitchId, eventId, cardId: selectedCard.id,
      })
      return err(CARD_ISSUANCE_MESSAGES.soldOut)
    }

    // gacha_history upsert（冪等性のためevent_idで重複チェック）
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
      let { data: streamer, error: streamerError } = await withRetry(
        () => this.supabase
          .from('streamers')
          .select('id, channel_point_reward_id, channel_point_collection_name, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until, rarity_weights, rarity_weights_scope, pack_rarity_weights')
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
        const weightsFallback = await withRetry(
          () => this.supabase
            .from('streamers')
            .select('id, channel_point_reward_id, channel_point_collection_name, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until, rarity_weights')
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
          }
        )
        if (!result.success) return result
        return ok({
          ...result.data,
          rewardId: event.reward.id,
          streamer: {
            id: streamer.id,
            chat_announcement_enabled: streamer.chat_announcement_enabled,
            chat_announcement_template: streamer.chat_announcement_template,
            chat_announcement_multi_template: streamer.chat_announcement_multi_template,
            chat_announcement_multi_show_cards: streamer.chat_announcement_multi_show_cards ?? true,
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
