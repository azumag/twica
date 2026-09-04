import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/gacha/demo/route'
import { getSession } from '@/lib/session'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { validateCSRFToken } from '@/lib/csrf'
import {
  createOverlayDemoEvent,
  storeOverlayDemoEvent,
} from '@/lib/overlay/demo-event-store'
import { publishOverlayDemoRealtimeEvent } from '@/lib/overlay-realtime/publisher'
import { runInBackground } from '@/lib/background-task'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger.server'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/session')
vi.mock('@/lib/user-data')
vi.mock('@/lib/csrf')
vi.mock('@/lib/overlay/demo-event-store', () => ({
  createOverlayDemoEvent: vi.fn(),
  storeOverlayDemoEvent: vi.fn(),
}))
vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishOverlayDemoRealtimeEvent: vi.fn(),
}))
vi.mock('@/lib/background-task', () => ({
  runInBackground: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { gachaDemoBroadcast: {}, gachaDemoCard: {} },
  retryAfterSeconds: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockCreateOverlayDemoEvent = vi.mocked(createOverlayDemoEvent)
const mockStoreOverlayDemoEvent = vi.mocked(storeOverlayDemoEvent)
const mockPublishOverlayDemoRealtimeEvent = vi.mocked(publishOverlayDemoRealtimeEvent)
const mockRunInBackground = vi.mocked(runInBackground)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockLogger = vi.mocked(logger)

const DEMO_EVENT = {
  id: 'demo:history-1',
  eventId: 'demo:event-1',
  redeemedAt: '2026-07-24T01:02:03.000Z',
  userTwitchUsername: 'DemoUser',
  rewardId: null,
  card: {
    id: 'card-demo',
    name: 'Demo Card',
    description: null,
    image_url: null,
    image_padding_color: null,
    rarity: 'common',
  },
} as const

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
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any)
    mockCreateOverlayDemoEvent.mockReturnValue(DEMO_EVENT)
    mockStoreOverlayDemoEvent.mockResolvedValue(undefined)
    mockPublishOverlayDemoRealtimeEvent.mockResolvedValue({
      outcome: 'accepted',
      attempts: 1,
    })
    mockRunInBackground.mockImplementation(async (_label, task) => {
      await task
    })
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

  it('returns 403 before authentication or publication when broadcast CSRF validation fails', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' } as any)

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockGetStreamerIdByTwitchUserId).not.toHaveBeenCalled()
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoRealtimeEvent).not.toHaveBeenCalled()
  })

  it('returns 401 for unauthenticated publication', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
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
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
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
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
  })

  it('publishes an authorized demo to KV and the immediate realtime transport', async () => {
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
    expect(mockCreateOverlayDemoEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), rarity: expect.any(String) })
    )
    expect(mockStoreOverlayDemoEvent).toHaveBeenCalledWith('streamer-1', DEMO_EVENT)
    expect(mockPublishOverlayDemoRealtimeEvent).toHaveBeenCalledWith(
      'streamer-1',
      DEMO_EVENT
    )
    // Referential identity is intentional: KV and realtime must serialize the
    // exact same immutable event, not independently generated equivalents.
    expect(mockStoreOverlayDemoEvent.mock.calls[0]?.[1]).toBe(DEMO_EVENT)
    expect(mockPublishOverlayDemoRealtimeEvent.mock.calls[0]?.[1]).toBe(DEMO_EVENT)
    expect(mockRunInBackground).toHaveBeenCalledWith(
      'overlay demo delivery',
      expect.any(Promise)
    )
    expect(mockGetRateLimitIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      'twitch-1'
    )
    // #735: 全リクエスト共通のIPベース制限(gachaDemoCard)は、認証済みユーザーID
    // 基準のより厳格な専用制限(gachaDemoBroadcast)がすでに適用される
    // broadcast&&streamerIdリクエストには重ねない(重ねると無関係な匿名IPの
    // 連打だけで専用制限に到達する前にブロックされてしまうため)。
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
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
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoRealtimeEvent).not.toHaveBeenCalled()
  })

  it('still starts realtime delivery and returns 200 when the KV write rejects', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })
    mockStoreOverlayDemoEvent.mockRejectedValue(new Error('KV unavailable'))

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))

    expect(response.status).toBe(200)
    expect(mockPublishOverlayDemoRealtimeEvent).toHaveBeenCalledWith(
      'streamer-1',
      DEMO_EVENT
    )
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Demo overlay KV fallback failed',
      { streamerId: 'streamer-1', error: 'Error' }
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Demo overlay realtime publish accepted',
      { streamerId: 'streamer-1', attempts: 1, errorCode: undefined }
    )
  })

  it('still stores the KV fallback and returns 200 when realtime rejects', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })
    mockPublishOverlayDemoRealtimeEvent.mockRejectedValue(new Error('DO unavailable'))

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))

    expect(response.status).toBe(200)
    expect(mockStoreOverlayDemoEvent).toHaveBeenCalledWith('streamer-1', DEMO_EVENT)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Demo overlay realtime publish rejected',
      { streamerId: 'streamer-1', error: 'Error' }
    )
  })

  it('logs a fulfilled failed outcome while keeping the KV fallback and 200 response', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })
    mockPublishOverlayDemoRealtimeEvent.mockResolvedValue({
      outcome: 'failed',
      attempts: 3,
      errorCode: 'network',
    })

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))

    expect(response.status).toBe(200)
    expect(mockStoreOverlayDemoEvent).toHaveBeenCalledWith('streamer-1', DEMO_EVENT)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Demo overlay realtime publish failed',
      { streamerId: 'streamer-1', attempts: 3, errorCode: 'network' }
    )
  })

  it('keeps the public non-publication demo available without a session', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(makeRequest({ streamerId: 'streamer-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(mockValidateCSRFToken).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoRealtimeEvent).not.toHaveBeenCalled()
    // #735: broadcast専用の制限は通らないが、全リクエスト共通のIPベース制限は通る
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
    expect(mockGetRateLimitIdentifier).toHaveBeenCalledWith(expect.anything())
  })

  it('does not publish or authenticate when broadcast=true lacks a streamerId', async () => {
    const response = await POST(makeRequest({ broadcast: true }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.card).toBeDefined()
    expect(mockValidateCSRFToken).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
  })

  it('#735: 匿名IPの一般制限が枯渇していても、認証済みユーザーのbroadcastは専用制限のみで判定され成功する', async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: 'twitch-1',
      twitchUsername: 'user1',
      broadcasterType: 'affiliate',
    } as Awaited<ReturnType<typeof getSession>>)
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: 'streamer-1' })
    mockGetRateLimitIdentifier.mockImplementation(async (_req, twitchUserId) =>
      twitchUserId ? `user:${twitchUserId}` : 'ip:203.0.113.1'
    )
    // 匿名IPベースの識別子に対しては枯渇済みを返す。gachaDemoCard(一般制限)が
    // broadcast&&streamerId経路でも誤って呼ばれてしまえば、この枯渇で検出できる。
    mockCheckRateLimit.mockImplementation(async (_limiter, identifier: string) => {
      if (identifier.startsWith('ip:')) {
        return { success: false, limit: 30, remaining: 0, reset: Date.now() + 60_000 }
      }
      return { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 }
    })

    const response = await POST(makeRequest({ streamerId: 'streamer-1', broadcast: true }))

    expect(response.status).toBe(200)
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
