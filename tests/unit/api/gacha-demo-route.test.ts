import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/gacha/demo/route'
import { getSession } from '@/lib/session'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { publishOverlayDemoEvent } from '@/lib/overlay/demo-event-store'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session')
vi.mock('@/lib/user-data')
vi.mock('@/lib/overlay/demo-event-store', () => ({
  publishOverlayDemoEvent: vi.fn().mockResolvedValue({ id: 'demo:1' }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { gachaDemoBroadcast: {}, gachaDemoCard: {} },
}))

const mockGetSession = vi.mocked(getSession)
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId)
const mockPublishOverlayDemoEvent = vi.mocked(publishOverlayDemoEvent)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/gacha/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/gacha/demo: KV demo publication authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishOverlayDemoEvent.mockResolvedValue({ id: 'demo:1' } as any)
    mockGetRateLimitIdentifier.mockResolvedValue('user:twitch-1')
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 for unauthenticated publication', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
  })

  it('returns 403 when the requested streamer belongs to another user', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })

    const response = await POST(makeRequest({ streamerId: 'streamer-2', broadcast: true }))
    expect(response.status).toBe(403)
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
  })

  it('returns 403 for a user without a streamer profile', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue(null)

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))
    expect(response.status).toBe(403)
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
  })

  it('publishes an authorized demo to the polling store', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(mockPublishOverlayDemoEvent).toHaveBeenCalledWith(
      'streamer-1',
      expect.objectContaining({ id: expect.any(String), rarity: expect.any(String) })
    )
    expect(mockGetRateLimitIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      'twitch-1'
    )
    // #735: 全リクエスト共通のIPベース制限(gachaDemoCard)がbroadcast専用制限
    // (gachaDemoBroadcast)より先に追加されたため、broadcastリクエストは2回
    // checkRateLimitを通る。
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2)
  })

  it('returns 429 before publishing when the dedicated limiter is exhausted', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    })

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
  })

  it('keeps the public non-publication demo available without a session', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(makeRequest({ streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
    // #735: broadcast専用の制限は通らないが、全リクエスト共通のIPベース制限は通る
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
    expect(mockGetRateLimitIdentifier).toHaveBeenCalledWith(expect.anything())
  })

  it('does not publish or authenticate when broadcast=true lacks a streamerId', async () => {
    const response = await POST(makeRequest({ broadcast: true }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
  })

  it('#735: 全リクエスト共通のレートリミットに達した場合はセッション不要で429を返す', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    })

    const response = await POST(makeRequest({ cardId: 'some-card' }))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})
