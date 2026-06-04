import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { normalizeDropRate } from '@/lib/card-utils'
import { Result, ok, err } from '@/types/result'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'
import { withRetry } from '@/lib/supabase/retry'
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError } from '@/lib/card-issuance'

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
}

function isRaidGachaActive(activeUntil: string | null | undefined, now = new Date()): boolean {
  if (!activeUntil) return false
  const activeUntilTime = Date.parse(activeUntil)
  return Number.isFinite(activeUntilTime) && activeUntilTime > now.getTime()
}

export class GachaService {
  private supabase = getSupabaseAdmin()

  async executeGacha(streamerId: string, userTwitchId: string, userTwitchUsername: string, eventId?: string, rewardCost?: number): Promise<Result<GachaResult>> {
    try {
      // Get active cards for this streamer
      // このストリーマーの有効なカードを取得
      let { data: cards, error: cardsError } = await withRetry(
        () => this.supabase
          .from('cards')
          .select('id, name, description, image_url, rarity, drop_rate, max_issuance_count')
          .eq('streamer_id', streamerId)
          .eq('is_active', true),
        'gacha:executeGacha:cards',
      )

      if (cardsError && isMissingCardIssuanceColumnError(cardsError)) {
        const fallbackResult = await withRetry(
          () => this.supabase
            .from('cards')
            .select('id, name, description, image_url, rarity, drop_rate')
            .eq('streamer_id', streamerId)
            .eq('is_active', true),
          'gacha:executeGacha:cards:fallback',
        )
        cards = fallbackResult.data?.map((card) => ({
          ...card,
          max_issuance_count: null,
        })) ?? null
        cardsError = fallbackResult.error
      }

      if (cardsError) {
        return err(`Database error: ${cardsError.message}`)
      }

      if (!cards || cards.length === 0) {
        return err('No cards available for this streamer')
      }

      const cardIds = cards.map((card) => card.id)
      const limitedCards = cards.filter((card) => card.max_issuance_count !== null && card.max_issuance_count !== undefined)
      let availableCards = cards
      if (limitedCards.length > 0) {
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

        availableCards = cards.filter((card) => {
          if (card.max_issuance_count === null || card.max_issuance_count === undefined) return true
          return (issuedCounts.get(card.id) || 0) < card.max_issuance_count
        })
      }

      if (availableCards.length === 0) {
        return err(CARD_ISSUANCE_MESSAGES.soldOut)
      }

      // Select a card based on drop rates
      // ドロップ率に基づいてカードを選択
      const selectedCard = selectWeightedCard(normalizeDropRate(availableCards))

      if (!selectedCard) {
        return err('Failed to select card')
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
    rewardCost?: number
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
        drawRewardCost
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
      let { data: streamer, error: streamerError } = await withRetry(
        () => this.supabase
          .from('streamers')
          .select('id, channel_point_reward_id, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until')
          .eq('twitch_user_id', event.broadcaster_user_id)
          .maybeSingle(),
        'gacha:executeGachaForEventSub:streamer',
      )

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
              chat_announcement_multi_template: null,
              chat_announcement_multi_show_cards: true,
              raid_gacha_active_until: null,
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
      const executeAndAttachStreamer = async (drawCount = 1): Promise<Result<GachaResult>> => {
        const result = await this.executeGachaDraws(
          streamer.id,
          event.user_id,
          event.user_name,
          drawCount,
          eventId,
          event.reward.cost
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
      }

      // Check if the reward ID matches the main reward
      // メイン報酬のIDと一致するかチェック
      if (streamer.channel_point_reward_id === event.reward.id) {
        return await executeAndAttachStreamer()
      }

      // Check if the reward ID matches any additional reward
      // 追加報酬のいずれかと一致するかチェック
      const { data: additionalReward, error: additionalError } = await withRetry(
        () => this.supabase
          .from('streamer_additional_gacha_rewards')
          .select('id, draw_count, is_raid_limited')
          .eq('streamer_id', streamer.id)
          .eq('reward_id', event.reward.id)
          .maybeSingle(),
        'gacha:executeGachaForEventSub:additionalReward',
      )

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
        logger.info(`Gacha triggered by additional reward: rewardId=${event.reward.id}, streamerId=${streamer.id}, drawCount=${drawCount}, raidLimited=${Boolean(additionalReward.is_raid_limited)}`)
        return await executeAndAttachStreamer(drawCount)
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
