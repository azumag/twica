import { describe, expect, it } from 'vitest'
import { deriveEventSubStatus } from '@/components/ChannelPointSettings'

describe('deriveEventSubStatus', () => {
  it('separates reward and raid EventSub subscriptions', () => {
    const status = deriveEventSubStatus([
      {
        id: 'raid-sub',
        status: 'enabled',
        type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'streamer-1' },
      },
      {
        id: 'other-reward-sub',
        status: 'enabled',
        type: 'channel.channel_points_custom_reward_redemption.add',
        condition: { broadcaster_user_id: 'streamer-1', reward_id: 'other-reward' },
      },
    ], 'main-reward')

    expect(status).toEqual({
      rewardStatus: 'pending',
      raidStatus: 'active',
    })
  })

  it('does not let failed reward subscriptions mark raid EventSub as failed', () => {
    const status = deriveEventSubStatus([
      {
        id: 'reward-sub',
        status: 'webhook_callback_verification_failed',
        type: 'channel.channel_points_custom_reward_redemption.add',
        condition: { broadcaster_user_id: 'streamer-1', reward_id: 'main-reward' },
      },
      {
        id: 'raid-sub',
        status: 'enabled',
        type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'streamer-1' },
      },
    ], 'main-reward')

    expect(status).toEqual({
      rewardStatus: 'error',
      raidStatus: 'active',
    })
  })

  it('does not let pending raid subscriptions mark reward EventSub as pending', () => {
    const status = deriveEventSubStatus([
      {
        id: 'raid-sub',
        status: 'webhook_callback_verification_pending',
        type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'streamer-1' },
      },
    ], 'main-reward')

    expect(status).toEqual({
      rewardStatus: 'none',
      raidStatus: 'pending',
    })
  })

  it('ignores stale raid subscriptions for a different callback URL', () => {
    const status = deriveEventSubStatus([
      {
        id: 'old-raid-sub',
        status: 'enabled',
        type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'streamer-1' },
        debug: {
          expectedCallbackUrl: 'https://twica.example/api/twitch/eventsub',
          callbackMatch: false,
        },
      },
    ], 'main-reward')

    expect(status).toEqual({
      rewardStatus: 'none',
      raidStatus: 'none',
    })
  })
})
