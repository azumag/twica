import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/overlay/[streamerId]/events/route'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { checkRateLimit } from '@/lib/rate-limit'

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 120,
    remaining: 119,
    reset: 0,
  }),
  getRateLimitIdentifier: vi.fn().mockResolvedValue('ip:127.0.0.1'),
  rateLimits: { overlayEventsGet: {} },
}))

vi.mock('@/lib/supabase/retry', () => ({
  withRetry: vi.fn((operation: () => unknown) => operation()),
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockCheckRateLimit = vi.mocked(checkRateLimit)

function createSupabaseRows(rows: unknown[]) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: rows, error: null }),
  }
  mockGetSupabaseAdmin.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table !== 'gacha_history') throw new Error(`Unexpected table: ${table}`)
      return query
    }),
  } as unknown as ReturnType<typeof getSupabaseAdmin>)
  return query
}

describe('Overlay events API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 120,
      remaining: 119,
      reset: 0,
    } as Awaited<ReturnType<typeof checkRateLimit>>)
  })

  it('fetches requested gacha_history IDs without requiring since and preserves request order', async () => {
    const query = createSupabaseRows([
      {
        id: 'history-2',
        event_id: 'event-1:2',
        redeemed_at: '2026-05-14T00:00:01.000Z',
        user_twitch_username: 'Viewer',
        cards: { id: 'card-2', name: 'Beta', description: 'B', image_url: null, rarity: 'rare' },
      },
      {
        id: 'history-1',
        event_id: 'event-1',
        redeemed_at: '2026-05-14T00:00:00.000Z',
        user_twitch_username: 'Viewer',
        cards: { id: 'card-1', name: 'Alpha', description: 'A', image_url: null, rarity: 'common' },
      },
    ])

    const response = await GET(
      new NextRequest('http://localhost/api/overlay/streamer-1/events?ids=history-1,history-2,history-1'),
      { params: Promise.resolve({ streamerId: 'streamer-1' }) },
    )

    expect(response.status).toBe(200)
    expect(query.eq).toHaveBeenCalledWith('streamer_id', 'streamer-1')
    expect(query.in).toHaveBeenCalledWith('id', ['history-1', 'history-2'])
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=5, stale-while-revalidate=10')
    await expect(response.json()).resolves.toMatchObject({
      complete: true,
      events: [
        { id: 'history-1', card: { name: 'Alpha' } },
        { id: 'history-2', card: { name: 'Beta' } },
        { id: 'history-1', card: { name: 'Alpha' } },
      ],
    })
  })

  it('marks partial ID batches as no-store so clients can retry write/read races', async () => {
    createSupabaseRows([
      {
        id: 'history-1',
        event_id: 'event-1',
        redeemed_at: '2026-05-14T00:00:00.000Z',
        user_twitch_username: 'Viewer',
        cards: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'common' },
      },
    ])

    const response = await GET(
      new NextRequest('http://localhost/api/overlay/streamer-1/events?ids=history-1,history-missing'),
      { params: Promise.resolve({ streamerId: 'streamer-1' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      complete: false,
      events: [{ id: 'history-1' }],
    })
  })
})
