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

      // Execute gacha history recording and user check in parallel to reduce CPU time
      // CPU時間削減のため、ガチャ履歴記録とユーザー確認を並列実行
      const [historyResult, userCheckResult] = await Promise.all([
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
        // Check if user exists (SELECT only, no UPDATE)
        // ユーザーの存在確認（SELECTのみ、UPDATEなし）
        this.supabase
          .from('users')
          .select('id')
          .eq('twitch_user_id', userTwitchId)
          .single()
      ])

      if (historyResult.error) {
        return err(`Failed to record history: ${historyResult.error.message}`)
      }

      // If user doesn't exist, create one
      // ユーザーが存在しない場合は作成
      let user = userCheckResult.data
      if (!user) {
        const { data: newUser, error: createError } = await this.supabase
          .from('users')
          .upsert({
            twitch_user_id: userTwitchId,
            twitch_username: userTwitchUsername,
          }, {
            onConflict: 'twitch_user_id',
            ignoreDuplicates: true,
          })
          .select('id')
          .single()

        if (createError) {
          logger.warn('Failed to create user:', createError.message)
        } else {
          user = newUser
        }
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
      // Fetch streamer (main reward ID only for backward compatibility)
      // streamerを取得（後方互換性のためメイン報酬IDのみ）
      const { data: streamer, error: streamerError } = await this.supabase
        .from('streamers')
        .select('id, channel_point_reward_id')
        .eq('twitch_user_id', event.broadcaster_user_id)
        .single()

      if (streamerError || !streamer) {
        return err('Streamer not found')
      }

      // Check main reward ID first (most common case, no extra query)
      // まずメインの報酬IDをチェック（最も一般的なケース、追加クエリなし）
      if (streamer.channel_point_reward_id === event.reward.id) {
        return await this.executeGacha(streamer.id, event.user_id, event.user_name, eventId)
      }

      // Main reward ID doesn't match, check additional channel points
      // メインと一致しない場合のみ、追加チャネルポイントをチェック
      const isAdditionalValid = await this.checkAdditionalReward(streamer.id, event.reward.id)
      if (isAdditionalValid) {
        return await this.executeGacha(streamer.id, event.user_id, event.user_name, eventId)
      }

      return err('Reward ID mismatch')
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }

  /**
   * Check if the reward ID exists in additional channel points table
   * 追加チャネルポイントテーブルに報酬IDが存在するかチェック
   *
   * Returns false if:
   * - Table doesn't exist (migration not applied) - maintains backward compatibility
   * - No matching record found
   *
   * 以下の場合はfalseを返す:
   * - テーブルが存在しない（マイグレーション未適用）- 後方互換性を維持
   * - 一致するレコードがない
   */
  private async checkAdditionalReward(
    streamerId: string,
    eventRewardId: string
  ): Promise<boolean> {
    try {
      const { data: additionalReward, error } = await this.supabase
        .from('streamer_additional_gacha_rewards')
        .select('id')
        .eq('streamer_id', streamerId)
        .eq('reward_id', eventRewardId)
        .maybeSingle()

      // If error (e.g., table doesn't exist), return false for backward compatibility
      // エラーの場合（テーブルが存在しない等）、後方互換性のためfalseを返す
      if (error) {
        logger.warn('Additional rewards check failed (table may not exist):', error.message)
        return false
      }

      return additionalReward !== null
    } catch {
      // Any unexpected error: fall back to main reward only behavior
      // 予期しないエラー: メイン報酬のみの動作にフォールバック
      return false
    }
  }
}
