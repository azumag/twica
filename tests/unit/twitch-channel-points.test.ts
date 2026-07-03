import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #546: cancelRedemption() が Twitch の Update Redemption Status API を
// 正しいURL/メソッド/認証ヘッダーで呼び、成功/失敗を正しく分類することを検証する。
// この関数は「呼び出し元 (eventsub route) に対して例外を投げない」という契約を持つため、
// あらゆる失敗パターンで success:false を返すことも合わせて検証する。

const mocks = vi.hoisted(() => ({
  getTwitchAccessToken: vi.fn(),
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  getTwitchAccessToken: mocks.getTwitchAccessToken,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const originalFetch = global.fetch

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getTwitchAccessToken.mockResolvedValue('broadcaster-access-token')
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('cancelRedemption', () => {
  it('正しいURL・メソッド・ヘッダー・bodyでTwitch APIを呼び、成功時はsuccess:trueを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch

    const { cancelRedemption } = await import('@/lib/twitch/channel-points')
    const result = await cancelRedemption({
      broadcasterTwitchUserId: 'broadcaster-1',
      rewardId: 'reward-1',
      redemptionId: 'redemption-1',
    })

    expect(result).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=broadcaster-1&reward_id=reward-1&id=redemption-1'
    )
    expect(init.method).toBe('PATCH')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer broadcaster-access-token',
      'Client-Id': 'test-client-id',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual({ status: 'CANCELED' })
  })

  it('アクセストークンが取得できない場合はfetchを呼ばずsuccess:falseを返す', async () => {
    mocks.getTwitchAccessToken.mockResolvedValue(null)
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const { cancelRedemption } = await import('@/lib/twitch/channel-points')
    const result = await cancelRedemption({
      broadcasterTwitchUserId: 'broadcaster-1',
      rewardId: 'reward-1',
      redemptionId: 'redemption-1',
    })

    expect(result).toEqual({ success: false, reason: 'no_access_token' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Twitch APIが4xx/5xxを返した場合、例外を投げずsuccess:falseを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('{"message":"Insufficient authorization"}'),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { cancelRedemption } = await import('@/lib/twitch/channel-points')
    const result = await cancelRedemption({
      broadcasterTwitchUserId: 'broadcaster-1',
      rewardId: 'reward-1',
      redemptionId: 'redemption-1',
    })

    expect(result).toEqual({ success: false, reason: 'http_401' })
  })

  it('fetchが例外をthrowしても、呼び出し元に伝播させずsuccess:falseを返す', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    global.fetch = fetchMock as unknown as typeof fetch

    const { cancelRedemption } = await import('@/lib/twitch/channel-points')
    await expect(
      cancelRedemption({
        broadcasterTwitchUserId: 'broadcaster-1',
        rewardId: 'reward-1',
        redemptionId: 'redemption-1',
      })
    ).resolves.toEqual({ success: false, reason: 'exception' })
  })
})
