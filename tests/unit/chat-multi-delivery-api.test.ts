import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  getDb: vi.fn(),
  session: vi.fn(),
  csrf: vi.fn(),
  limit: vi.fn(),
  identifier: vi.fn(),
}))

vi.mock('@/lib/csrf', () => ({ validateCSRFToken: mocks.csrf }))
vi.mock('@/lib/session', () => ({
  getSession: mocks.session,
  canUseStreamerFeatures: () => true,
}))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  getRateLimitIdentifier: mocks.identifier,
  checkRateLimit: mocks.limit,
  rateLimits: { streamerSettings: {} },
}))

import { GET, PUT } from '@/app/api/streamer/chat-multi-delivery/route'

function request(method: string, body?: unknown) {
  return new NextRequest('https://twica.live/api/streamer/chat-multi-delivery', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sql.mockReset()
  mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  mocks.session.mockResolvedValue({ twitchUserId: 'viewer' })
  mocks.csrf.mockResolvedValue({ valid: true })
  mocks.identifier.mockResolvedValue('viewer')
  mocks.limit.mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: 0 })
})

describe('multi-draw chat delivery settings API', () => {
  it('returns summary defaults for an existing streamer without saved settings', async () => {
    mocks.sql.mockResolvedValueOnce([{
      streamer_id: '00000000-0000-4000-8000-000000000001',
      delivery_mode: null,
      chunk_size: null,
    }])

    const response = await GET(request('GET'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      deliveryMode: 'summary',
      chunkSize: 3,
      intervalMs: 1600,
    })
  })

  it('rejects PUT without CSRF before database access', async () => {
    mocks.csrf.mockResolvedValue({ valid: false })
    const response = await PUT(request('PUT', { deliveryMode: 'individual', chunkSize: 3 }))
    expect(response.status).toBe(403)
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated reads', async () => {
    mocks.session.mockResolvedValue(null)
    const response = await GET(request('GET'))
    expect(response.status).toBe(401)
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it('rejects an unknown delivery mode without SQL', async () => {
    const response = await PUT(request('PUT', { deliveryMode: 'burst', chunkSize: 3 }))
    expect(response.status).toBe(400)
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it.each([1, 6, 2.5, '3'])('rejects invalid chunk size %s without SQL', async (chunkSize) => {
    const response = await PUT(request('PUT', { deliveryMode: 'chunked', chunkSize }))
    expect(response.status).toBe(400)
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it.each(['summary', 'individual', 'chunked'] as const)(
    'persists valid %s settings for the authenticated streamer',
    async (deliveryMode) => {
      mocks.sql
        .mockResolvedValueOnce([{
          streamer_id: '00000000-0000-4000-8000-000000000001',
          delivery_mode: 'summary',
          chunk_size: 3,
        }])
        .mockResolvedValueOnce([])

      const response = await PUT(request('PUT', { deliveryMode, chunkSize: 4 }))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        success: true,
        deliveryMode,
        chunkSize: 4,
        intervalMs: 1600,
      })
      expect(mocks.sql).toHaveBeenCalledTimes(2)
    },
  )
})
