import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))

describe('getActiveCardCountsForStreamers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('複数streamerのactive card countを1回のbatch queryで返す', async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [
        { id: 'card-1', streamer_id: 'streamer-a' },
        { id: 'card-2', streamer_id: 'streamer-a' },
        { id: 'card-3', streamer_id: 'streamer-b' },
      ],
      error: null,
    })
    const query = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq,
    }
    const from = vi.fn(() => query)
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as any)

    const { getActiveCardCountsForStreamers } = await import('@/lib/dashboard-data')
    const result = await getActiveCardCountsForStreamers(['streamer-a', 'streamer-b', 'streamer-a'])

    expect(from).toHaveBeenCalledTimes(1)
    expect(query.in).toHaveBeenCalledWith('streamer_id', ['streamer-a', 'streamer-b'])
    expect(result.get('streamer-a')?.totalActive).toBe(2)
    expect(result.get('streamer-a')?.activeCardIds.has('card-2')).toBe(true)
    expect(result.get('streamer-b')?.totalActive).toBe(1)
  })
})
