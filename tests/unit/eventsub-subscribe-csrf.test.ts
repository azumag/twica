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

  it('DELETE: CSRF 有効かつ未認証のストリーマーは 401 を返す', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockCanUseStreamerFeatures.mockReturnValue(false)

    const response = await DELETE(createDeleteRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
  })
})
