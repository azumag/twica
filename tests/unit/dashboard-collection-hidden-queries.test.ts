/**
 * #1953: マイコレクション一覧用の追加クエリ。
 * 失敗しても一覧を壊さない縮退（reportError + 空の結果）を固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getHiddenCollectionStreamerIds,
  getLastObtainedAtByStreamer,
} from '@/lib/dashboard-data'
import { getDb } from '@/lib/db/client'
import { reportError } from '@/lib/sentry/error-handler'
import { userCollectionHiddenStreamers as hiddenTable } from '@/lib/db/schema'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))

describe('getHiddenCollectionStreamerIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('当該ユーザーの非表示 streamer_id を Set で返す', async () => {
    const where = vi.fn().mockResolvedValue([{ streamer_id: 's1' }, { streamer_id: 's2' }])
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as any)

    const result = await getHiddenCollectionStreamerIds('user123')

    expect(result).toEqual(new Set(['s1', 's2']))
    expect(select).toHaveBeenCalledWith({ streamer_id: hiddenTable.streamer_id })
    expect(from).toHaveBeenCalledWith(hiddenTable)
    expect(where).toHaveBeenCalledOnce()
    expect(reportError).not.toHaveBeenCalled()
  })

  it('migration 未適用(42P01)は報告せず「非表示なし」で返す', async () => {
    const error = Object.assign(new Error('relation does not exist'), { code: '42P01' })
    vi.mocked(getDb).mockResolvedValue({
      db: { select: () => ({ from: () => ({ where: () => Promise.reject(error) }) }) },
      sql: {},
    } as any)

    const result = await getHiddenCollectionStreamerIds('user123')

    expect(result).toEqual(new Set())
    expect(reportError).not.toHaveBeenCalled()
  })

  it('その他のDBエラーは reportError して空の Set（全件表示）に縮退する', async () => {
    vi.mocked(getDb).mockResolvedValue({
      db: { select: () => ({ from: () => ({ where: () => Promise.reject(new Error('boom')) }) }) },
      sql: {},
    } as any)

    const result = await getHiddenCollectionStreamerIds('user123')

    expect(result).toEqual(new Set())
    expect(reportError).toHaveBeenCalledOnce()
  })
})

describe('getLastObtainedAtByStreamer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function primeSelect(result: Promise<unknown>) {
    const groupBy = vi.fn(() => result)
    const where = vi.fn(() => ({ groupBy }))
    const innerJoin2 = vi.fn(() => ({ where }))
    const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }))
    const from = vi.fn(() => ({ innerJoin: innerJoin1 }))
    vi.mocked(getDb).mockResolvedValue({ db: { select: () => ({ from }) }, sql: {} } as any)
    return { groupBy, innerJoin1, innerJoin2 }
  }

  it('配信者IDごとの最終獲得日時を Map で返す（user_cards→users→cards を JOIN して1回で集計）', async () => {
    const q = primeSelect(
      Promise.resolve([
        { streamer_id: 's1', last_obtained_at: '2026-10-20T00:00:00.000000Z' },
        { streamer_id: 's2', last_obtained_at: null },
      ]),
    )

    const result = await getLastObtainedAtByStreamer('user123')

    expect(result.get('s1')).toBe('2026-10-20T00:00:00.000000Z')
    expect(result.get('s2')).toBeNull()
    expect(q.innerJoin1).toHaveBeenCalledOnce()
    expect(q.innerJoin2).toHaveBeenCalledOnce()
    expect(q.groupBy).toHaveBeenCalledOnce()
  })

  it('失敗時は reportError して空の Map を返す（ページを壊さない）', async () => {
    primeSelect(Promise.reject(new Error('boom')))

    const result = await getLastObtainedAtByStreamer('user123')

    expect(result.size).toBe(0)
    expect(reportError).toHaveBeenCalledOnce()
  })
})
