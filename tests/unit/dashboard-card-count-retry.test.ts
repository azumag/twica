/**
 * get_user_card_counts のPlanetScale/postgres.jsリトライ契約。
 *
 * 読み取りRPCは冪等なので接続断から再実行できる一方、HTTP/PostgREST固有の
 * status fixtureは現行経路に存在しない。ドライバが実際にthrowするcodeを使い、
 * 再試行ごとに getDb() を取得し直すことまで固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUserCards, getUserCardsForStreamer } from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import { reportError } from '@/lib/sentry/error-handler'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: (fn: unknown) => fn }
})
vi.mock('@/lib/card-utils', () => ({
  normalizeDropRate: (cards: unknown[]) => cards,
}))

const rpcCardRow = {
  count: 2,
  card: {
    id: 'card-1',
    streamer_id: 'streamer-1',
    name: 'Rare Card',
    rarity: 'rare',
    image_url: 'https://example.com/card.png',
    drop_rate: 10,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  streamer: {
    id: 'streamer-1',
    twitch_user_id: 'streamer-twitch-1',
    username: 'streamer',
    display_name: 'Streamer',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
}

function createRetryingSql() {
  const connectionClosed = Object.assign(new Error('connection closed'), {
    code: 'CONNECTION_CLOSED',
  })
  return vi.fn()
    .mockRejectedValueOnce(connectionClosed)
    .mockResolvedValueOnce([{ result: [rpcCardRow] }])
}

describe('dashboard card count RPC retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    {
      name: '全streamer',
      run: () => getUserCards('viewer-1'),
      expectedValues: ['viewer-1'],
    },
    {
      name: 'streamer指定',
      run: () => getUserCardsForStreamer('viewer-1', 'streamer-1'),
      expectedValues: ['viewer-1', 'streamer-1'],
    },
  ])('$name の接続断を再試行してカード集計を返す', async ({ run, expectedValues }) => {
    const sql = createRetryingSql()
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as any)

    const resultPromise = run()
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(sql).toHaveBeenCalledTimes(2)
    const [strings, ...values] = sql.mock.calls[0] as [readonly string[], ...unknown[]]
    expect(strings.join('$')).toContain('get_user_card_counts')
    expect(values).toEqual(expectedValues)
    expect(getDb).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      {
        ...rpcCardRow.card,
        streamer: rpcCardRow.streamer,
        count: 2,
      },
    ])
    expect(reportError).not.toHaveBeenCalled()
  })
})
