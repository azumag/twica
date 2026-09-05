import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/gacha/demo/route'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { getStreamerIdByTwitchUserId } from '@/lib/user-data'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { createOverlayDemoEvent, storeOverlayDemoEvent } from '@/lib/overlay/demo-event-store'
import { publishOverlayDemoRealtimeEvent } from '@/lib/overlay-realtime/publisher'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/user-data')
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

const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSession = vi.mocked(getSession)
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier)
const mockCreateOverlayDemoEvent = vi.mocked(createOverlayDemoEvent)
const mockStoreOverlayDemoEvent = vi.mocked(storeOverlayDemoEvent)
const mockPublishOverlayDemoRealtimeEvent = vi.mocked(publishOverlayDemoRealtimeEvent)

describe('POST /api/gacha/demo: broadcast CSRF guard ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates the original request before auth, rate limiting, or publication', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: 'bad csrf' })
    const request = new NextRequest('http://localhost/api/gacha/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamerId: 'streamer-1', broadcast: true }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(mockValidateCSRFToken).toHaveBeenCalledTimes(1)
    expect(mockValidateCSRFToken).toHaveBeenCalledWith(request)
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockGetStreamerIdByTwitchUserId).not.toHaveBeenCalled()
    expect(mockGetRateLimitIdentifier).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockCreateOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockStoreOverlayDemoEvent).not.toHaveBeenCalled()
    expect(mockPublishOverlayDemoRealtimeEvent).not.toHaveBeenCalled()
  })
})
