import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), sql: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ getDb: mocks.getDb }))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
}))
import { runStatsRefresh } from '@/lib/services/stats-refresh'

describe('runStatsRefresh (Issue #741)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDb.mockResolvedValue({ sql: mocks.sql })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls refresh_streamer_ranking() and returns the normalized outcome', async () => {
    mocks.sql
      .mockResolvedValueOnce([{ skipped: false, reason: 'refreshed', snapshot_count: 7 }])
      .mockResolvedValueOnce([{ computed_at: '2026-10-07T11:00:00.000Z' }])

    await expect(runStatsRefresh()).resolves.toEqual({
      available: true,
      skipped: false,
      reason: 'refreshed',
      snapshotCount: 7,
      computedAt: '2026-10-07T11:00:00.000Z',
    })

    const [strings] = mocks.sql.mock.calls[0] as [TemplateStringsArray]
    expect(strings.join('?')).toContain('refresh_streamer_ranking')
  })

  it('parses snapshot_count returned as text (postgres.js int8) and Date computed_at', async () => {
    mocks.sql
      .mockResolvedValueOnce([{ skipped: false, reason: 'refreshed', snapshot_count: '12' }])
      .mockResolvedValueOnce([{ computed_at: new Date('2026-10-07T11:00:00.000Z') }])

    await expect(runStatsRefresh()).resolves.toEqual({
      available: true,
      skipped: false,
      reason: 'refreshed',
      snapshotCount: 12,
      computedAt: '2026-10-07T11:00:00.000Z',
    })
  })

  it('passes skipped outcomes through without a freshness query', async () => {
    mocks.sql.mockResolvedValueOnce([{ skipped: true, reason: 'cooldown', snapshot_count: 0 }])

    await expect(runStatsRefresh()).resolves.toEqual({
      available: true,
      skipped: true,
      reason: 'cooldown',
      snapshotCount: 0,
      computedAt: null,
    })
    expect(mocks.sql).toHaveBeenCalledTimes(1)
  })

  it('maps undefined_function (42883) to unavailable for the deploy window', async () => {
    mocks.sql.mockRejectedValueOnce(Object.assign(new Error('function does not exist'), { code: '42883' }))

    await expect(runStatsRefresh()).resolves.toEqual({ available: false, code: '42883' })
  })

  it('maps undefined_table (42P01) to unavailable for the deploy window', async () => {
    mocks.sql.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }))

    await expect(runStatsRefresh()).resolves.toEqual({ available: false, code: '42P01' })
  })

  it('rethrows unexpected errors', async () => {
    mocks.sql.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }))

    await expect(runStatsRefresh()).rejects.toThrow('connection reset')
  })
})
