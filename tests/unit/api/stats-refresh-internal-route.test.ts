import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  runStatsRefresh: vi.fn(),
}))

vi.mock('@/lib/services/stats-refresh', () => ({
  runStatsRefresh: mocks.runStatsRefresh,
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const TEST_SECRET = 'test-stats-refresh-secret'

function createRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/internal/stats/refresh', {
    method: 'POST',
    headers: {
      'x-stats-refresh-secret': TEST_SECRET,
      ...headers,
    },
  })
}

describe('POST /api/internal/stats/refresh (Issue #741)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STATS_REFRESH_SECRET = TEST_SECRET
    mocks.runStatsRefresh.mockResolvedValue({
      available: true,
      skipped: false,
      reason: 'refreshed',
      snapshotCount: 7,
      computedAt: '2026-10-07T11:00:00.000Z',
    })
  })

  afterEach(() => {
    delete process.env.STATS_REFRESH_SECRET
  })

  it('fails closed with 500 when STATS_REFRESH_SECRET is not configured', async () => {
    delete process.env.STATS_REFRESH_SECRET
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mocks.runStatsRefresh).not.toHaveBeenCalled()
  })

  it('rejects a missing secret header with 403', async () => {
    const { POST } = await import('@/app/api/internal/stats/refresh/route')
    const request = new NextRequest('http://localhost:3000/api/internal/stats/refresh', {
      method: 'POST',
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(mocks.runStatsRefresh).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret with 403', async () => {
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest({ 'x-stats-refresh-secret': 'wrong-secret' }))

    expect(response.status).toBe(403)
    expect(mocks.runStatsRefresh).not.toHaveBeenCalled()
  })

  it('returns the refresh outcome with duration on success', async () => {
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      skipped: false,
      reason: 'refreshed',
      snapshotCount: 7,
      computedAt: '2026-10-07T11:00:00.000Z',
    })
    expect(typeof body.durationMs).toBe('number')
  })

  it('passes skipped outcomes through', async () => {
    mocks.runStatsRefresh.mockResolvedValue({
      available: true,
      skipped: true,
      reason: 'cooldown',
      snapshotCount: 0,
      computedAt: null,
    })
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ skipped: true, reason: 'cooldown' })
  })

  it('returns 503 when the aggregation migration is not deployed yet', async () => {
    mocks.runStatsRefresh.mockResolvedValue({ available: false, code: '42883' })
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest())

    expect(response.status).toBe(503)
  })

  it('returns 500 when the refresh itself fails (old snapshot stays)', async () => {
    mocks.runStatsRefresh.mockRejectedValue(new Error('db down'))
    const { POST } = await import('@/app/api/internal/stats/refresh/route')

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
  })
})
