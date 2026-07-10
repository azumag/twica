/**
 * #663: src/lib/validations.ts の validateDropRateSum の postgrest 経路 / pg 経路の
 * 互換テスト。
 *
 * validateDropRateSum は supabaseAdmin を引数で受け取る形のため、postgrest 経路は
 * その引数のモックをそのまま使い、pg 経路（isPgReadEnabled() で分岐）は引数を無視して
 * getDb() 経由で内部完結する（Phase 4 の PostgREST 撤去時に引数ごと削除予定という
 * 実装コメントの通り、pg 経路では supabaseAdmin 引数への呼び出しが一切発生しないことも
 * あわせて検証する）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { validateDropRateSum } from '@/lib/validations'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const STREAMER_ID = 'streamer-1'

/** cards テーブルの行 fixture（is_active = true の 2 件 + 除外対象 1 件） */
const CARD_ROWS = [
  { id: 'card-1', drop_rate: 0.3 },
  { id: 'card-2', drop_rate: 0.2 },
  { id: 'card-exclude', drop_rate: 0.4 },
]

// ---------------------------------------------------------------------------
// postgrest 経路のモック: 引数で渡す supabaseAdmin 相当のクライアント
// ---------------------------------------------------------------------------

function createSupabaseAdminMock(options: { error?: unknown; rows?: Array<{ id: string; drop_rate: number }> } = {}) {
  const from = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({
        data: options.error ? null : (options.rows ?? CARD_ROWS),
        error: options.error ?? null,
      }).then(onFulfilled, onRejected),
  }))
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(fields).from(cards).where(and(eq, eq))
// ---------------------------------------------------------------------------

interface PgCallRecord {
  table: unknown
  where?: unknown
}

function createDrizzleDbMock(options: { error?: unknown; rows?: Array<{ id: string; drop_rate: number }> } = {}) {
  const calls: PgCallRecord[] = []
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const call: PgCallRecord = { table }
        calls.push(call)
        const builder: any = {
          where: vi.fn((condition: unknown) => {
            call.where = condition
            return builder
          }),
          then: (onFulfilled: any, onRejected: any) => {
            const result = options.error
              ? Promise.reject(options.error)
              : Promise.resolve(
                  (options.rows ?? CARD_ROWS).map((row) =>
                    Object.fromEntries(Object.keys(fields).map((key) => [key, (row as any)[key] ?? null]))
                  )
                )
            return result.then(onFulfilled, onRejected)
          },
        }
        return builder
      }),
    })),
  }
  return { db, calls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('validateDropRateSum: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('合計が100%以内: 両経路とも { valid: true } を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const supabaseAdmin = createSupabaseAdminMock()
    const postgrestResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1, 'card-exclude')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const pgResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1, 'card-exclude')

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toEqual({ valid: true })
  })

  it('合計が100%を超過: 両経路とも同一のエラーメッセージで { valid: false } を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const supabaseAdmin = createSupabaseAdminMock()
    // 除外なしで新規 0.5 を追加 → 0.3+0.2+0.4+0.5 = 1.4 > 1.0
    const postgrestResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.5)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const pgResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.5)

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toEqual({
      valid: false,
      error: 'Total drop rate would be 140.0% (max 100%). Current: 90.0%, New: 50.0%',
    })
  })

  it('クエリ失敗: 両経路とも同一のエラーメッセージで { valid: false } を返す（例外を投げない）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const supabaseAdmin = createSupabaseAdminMock({ error: { message: 'boom' } })
    const postgrestResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1)

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ error: new Error('boom') })
    primePgDb(pg)
    const pgResult = await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1)

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toEqual({ valid: false, error: 'Failed to validate drop rates' })
  })

  it('pg クエリが streamer_id + is_active=true の AND 条件で正しい実引数で発行される', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock()
    primePgDb(pg)

    await validateDropRateSum({} as any, STREAMER_ID, 0.1)

    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0].table).toBe(cardsTable)
    expect(pg.calls[0].where).toEqual(
      and(eq(cardsTable.streamer_id, STREAMER_ID), eq(cardsTable.is_active, true))
    )
  })

  it('pg 経路では引数の supabaseAdmin が一切呼ばれない（Phase 4 で引数ごと削除予定の根拠）', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    const supabaseAdmin = createSupabaseAdminMock()

    await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1)

    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('フラグ未設定では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const supabaseAdmin = createSupabaseAdminMock()

    await validateDropRateSum(supabaseAdmin as any, STREAMER_ID, 0.1)

    expect(getDb).not.toHaveBeenCalled()
  })
})
