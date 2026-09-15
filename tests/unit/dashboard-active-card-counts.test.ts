/**
 * 複数配信者のactive card集計をPlanetScale/Drizzle境界で検証する。
 * 1配信者ずつ問い合わせるN+1へ退行しないことと、重複IDの前処理を同時に固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveCardCountsForStreamers } from '@/lib/dashboard-data'
import { countOwnedActiveCardTypes } from '@/lib/collection-utils'
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
    const where = vi.fn().mockResolvedValue(rows)
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
    expect(result.get('streamer-a')).toEqual({
      totalActive: 2,
      activeCardIds: new Set(['card-1', 'card-2']),
    })
    expect(result.get('streamer-b')).toEqual({
      totalActive: 1,
      activeCardIds: new Set(['card-3']),
    })
  })

  it('合計1000種類を超えても後方の配信者を4/4と誤判定しない', async () => {
    // 先行配信者996種類に続く139種類のうち102種類を所有。
    // SQL LIMITを適用する境界を再現し、旧実装では4/4になる配置にする。
    const targetRows = Array.from({ length: 139 }, (_, i) => ({
      id: `target-${i}`, streamer_id: 'target',
    }))
    const rows = [
      ...Array.from({ length: 996 }, (_, i) => ({
        id: `other-${i}`, streamer_id: 'other',
      })),
      ...targetRows,
    ]
    const query = Object.assign(Promise.resolve(rows), {
      limit: (count: number) => Promise.resolve(rows.slice(0, count)),
    })
    vi.mocked(getDb).mockResolvedValue({
      db: { select: () => ({ from: () => ({ where: () => query }) }) },
      sql: {},
    } as any)

    const result = await getActiveCardCountsForStreamers(['other', 'target'])
    const target = result.get('target')!
    const owned = countOwnedActiveCardTypes(targetRows.slice(0, 102), target.activeCardIds)
    expect(target.totalActive).toBe(139)
    expect(owned).toBe(102)
    expect(Math.round(owned / target.totalActive * 100)).toBe(73)
    expect(owned >= target.totalActive).toBe(false)
    expect(result.get('other')?.totalActive).toBe(996)
  })

  it('空入力ではDB接続を取得せず空Mapを返す', async () => {
    await expect(getActiveCardCountsForStreamers([])).resolves.toEqual(new Map())
    expect(getDb).not.toHaveBeenCalled()
  })
})
