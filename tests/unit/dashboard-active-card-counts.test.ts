/**
 * 複数配信者のactive card集計をPlanetScale/Drizzle境界で検証する。
 * 1配信者ずつ問い合わせるN+1へ退行しないことと、重複IDの前処理を同時に固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveCardCountsForCollectedStreamers,
  getActiveCardCountsForStreamers,
} from '@/lib/dashboard-data'
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

/**
 * 新旧集計関数の parity 固定テスト (#1986)。
 *
 * #1981 で getActiveCardCountsForCollectedStreamers（非相関副問い合わせ: raw SQL +
 * inArray で所持配信者集合をDB側解決）を追加した際、初版は「所持しているアクティブ
 * カードだけ」を返しており、進捗表示の分母 (totalActive) が壊れる退行がレビューで
 * 指摘・修正された。同種の退行をCIで検出するため、所持配信者ID群を明示する旧関数
 * （Drizzle クエリビルダ版）と新関数が同一の Map を返すことを固定する。
 *
 * fixture: streamer-a はアクティブ3種のうち1種のみ所持、streamer-b は非アクティブ
 * カードのみ所持（= 所持配信者だがアクティブ所持は0種）。どちらの配信者でも
 * totalActive / activeCardIds が「配信者の全アクティブカード」であることを要求する。
 */
describe('getActiveCardCountsForCollectedStreamers との parity (#1986)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('所持配信者について新旧両関数が同一の Map を返す', async () => {
    // DB 上のアクティブカード全集（副問い合わせが解決する所持配信者 a, b のもの）。
    // モックは where 句を評価しないため、正しい実装では両関数ともこの行をそのまま
    // 集計する。a-active-2/3 は未所持だが返るべき行であり、「所持分だけ返す」退行は
    // totalActive=1 になって検出できる。
    const activeRows = [
      { id: 'a-active-1', streamer_id: 'streamer-a' }, // 所持
      { id: 'a-active-2', streamer_id: 'streamer-a' }, // 未所持
      { id: 'a-active-3', streamer_id: 'streamer-a' }, // 未所持
      { id: 'b-active-1', streamer_id: 'streamer-b' }, // 未所持（bは非アクティブのみ所持）
      { id: 'b-active-2', streamer_id: 'streamer-b' },
    ]
    const where = vi.fn().mockResolvedValue(activeRows)
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    vi.mocked(getDb).mockResolvedValue({
      db: { select },
      sql: {},
    } as any)

    // 旧関数: 所持配信者ID群（getUserCardCounts 等から得た集合と同じ a, b）
    const expected = await getActiveCardCountsForStreamers([
      'streamer-a',
      'streamer-b',
    ])
    // 新関数: 視聴者の twitch_user_id から所持配信者集合を副問い合わせで解決
    const actual = await getActiveCardCountsForCollectedStreamers('twitch-user-1')

    // Map 全体の一致（キー集合・totalActive・activeCardIds の Set が同一）
    expect(actual).toEqual(expected)

    // 「全アクティブカードが分母」であることを明示的に固定する。
    // 所持アクティブのみ返す退行では a は totalActive=1 になる。
    expect(actual.get('streamer-a')).toEqual({
      totalActive: 3,
      activeCardIds: new Set(['a-active-1', 'a-active-2', 'a-active-3']),
    })
    // 非アクティブカードしか持たない配信者も「所持配信者」であり、
    // その全アクティブカードが分母に入る（進捗 0/2 で表示されるべき）。
    expect(actual.get('streamer-b')).toEqual({
      totalActive: 2,
      activeCardIds: new Set(['b-active-1', 'b-active-2']),
    })
    // 所持していない配信者のキーは混入しない。
    expect(actual.has('streamer-c')).toBe(false)
  })
})
