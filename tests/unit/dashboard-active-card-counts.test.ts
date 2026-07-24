/**
 * 複数配信者のactive card集計をPlanetScale/Drizzle境界で検証する。
 * 1配信者ずつ問い合わせるN+1へ退行しないことと、重複IDの前処理を同時に固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveCardCountsForStreamers } from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))

describe('getActiveCardCountsForStreamers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('複数streamerを1回のDrizzle batch queryで集計する', async () => {
    const rows = [
      { id: 'card-1', streamer_id: 'streamer-a' },
      { id: 'card-2', streamer_id: 'streamer-a' },
      { id: 'card-3', streamer_id: 'streamer-b' },
    ]
    const limit = vi.fn().mockResolvedValue(rows)
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    vi.mocked(getDb).mockResolvedValue({
      db: { select },
      sql: {},
    } as any)

    const result = await getActiveCardCountsForStreamers([
      'streamer-a',
      'streamer-b',
      'streamer-a',
      '',
    ])

    expect(select).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith({
      id: cardsTable.id,
      streamer_id: cardsTable.streamer_id,
    })
    expect(from).toHaveBeenCalledWith(cardsTable)
    expect(limit).toHaveBeenCalledWith(1000)
    expect(result.get('streamer-a')).toEqual({
      totalActive: 2,
      activeCardIds: new Set(['card-1', 'card-2']),
    })
    expect(result.get('streamer-b')).toEqual({
      totalActive: 1,
      activeCardIds: new Set(['card-3']),
    })
  })

  it('空入力ではDB接続を取得せず空Mapを返す', async () => {
    await expect(getActiveCardCountsForStreamers([])).resolves.toEqual(new Map())
    expect(getDb).not.toHaveBeenCalled()
  })
})
