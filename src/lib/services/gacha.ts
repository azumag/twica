import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import { Result, ok, err } from '@/types/result'
import type { Card } from '@/types/database'
import { logger } from '@/lib/logger'

export interface GachaResult {
  card: Card
  userTwitchUsername: string
}

export class GachaService {
  private supabase = getSupabaseAdmin()

  async executeGacha(streamerId: string, userTwitchId: string, userTwitchUsername: string): Promise<Result<GachaResult>> {
    try {
      // Get active cards for this streamer
      const { data: cards, error: cardsError } = await this.supabase
        .from('cards')
        .select('*')
        .eq('streamer_id', streamerId)
        .eq('is_active', true)

      if (cardsError) {
        return err(`Database error: ${cardsError.message}`)
      }

      if (!cards || cards.length === 0) {
        return err('No cards available for this streamer')
      }

      // Select a card based on drop rates
      const selectedCard = selectWeightedCard(cards)

      if (!selectedCard) {
        return err('Failed to select card')
      }

      // Record gacha history
      const { error: historyError } = await this.supabase
        .from('gacha_history')
        .insert({
          user_twitch_id: userTwitchId,
          user_twitch_username: userTwitchUsername,
          card_id: selectedCard.id,
          streamer_id: streamerId,
        })

      if (historyError) {
        return err(`Failed to record history: ${historyError.message}`)
      }

      // Check if user exists, if so add to their collection
      const { data: user } = await this.supabase
        .from('users')
        .select('id')
        .eq('twitch_user_id', userTwitchId)
        .single()

      if (user) {
        const { error: collectionError } = await this.supabase
          .from('user_cards')
          .insert({
            user_id: user.id,
            card_id: selectedCard.id,
          })

        if (collectionError) {
          // Log but don't fail the gacha
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
    }
  ): Promise<Result<{ card: Card; userTwitchUsername: string }>> {
    try {
      // Get streamer info
      const { data: streamer, error: streamerError } = await this.supabase
        .from('streamers')
        .select('id, channel_point_reward_id')
        .eq('twitch_user_id', event.broadcaster_user_id)
        .single()

      if (streamerError || !streamer) {
        return err('Streamer not found')
      }

      // Check if this is the configured reward
      if (streamer.channel_point_reward_id !== event.reward.id) {
        return err('Reward ID mismatch')
      }

      // Execute gacha
      const result = await this.executeGacha(streamer.id, event.user_id, event.user_name)

      if (!result.success) {
        return result
      }

      // Ensure user exists in DB
      await this.supabase
        .from('users')
        .upsert({
          twitch_user_id: event.user_id,
          twitch_username: event.user_login,
          twitch_display_name: event.user_name,
        }, {
          onConflict: 'twitch_user_id',
        })

      // Get user ID and add to collection
      const { data: user } = await this.supabase
        .from('users')
        .select('id')
        .eq('twitch_user_id', event.user_id)
        .single()

      if (user) {
        await this.supabase
          .from('user_cards')
          .insert({
            user_id: user.id,
            card_id: result.data.card.id,
          })
      }

      return ok(result.data)
    } catch (error) {
      return err(`Unexpected error: ${error}`)
    }
  }
}