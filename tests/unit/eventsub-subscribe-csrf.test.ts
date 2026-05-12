import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, DELETE } from '@/app/api/twitch/eventsub/subscribe/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

// Issue #399 に対応するテスト: 状態変更 API (EventSub 登録/解除) が CSRF 検証失敗時に 403 を返すこと。
// 正常系の詳細（Twitch API との連携）は既存 E2E の対象であり、ここでは CSRF ゲートのみ検証する。

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { eventsubSubscribePost: {}, eventsubSubscribeGet: {} },
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
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
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

function createPostRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/twitch/eventsub/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewardId: 'reward-123' }),
  })
}

function createDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/twitch/eventsub/subscribe', {
    method: 'DELETE',
  })
}

function createDeleteRewardRequest(rewardId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/twitch/eventsub/subscribe?rewardId=${rewardId}`, {
    method: 'DELETE',
  })
}

describe('EventSub subscribe API - CSRF enforcement (issue #399)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: '123456789',
      twitchUsername: 'streamer',
      twitchDisplayName: 'Streamer',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockGetRateLimitIdentifier.mockResolvedValue('user:123456789')
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    })
  })

  it('POST: CSRF 不正時は 403 を返し、レートリミット/認証にも到達しない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })

    const response = await POST(createPostRequest())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    // CSRF 前に弾かれるため下流の呼び出しは発生しない
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('DELETE: CSRF 不正時は 403 を返し、レートリミット/認証にも到達しない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })

    const response = await DELETE(createDeleteRequest())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('POST: CSRF 有効かつ未認証のストリーマーは 401 を返す', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockCanUseStreamerFeatures.mockReturnValue(false)

    const response = await POST(createPostRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
  })

  it('POST: チャネルポイント登録時に incoming raid EventSub も登録する', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.TWITCH_EVENTSUB_SECRET = 'eventsub-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'
    const streamerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'streamer-1' }, error: null }),
    }
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'reward-sub', status: 'enabled' }] }), { status: 202 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'raid-sub', status: 'enabled' }] }), { status: 202 }),
    )

    const response = await POST(createPostRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      subscription: { id: 'reward-sub' },
      raidSubscription: { created: { id: 'raid-sub' } },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'channel.raid',
          version: '1',
          condition: { to_broadcaster_user_id: '123456789' },
          transport: {
            method: 'webhook',
            callback: 'https://twica.example/api/twitch/eventsub',
            secret: 'eventsub-secret',
          },
        }),
      }),
    )

    fetchMock.mockRestore()
  })

  it('POST: 失敗済み incoming raid EventSub は削除して再作成する', async () => {
    vi.useFakeTimers()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.TWITCH_EVENTSUB_SECRET = 'eventsub-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'
    const streamerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'streamer-1' }, error: null }),
    }
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          {
            id: 'failed-raid-sub',
            status: 'webhook_callback_verification_failed',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'reward-sub', status: 'enabled' }] }), { status: 202 }),
    ).mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'new-raid-sub', status: 'webhook_callback_verification_pending' }] }), { status: 202 }),
    )

    const responsePromise = POST(createPostRequest())
    await vi.advanceTimersByTimeAsync(500)
    const response = await responsePromise

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      subscription: { id: 'reward-sub' },
      raidSubscription: { created: { id: 'new-raid-sub' } },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=failed-raid-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'channel.raid',
          version: '1',
          condition: { to_broadcaster_user_id: '123456789' },
          transport: {
            method: 'webhook',
            callback: 'https://twica.example/api/twitch/eventsub',
            secret: 'eventsub-secret',
          },
        }),
      }),
    )

    fetchMock.mockRestore()
    vi.useRealTimers()
  })

  it('POST: failed raid EventSub の削除失敗と作成失敗を区別して返す', async () => {
    vi.useFakeTimers()
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.TWITCH_EVENTSUB_SECRET = 'eventsub-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'
    const streamerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'streamer-1' }, error: null }),
    }
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          {
            id: 'failed-raid-sub',
            status: 'webhook_callback_verification_failed',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'reward-sub', status: 'enabled' }] }), { status: 202 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'delete rejected' }), { status: 500 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'subscription still exists' }), { status: 409 }),
    )

    const responsePromise = POST(createPostRequest())
    await vi.advanceTimersByTimeAsync(500)
    const response = await responsePromise
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      subscription: { id: 'reward-sub' },
      raidSubscription: {
        deleteWarning: 'failed raid EventSub の削除に失敗しました: id=failed-raid-sub, status=500',
        createWarning: 'raid EventSub の作成に失敗しました: status=409',
      },
    })
    expect(body.raidSubscription.warning).toContain('failed raid EventSub の削除に失敗しました: id=failed-raid-sub, status=500')
    expect(body.raidSubscription.warning).toContain('raid EventSub の作成に失敗しました: status=409')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=failed-raid-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )

    fetchMock.mockRestore()
    vi.useRealTimers()
  })

  it('POST: 有効な incoming raid EventSub は重複作成せず再利用する', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.TWITCH_EVENTSUB_SECRET = 'eventsub-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'
    const streamerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'streamer-1' }, error: null }),
    }
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          {
            id: 'existing-raid-sub',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'reward-sub', status: 'enabled' }] }), { status: 202 }),
    )

    const response = await POST(createPostRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      subscription: { id: 'reward-sub' },
      raidSubscription: { subscription: { id: 'existing-raid-sub' } },
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=existing-raid-sub',
      expect.anything(),
    )

    fetchMock.mockRestore()
  })

  it('DELETE: CSRF 有効かつ未認証のストリーマーは 401 を返す', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockCanUseStreamerFeatures.mockReturnValue(false)

    const response = await DELETE(createDeleteRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
  })

  it('DELETE: 完全解除では同一 callback の channel point と raid EventSub を削除する', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          {
            id: 'reward-sub',
            status: 'enabled',
            type: 'channel.channel_points_custom_reward_redemption.add',
            condition: { broadcaster_user_id: '123456789', reward_id: 'main-reward' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
          {
            id: 'raid-sub',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
          {
            id: 'other-callback-raid-sub',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://other.example/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }),
    ).mockResolvedValue(
      new Response(null, { status: 204 }),
    )

    const response = await DELETE(createDeleteRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      deletedCount: 2,
      totalCount: 2,
      results: [
        { id: 'reward-sub', type: 'channel.channel_points_custom_reward_redemption.add', success: true },
        { id: 'raid-sub', type: 'channel.raid', success: true },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=reward-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=raid-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=other-callback-raid-sub',
      expect.anything(),
    )

    fetchMock.mockRestore()
  })

  it('DELETE: rewardId 指定では raid EventSub を削除しない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'client-id'
    process.env.TWITCH_CLIENT_SECRET = 'client-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          {
            id: 'target-reward-sub',
            status: 'enabled',
            type: 'channel.channel_points_custom_reward_redemption.add',
            condition: { broadcaster_user_id: '123456789', reward_id: 'target-reward' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
          {
            id: 'other-reward-sub',
            status: 'enabled',
            type: 'channel.channel_points_custom_reward_redemption.add',
            condition: { broadcaster_user_id: '123456789', reward_id: 'other-reward' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
          {
            id: 'raid-sub',
            status: 'enabled',
            type: 'channel.raid',
            condition: { to_broadcaster_user_id: '123456789' },
            transport: { method: 'webhook', callback: 'https://twica.example/api/twitch/eventsub' },
          },
        ],
        pagination: {},
      }), { status: 200 }),
    ).mockResolvedValue(
      new Response(null, { status: 204 }),
    )

    const response = await DELETE(createDeleteRewardRequest('target-reward'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      deletedCount: 1,
      totalCount: 1,
      results: [
        { id: 'target-reward-sub', type: 'channel.channel_points_custom_reward_redemption.add', success: true },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=target-reward-sub',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=other-reward-sub',
      expect.anything(),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.twitch.tv/helix/eventsub/subscriptions?id=raid-sub',
      expect.anything(),
    )

    fetchMock.mockRestore()
  })
})
