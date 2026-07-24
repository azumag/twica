/** #663: PlanetScale直結後の validateDropRateSum クエリと判定の回帰テスト。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { validateDropRateSum } from '@/lib/validations'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

const CARD_ROWS = [
  { id: 'card-1', drop_rate: 0.3 },
  { id: 'card-2', drop_rate: 0.5 },
  { id: 'card-3', drop_rate: 0.1 },
]

function createDrizzleDbMock(rows: unknown = CARD_ROWS) {
  const calls: Array<{ table: unknown; whereCondition?: unknown }> = []
  return {
    calls,
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const call: { table: unknown; whereCondition?: unknown } = { table }
        calls.push(call)
        const projected = (rows as Array<Record<string, unknown>>).map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
        )
        const builder: any = {
          where: vi.fn((condition: unknown) => {
            call.whereCondition = condition
            return builder
          }),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(projected).then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
  }
}

describe('validateDropRateSum: PlanetScale経路 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('合計が100%以下なら valid:true を返す', async () => {
    const pg = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await validateDropRateSum('streamer-1', 0.05)

    expect(pgResult).toEqual({ valid: true })
  })

  it('合計が100%を超える場合、エラーメッセージを返す', async () => {
    const pg = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await validateDropRateSum('streamer-1', 0.5)

    expect(pgResult.valid).toBe(false)
    expect(pgResult.error).toContain('max 100%')
  })

  it('excludeCardId で除外したカードは合計に含まれない', async () => {
    const pg = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await validateDropRateSum('streamer-1', 0.3, 'card-2')

    expect(pgResult).toEqual({ valid: true })
  })

  it('pgクエリが streamer_id・is_active=true の条件で正しい実引数で呼び出される', async () => {
    const pg = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)

    await validateDropRateSum('streamer-1', 0.05)

    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0].table).toBe(cardsTable)
    expect(pg.calls[0].whereCondition).toEqual(
      and(eq(cardsTable.streamer_id, 'streamer-1'), eq(cardsTable.is_active, true))
    )
  })

  it('pg経路で取得失敗時は既存と同じエラーメッセージを返す', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.reject(new Error('connection failure'))),
        })),
      })),
    }
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

    const result = await validateDropRateSum('streamer-1', 0.05)
    expect(result).toEqual({ valid: false, error: 'Failed to validate drop rates' })
  })
})
