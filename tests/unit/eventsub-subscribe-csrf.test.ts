import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, DELETE } from '@/app/api/twitch/eventsub/subscribe/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'

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

  it('DELETE: CSRF 有効かつ未認証のストリーマーは 401 を返す', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockCanUseStreamerFeatures.mockReturnValue(false)

    const response = await DELETE(createDeleteRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
  })
})
