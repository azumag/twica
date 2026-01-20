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
      console.log('[GachaService] executeGacha called:', { streamerId, userTwitchId, userTwitchUsername, eventId })

      // Get active cards for this streamer
      // このストリーマーの有効なカードを取得
      const { data: cards, error: cardsError } = await this.supabase
        .from('cards')
        .select('id, name, description, image_url, rarity, drop_rate')
        .eq('streamer_id', streamerId)
        .eq('is_active', true)

      console.log('[GachaService] Cards query:', { cardsCount: cards?.length, error: cardsError?.message })

      if (cardsError) {
        return err(`Database error: ${cardsError.message}`)
      }

      if (!cards || cards.length === 0) {
        return err('No cards available for this streamer')
      }

      // Select a card based on drop rates
      // ドロップ率に基づいてカードを選択
      const selectedCard = selectWeightedCard(cards)
      console.log('[GachaService] Selected card:', { cardId: selectedCard?.id, cardName: selectedCard?.name })

      if (!selectedCard) {
        return err('Failed to select card')
      }

      // Record gacha history (with idempotency using upsert)
      // ガチャ履歴を記録（冪等性のためupsertを使用）
      const { error: historyError } = await this.supabase
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
        })

      console.log('[GachaService] History upsert:', { error: historyError?.message })

      if (historyError) {
        return err(`Failed to record history: ${historyError.message}`)
      }

      // Check if user exists, if not create user
      // ユーザーが存在するか確認、存在しなければ作成
      let { data: user } = await this.supabase
        .from('users')
        .select('id')
        .eq('twitch_user_id', userTwitchId)
        .single()

      console.log('[GachaService] User lookup:', { found: !!user, userId: user?.id })

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

        console.log('[GachaService] User create:', { newUserId: newUser?.id, error: createError?.message })

        if (createError) {
          logger.warn('Failed to create user:', createError.message)
        } else {
          user = newUser
        }
      }

      if (user) {
        // Try insert first, if duplicate exists it will fail silently
        // まずinsertを試み、重複があれば静かに失敗する
        const { data: insertedCard, error: collectionError } = await this.supabase
          .from('user_cards')
          .insert({
            user_id: user.id,
            card_id: selectedCard.id,
            obtained_at: new Date().toISOString(),
          })
          .select()
          .single()

        console.log('[GachaService] Collection insert:', {
          userId: user.id,
          cardId: selectedCard.id,
          inserted: !!insertedCard,
          error: collectionError?.message,
          errorCode: collectionError?.code,
        })

        // Ignore duplicate key error (23505)
        // 重複キーエラー（23505）は無視
        if (collectionError && collectionError.code !== '23505') {
          logger.warn('Failed to add to collection:', collectionError.message)
        }
      }

      console.log('[GachaService] executeGacha completed successfully')
      return ok({
        card: selectedCard,
        userTwitchUsername,
      })
    } catch (error) {
      console.log('[GachaService] executeGacha error:', error)
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
      // Debug: Log event details for troubleshooting
      // デバッグ用：トラブルシューティングのためイベント詳細をログ出力
      console.log('[GachaService] executeGachaForEventSub called:', {
        broadcaster_user_id: event.broadcaster_user_id,
        user_id: event.user_id,
        reward_id: event.reward?.id,
        eventId,
      })

      const { data: streamer, error: streamerError } = await this.supabase
        .from('streamers')
        .select('id, channel_point_reward_id')
        .eq('twitch_user_id', event.broadcaster_user_id)
        .single()

      // Debug: Log streamer lookup result
      // デバッグ用：ストリーマー検索結果をログ出力
      console.log('[GachaService] Streamer lookup:', {
        found: !!streamer,
        streamer_id: streamer?.id,
        db_reward_id: streamer?.channel_point_reward_id,
        event_reward_id: event.reward?.id,
        error: streamerError?.message,
      })

      if (streamerError || !streamer) {
        return err('Streamer not found')
      }

      if (streamer.channel_point_reward_id !== event.reward.id) {
        // Debug: Log reward ID mismatch details
        // デバッグ用：リワードID不一致の詳細をログ出力
        console.log('[GachaService] Reward ID mismatch:', {
          db_reward_id: streamer.channel_point_reward_id,
          event_reward_id: event.reward.id,
          db_reward_id_type: typeof streamer.channel_point_reward_id,
          event_reward_id_type: typeof event.reward.id,
        })
        return err('Reward ID mismatch')
      }

      console.log('[GachaService] Reward ID matched, executing gacha...')
      return await this.executeGacha(streamer.id, event.user_id, event.user_name, eventId)
    } catch (error) {
      console.log('[GachaService] Unexpected error:', error)
      return err(`Unexpected error: ${error}`)
    }
  }
}