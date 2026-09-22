import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  deliverChatNotificationSlice: vi.fn(),
  dispatchDueChatNotifications: vi.fn(),
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
}))

vi.mock('@/lib/services/chat-notification-delivery', () => ({
  deliverChatNotificationSlice: mocks.deliverChatNotificationSlice,
}))
vi.mock('@/lib/services/chat-notification-dispatch', () => ({
  dispatchDueChatNotifications: mocks.dispatchDueChatNotifications,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { chatOutboxDelivery: {} },
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const TEST_SECRET = 'test-chat-delivery-secret'

function createRequest(body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/internal/chat-outbox', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chat-delivery-secret': TEST_SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/internal/chat-outbox (Issue #1665)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CHAT_DELIVERY_SECRET = TEST_SECRET
    mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 })
    mocks.getRateLimitIdentifier.mockResolvedValue('ip:127.0.0.1')
  })

  afterEach(() => {
    delete process.env.CHAT_DELIVERY_SECRET
  })

  it('fails closed with 500 when CHAT_DELIVERY_SECRET is not configured', async () => {
    delete process.env.CHAT_DELIVERY_SECRET
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    const response = await POST(createRequest({ action: 'deliver', batchId: 'batch-1' }))

    expect(response.status).toBe(500)
    expect(mocks.deliverChatNotificationSlice).not.toHaveBeenCalled()
  })

  it('rejects a missing secret header with 403', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const request = new NextRequest('http://localhost:3000/api/internal/chat-outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'deliver', batchId: 'batch-1' }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(mocks.deliverChatNotificationSlice).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret with 403', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    const response = await POST(createRequest(
      { action: 'deliver', batchId: 'batch-1' },
      { 'x-chat-delivery-secret': 'wrong-secret' },
    ))

    expect(response.status).toBe(403)
  })

  it('returns 429 when the rate limit is exceeded', async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 120, remaining: 0, reset: Date.now() + 1000 })
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    const response = await POST(createRequest({ action: 'deliver', batchId: 'batch-1' }))

    expect(response.status).toBe(429)
    expect(mocks.deliverChatNotificationSlice).not.toHaveBeenCalled()
  })

  it('rejects an empty body with 400', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const response = await POST(createRequest(undefined))
    expect(response.status).toBe(400)
  })

  it('rejects malformed JSON with 400', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const request = new NextRequest('http://localhost:3000/api/internal/chat-outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chat-delivery-secret': TEST_SECRET },
      body: '{not json',
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('rejects an unknown action with 400', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const response = await POST(createRequest({ action: 'force-sent', batchId: 'batch-1' }))
    expect(response.status).toBe(400)
    expect(mocks.deliverChatNotificationSlice).not.toHaveBeenCalled()
  })

  it('rejects deliver without a batchId', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const response = await POST(createRequest({ action: 'deliver' }))
    expect(response.status).toBe(400)
  })

  it('rejects deliver with unknown extra fields (no forced cursor/sent/destination injection)', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const response = await POST(createRequest({
      action: 'deliver',
      batchId: 'batch-1',
      forceSent: true,
    }))
    expect(response.status).toBe(400)
    expect(mocks.deliverChatNotificationSlice).not.toHaveBeenCalled()
  })

  it('rejects an oversized batchId', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const response = await POST(createRequest({ action: 'deliver', batchId: 'x'.repeat(500) }))
    expect(response.status).toBe(400)
  })

  it('delivers a valid deliver request and returns the slice outcome, with no-store caching', async () => {
    mocks.deliverChatNotificationSlice.mockResolvedValue({ kind: 'complete' })
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    const response = await POST(createRequest({ action: 'deliver', batchId: 'batch-1' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ outcome: { kind: 'complete' } })
    expect(mocks.deliverChatNotificationSlice).toHaveBeenCalledWith('batch-1')
  })

  it('runs dispatch-due with the default limit and reservation window when limit is omitted', async () => {
    mocks.dispatchDueChatNotifications.mockResolvedValue({ reserved: 3, enqueued: 3, skippedDisabled: false })
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    const response = await POST(createRequest({ action: 'dispatch-due' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { reserved: 3, enqueued: 3, skippedDisabled: false } })
    expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(25, 120)
  })

  it('clamps an oversized dispatch-due limit to the maximum', async () => {
    mocks.dispatchDueChatNotifications.mockResolvedValue({ reserved: 0, enqueued: 0, skippedDisabled: false })
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    await POST(createRequest({ action: 'dispatch-due', limit: 9999 }))

    expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(25, 120)
  })

  it('rejects a non-integer or non-positive dispatch-due limit', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')

    await expect(POST(createRequest({ action: 'dispatch-due', limit: 0 })).then((r) => r.status)).resolves.toBe(400)
    await expect(POST(createRequest({ action: 'dispatch-due', limit: 1.5 })).then((r) => r.status)).resolves.toBe(400)
    await expect(POST(createRequest({ action: 'dispatch-due', limit: 'many' })).then((r) => r.status)).resolves.toBe(400)
  })

  it('rejects a request body larger than the byte limit', async () => {
    const { POST } = await import('@/app/api/internal/chat-outbox/route')
    const request = new NextRequest('http://localhost:3000/api/internal/chat-outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chat-delivery-secret': TEST_SECRET },
      // 2000バイト上限を超える生のペイロード（妥当なJSONである必要はない。
      // サイズ上限はJSON.parseより先に評価されるため、これだけで400になる）。
      body: 'x'.repeat(2_001),
    })

    const response = await POST(request)

    expect(response.status).toBe(400)
  })
})
