import { describe, it, expect } from 'vitest'
import { RARITY_ORDER, RARITIES, TWITCH_SUBSCRIPTION_TYPE } from '@/lib/constants'

describe('constants', () => {
  describe('RARITY_ORDER', () => {
    it('contains all rarities in correct order', () => {
      expect(RARITY_ORDER).toEqual(['legendary', 'epic', 'rare', 'common'])
    })

    it('has exactly 4 rarities', () => {
      expect(RARITY_ORDER.length).toBe(4)
    })
  })

  describe('RARITIES', () => {
    it('contains all rarity types', () => {
      const rarityValues = RARITIES.map(r => r.value)
      expect(rarityValues).toContain('common')
      expect(rarityValues).toContain('rare')
      expect(rarityValues).toContain('epic')
      expect(rarityValues).toContain('legendary')
    })

    it('has exactly 4 rarities', () => {
      expect(RARITIES.length).toBe(4)
    })
  })

  describe('TWITCH_SUBSCRIPTION_TYPE', () => {
    it('contains channel points redemption type', () => {
      expect(TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD).toBe(
        'channel.channel_points_custom_reward_redemption.add'
      )
    })

    it('has correct value format', () => {
      expect(TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD).toContain('channel')
      expect(TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD).toContain('redemption')
    })
  })
})
