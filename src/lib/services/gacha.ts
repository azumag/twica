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
      const selectedCard = selectWeightedCard(cards)

      if (!selectedCard) {
        return err('Failed to select card')
      }

      // Record gacha history (with idempotency using upsert)
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

      if (historyError) {
        return err(`Failed to record history: ${historyError.message}`)
      }

      // Check if user exists, if not create user
      let { data: user } = await this.supabase
        .from('users')
        .select('id')
        .eq('twitch_user_id', userTwitchId)
        .single()

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
        const { error: collectionError } = await this.supabase
          .from('user_cards')
          .upsert({
            user_id: user.id,
            card_id: selectedCard.id,
            obtained_at: new Date().toISOString(),
          }, {
            onConflict: 'user_id, card_id',
            ignoreDuplicates: true,
          })

        if (collectionError) {
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