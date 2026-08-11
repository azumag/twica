import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from '@/app/api/twitch/eventsub/debug/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'

// Issue #831: DELETE /api/twitch/eventsub/debug の
// (1) 所有権検証欠落、(2) CSRF/レートリミット欠落、(3) 全削除のページネーション未対応
// を検証する回帰テスト。

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { eventsubSubscribePost: {} },
}))
vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)

function createDeleteRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/twitch/eventsub/debug${query}`, {
    method: 'DELETE',
  })
}

function mockAppAccessTokenFetch() {
  // expires_in は app-token ヘルパーのキャッシュTTL計算に使われる（#739）。
  return new Response(
    JSON.stringify({ access_token: 'app-token', expires_in: 3600 }),
    { status: 200 },
  )
}

describe('DELETE /api/twitch/eventsub/debug (#831)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetTwitchAppTokenForTests()
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    mockGetSession.mockResolvedValue({
      twitchUserId: 'my-user-id',
      twitchUsername: 'streamer',
      twitchDisplayName: 'Streamer',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockGetRateLimitIdentifier.mockResolvedValue('user:my-user-id')
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    })
  })

  it('CSRF不正時は403を返し、レートリミット/セッション取得にも到達しない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })

    const response = await DELETE(createDeleteRequest('?id=sub-1'))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('レートリミット超過時は429を返す', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    })

    const response = await DELETE(createDeleteRequest('?id=sub-1'))

    expect(response.status).toBe(429)
  })

  it('配信者権限のないセッションは401を返す', async () => {
    mockCanUseStreamerFeatures.mockReturnValue(false)

    const response = await DELETE(createDeleteRequest('?id=sub-1'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
  })

  it('他broadcasterが所有するsubscriptionIdの削除は403で拒否し、Twitchへの削除リクエストを送らない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'victim-sub',
              status: 'enabled',
              type: 'channel.channel_points_custom_reward_redemption.add',
              condition: { broadcaster_user_id: 'other-user-id' },
              transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: {},
        }), { status: 200 }),
      )

    const response = await DELETE(createDeleteRequest('?id=victim-sub'))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body).toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('?id=victim-sub'),
      expect.objectContaining({ method: 'DELETE' }),
    )

    fetchMock.mockRestore()
  })

  it('存在しないsubscriptionIdの削除は403で拒否する', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }),
      )

    const response = await DELETE(createDeleteRequest('?id=nonexistent-sub'))

    expect(response.status).toBe(403)
  })

  it('自分が所有するsubscriptionIdの削除は成功する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'my-sub',
              status: 'enabled',
              type: 'channel.channel_points_custom_reward_redemption.add',
              condition: { broadcaster_user_id: 'my-user-id' },
              transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: {},
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const response = await DELETE(createDeleteRequest('?id=my-sub'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true, message: 'Subscription deleted' })
    // 所有権確認の一覧取得はuser_idで絞り込む（app全体を毎回列挙しない） (#831)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('user_id=my-user-id'),
      expect.objectContaining({ headers: expect.anything() }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=my-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )

    fetchMock.mockRestore()
  })

  it('idもall=trueも指定しない場合は400を返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())

    const response = await DELETE(createDeleteRequest())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Missing subscription id' })

    fetchMock.mockRestore()
  })

  it('所有権確認の一覧取得がTwitch API側で失敗した場合は500を返し、削除リクエストを送らない(fail-closed)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'server error' }), { status: 500 }))

    const response = await DELETE(createDeleteRequest('?id=my-sub'))

    expect(response.status).toBe(500)
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('?id=my-sub'),
      expect.objectContaining({ method: 'DELETE' }),
    )

    fetchMock.mockRestore()
  })

  it('全削除(?all=true)は複数ページに渡る購読を全て取得し、自分の分のみ削除する', async () => {
    // getAllSubscriptions() のページネーションを検証: 1ページ目にカーソルがあり、
    // 2ページ目まで辿って初めて全件が揃う。旧実装（生fetch1回）ではこの2ページ目の
    // 購読が黙って削除対象から漏れていた。
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockAppAccessTokenFetch())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'my-sub-page1',
              status: 'enabled',
              type: 'channel.channel_points_custom_reward_redemption.add',
              condition: { broadcaster_user_id: 'my-user-id' },
              transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: { cursor: 'next-page-cursor' },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'my-sub-page2',
              status: 'enabled',
              type: 'channel.channel_points_custom_reward_redemption.add',
              condition: { broadcaster_user_id: 'my-user-id' },
              transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
              created_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 'other-user-sub',
              status: 'enabled',
              type: 'channel.channel_points_custom_reward_redemption.add',
              condition: { broadcaster_user_id: 'other-user-id' },
              transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: {},
        }), { status: 200 }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }))

    const response = await DELETE(createDeleteRequest('?all=true'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toBe('Deleted 2/2 subscriptions')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=my-sub-page1',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=my-sub-page2',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=other-user-sub',
      expect.anything(),
    )

    fetchMock.mockRestore()
  })
})
