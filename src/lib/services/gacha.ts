import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { Result, ok, err } from '@/types/result'
import { logger } from '@/lib/logger'

export interface GachaCard {
  id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  drop_rate: number
}

export interface GachaResult {
  card: GachaCard
  userTwitchUsername: string
}

export class GachaService {
  private supabase = getSupabaseAdmin()

  async executeGacha(streamerId: string, userTwitchId: string, userTwitchUsername: string, eventId?: string): Promise<Result<GachaResult>> {
    try {
      // Get active cards for this streamer
      // このストリーマーの有効なカードを取得
      const { data: cards, error: cardsError } = await this.supabase
        .from('cards')
        .select('id, name, description, image_url, rarity, drop_rate')
        .eq('streamer_id', streamerId)
        .eq('is_active', true)

      if (cardsError) {
        return err(`Database error: ${cardsError.message}`)
      }

      if (!cards || cards.length === 0) {
        return err('No cards available for this streamer')
      }

      // Select a card based on drop rates
      // ドロップ率に基づいてカードを選択
      const selectedCard = selectWeightedCard(cards)

      if (!selectedCard) {
        return err('Failed to select card')
      }

      // Execute gacha history recording and user upsert in parallel to reduce CPU time
      // CPU時間削減のため、ガチャ履歴記録とユーザーupsertを並列実行
      const [historyResult, userResult] = await Promise.all([
        // Record gacha history (with idempotency using upsert)
        // ガチャ履歴を記録（冪等性のためupsertを使用）
        this.supabase
          .from('gacha_history')
          .upsert({
            event_id: eventId || null,
            user_twitch_id: userTwitchId,
            user_twitch_username: userTwitchUsername,
            card_id: selectedCard.id,
            streamer_id: streamerId,
          }, {
            onConflict: 'event_id',
            ignoreDuplicates: true,
          }),
        // Upsert user in a single query (combines check and create)
        // 1回のクエリでユーザーをupsert（確認と作成を統合）
        this.supabase
          .from('users')
          .upsert({
            twitch_user_id: userTwitchId,
            twitch_username: userTwitchUsername,
          }, {
            onConflict: 'twitch_user_id',
            ignoreDuplicates: false,
          })
          .select('id')
          .single()
      ])

      if (historyResult.error) {
        return err(`Failed to record history: ${historyResult.error.message}`)
      }

      const user = userResult.data
      if (userResult.error) {
        logger.warn('Failed to upsert user:', userResult.error.message)
      }

      if (user) {
        // Use insert instead of upsert - upsert with composite key doesn't work correctly
        // upsertではなくinsertを使用 - 複合キーでのupsertは正しく動作しない
        const { error: collectionError } = await this.supabase
          .from('user_cards')
          .insert({
            user_id: user.id,
            card_id: selectedCard.id,
            obtained_at: new Date().toISOString(),
          })

        // Ignore duplicate key error (23505)
        // 重複キーエラー（23505）は無視
        if (collectionError && collectionError.code !== '23505') {
          logger.warn('Failed to add to collection:', collectionError.message)
        }
      }

      return ok({
        card: selectedCard,
        userTwitchUsername,
      })
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }

  async executeGachaForEventSub(
    event: {
      broadcaster_user_id: string
      user_id: string
      user_login: string
      user_name: string
      reward: { id: string }
    },
    eventId?: string
  ): Promise<Result<GachaResult>> {
    try {
      const { data: streamer, error: streamerError } = await this.supabase
        .from('streamers')
        .select('id, channel_point_reward_id')
        .eq('twitch_user_id', event.broadcaster_user_id)
        .single()

      if (streamerError || !streamer) {
        return err('Streamer not found')
      }

      if (streamer.channel_point_reward_id !== event.reward.id) {
        return err('Reward ID mismatch')
      }

      return await this.executeGacha(streamer.id, event.user_id, event.user_name, eventId)
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }
}
