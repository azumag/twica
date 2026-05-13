import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:test'),
  checkRateLimit: vi.fn(),
  rateLimits: { twitchRewardsGet: { windowMs: 60000, max: 30 } },
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))

const session = {
  twitchUserId: 'streamer-1',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: null,
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 10000,
  version: 1,
}

function request(url = 'http://localhost:3000/api/twitch/channel-point-bootstrap') {
  return new NextRequest(url)
}

describe('GET /api/twitch/channel-point-bootstrap', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
    vi.stubGlobal('fetch', vi.fn())
    const { getSession, canUseStreamerFeatures } = await import('@/lib/session')
    const { checkRateLimit } = await import('@/lib/rate-limit')
    vi.mocked(getSession).mockResolvedValue(session as any)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60000,
    })
  })

  it('scope不足ならTwitch rewardsを呼ばずreauthを返す', async () => {
    const { hasScope } = await import('@/lib/twitch/token-manager')
    vi.mocked(hasScope).mockResolvedValue(false)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(body).toMatchObject({ hasRequiredScope: false, rewards: [], requiresReauth: true })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('diagnostics=0ではscope確認とrewards取得だけを返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'reward-1', title: 'Reward', cost: 100, is_enabled: true }],
    }), { status: 200 }) as any)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request())
    const body = await response.json()

    expect(body.hasRequiredScope).toBe(true)
    expect(body.rewards).toHaveLength(1)
    expect(body.subscriptions).toBeUndefined()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('diagnostics=1ではEventSubと追加報酬状態も返す', async () => {
    const { hasScope, getTwitchAccessToken } = await import('@/lib/twitch/token-manager')
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('token-1')
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            id: 'sub-1',
            status: 'enabled',
            type: 'channel.channel_points_custom_reward_redemption.add',
            condition: { reward_id: 'reward-1' },
            transport: { callback: 'https://example.com/api/twitch/eventsub' },
          },
          {
            id: 'sub-2',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: 'streamer-1' },
            transport: { callback: 'https://example.com/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }) as any)

    const streamerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'streamer-db-1', channel_point_reward_id: 'reward-1', raid_gacha_draw_count: 3 },
        error: null,
      }),
    }
    const rewardsQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [{ id: 'extra-1', reward_id: 'reward-2' }], error: null }),
    }
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn((table: string) => table === 'streamers' ? streamerQuery : rewardsQuery),
    } as any)

    const { GET } = await import('@/app/api/twitch/channel-point-bootstrap/route')
    const response = await GET(request('http://localhost:3000/api/twitch/channel-point-bootstrap?diagnostics=1'))
    const body = await response.json()

    expect(body.eventSubStatus).toBe('active')
    expect(body.raidEventSubStatus).toBe('active')
    expect(body.additionalRewards).toHaveLength(1)
    expect(body.raidGiftDrawCount).toBe(3)
  })
})
