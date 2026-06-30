import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { normalizeDropRate } from '@/lib/card-utils'
import { Result, ok, err } from '@/types/result'
import { logger } from '@/lib/logger'
import { reportError } from '@/lib/sentry/error-handler'
import { withRetry } from '@/lib/supabase/retry'
import { isMissingCollectionNameColumn } from '@/lib/collections/collection-existence'

export interface GachaCard {
  id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  drop_rate: number
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
    collectionName?: string | null
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
      const fetchCards = () => {
        let query = this.supabase
          .from('cards')
          .select('id, name, description, image_url, rarity, drop_rate')
          .eq('streamer_id', streamerId)
          .eq('is_active', true)

        if (collectionName) {
          query = query.eq('collection_name', collectionName)
        }

        return query
      }

      const { data: cards, error: cardsError } = await withRetry(
        fetchCards,
        'gacha:executeGacha:cards',
      )

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

      // Select a card based on drop rates
      // ドロップ率に基づいてカードを選択
      const selectedCard = selectWeightedCard(normalizeDropRate(cards))

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
    collectionName?: string | null
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
        collectionName
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
          .select('id, channel_point_reward_id, channel_point_collection_name, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until')
          .eq('twitch_user_id', event.broadcaster_user_id)
          .maybeSingle(),
        'gacha:executeGachaForEventSub:streamer',
      )

      // Issue #393: targeted fallback when ONLY channel_point_collection_name is
      // missing (00061 deploy window). Re-select WITHOUT that column but WITH all
      // the other columns intact — crucially raid_gacha_active_until — so that
      // raid-limited rewards are NOT wrongly skipped (which would consume channel
      // points without running gacha). Runs before the broad
      // isStreamerSettingsSchemaError fallback, which would otherwise null out
      // raid_gacha_active_until. 列が複数欠落していれば後続の広域 fallback が拾う。
      if (streamerError && isMissingCollectionNameColumn(streamerError)) {
        const collectionFallback = await withRetry(
          () => this.supabase
            .from('streamers')
            .select('id, channel_point_reward_id, chat_announcement_enabled, chat_announcement_template, chat_announcement_multi_template, chat_announcement_multi_show_cards, raid_gacha_active_until')
            .eq('twitch_user_id', event.broadcaster_user_id)
            .maybeSingle(),
          'gacha:executeGachaForEventSub:streamer:collection-fallback',
        )
        streamer = collectionFallback.data
          ? { ...collectionFallback.data, channel_point_collection_name: null }
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
          collectionName
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
