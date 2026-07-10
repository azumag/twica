/**
 * #663: src/lib/sentry/error-handler.ts の errors テーブル書き込みの
 * postgrest 経路 / pg 経路の互換テスト。
 *
 * この経路はエラー報告そのものであり、二次障害（エラー記録の失敗が本来のリクエスト
 * 処理の失敗に化けること）を起こさない設計になっている（実装コメント参照）。
 * そのため通常のパリティ検証（INSERT に渡る値の一致）に加えて、
 * 「DB 書き込みが失敗しても reportError 自体は必ず resolve し、console.warn 1回の
 * ログのみで握り潰される」という失敗時の外部挙動パリティを重点的に検証する。
 *
 * tests/unit/sentry-error-handler.test.ts（postgrest 経路の既存テスト）のモック方法を
 * 踏襲しつつ、pg 経路（DB_DRIVER=pg で isPgWriteEnabled() が分岐）を追加する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reportError, reportApiError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { errors as errorsTable } from '@/lib/db/schema'

// withDbRetry は失敗時に logger.warn（[DB Retry] [db:pg] ... タグ付き）を1行出す。
// これは実装上正しい観測用ログであり、error-handler.ts の catch 節が出す
// console.warn（'[Error Tracking] Failed to log error to Supabase:'）とは別物のため、
// ここでは logger をモックして分離し、catch 節のログ回数のみをアサーションの対象にする。
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from('errors').insert(values)
// ---------------------------------------------------------------------------

function createSupabaseClientMock(options: { rejects?: unknown } = {}) {
  const insertCalls: unknown[] = []
  const from = vi.fn(() => ({
    insert: vi.fn((values: unknown) => {
      insertCalls.push(values)
      return options.rejects ? Promise.reject(options.rejects) : Promise.resolve({ error: null })
    }),
  }))
  return { from, insertCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.insert(errorsTable).values(values)
// ---------------------------------------------------------------------------

function createDrizzleDbMock(options: { rejects?: unknown } = {}) {
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = []
  const db = {
    insert: vi.fn((table: unknown) => {
      const call: { table: unknown; values?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return options.rejects ? Promise.reject(options.rejects) : Promise.resolve([])
        }),
      }
    }),
  }
  return { db, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('sentry/error-handler (errors テーブル書き込み): postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路とも INSERT に渡る値（列・切り詰め・サニタイズ済み context・environment）が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    await expect(
      reportError(new Error('boom'), { userId: 'secret-uid', safe: 'visible' })
    ).resolves.toBeUndefined()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    await expect(
      reportError(new Error('boom'), { userId: 'secret-uid', safe: 'visible' })
    ).resolves.toBeUndefined()

    expect(client.insertCalls).toHaveLength(1)
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(errorsTable)

    const postgrestValues = client.insertCalls[0] as Record<string, unknown>
    const pgValues = pg.insertCalls[0].values as Record<string, unknown>

    // stack_trace はスタック文字列由来で完全一致はしないため個別に比較し、
    // それ以外のフィールドは deepEqual で突き合わせる
    const { stack_trace: pgStack, ...pgRest } = pgValues
    const { stack_trace: postgrestStack, ...postgrestRest } = postgrestValues
    expect(typeof pgStack).toBe('string')
    expect(typeof postgrestStack).toBe('string')
    expect(pgRest).toEqual(postgrestRest)
    expect(pgRest).toEqual({
      error_type: '[Error]',
      message: 'boom',
      // sanitizeContext による機密情報マスキング（userId は EXACT_SENSITIVE_KEYS）
      context: { userId: '[REDACTED]', safe: 'visible' },
      environment: 'production',
    })
  })

  it('NEXT_PUBLIC_APP_URL に preview を含む場合: 両経路とも environment: preview で記録する', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://preview.example.com'

    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    await reportError(new Error('boom'))

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    await reportError(new Error('boom'))

    expect((client.insertCalls[0] as any).environment).toBe('preview')
    expect(pg.insertCalls[0].values?.environment).toBe('preview')
  })

  it('DB 書き込み失敗時: 両経路とも reportError は throw せず resolve し、console.warn 1回のみで握り潰される', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ rejects: new Error('db down') })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    await expect(reportError(new Error('boom'))).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[Error Tracking] Failed to log error to Supabase:',
      expect.any(Error)
    )

    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ rejects: new Error('db down') })
    primePgDb(pg)
    await expect(reportError(new Error('boom'))).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[Error Tracking] Failed to log error to Supabase:',
      expect.any(Error)
    )
  })

  it('reportApiError: 両経路とも context (endpoint/method 付き) が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    await reportApiError('/api/x', 'POST', new Error('fail'), { extra: 'data' })

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock()
    primePgDb(pg)
    await reportApiError('/api/x', 'POST', new Error('fail'), { extra: 'data' })

    const postgrestValues = client.insertCalls[0] as Record<string, unknown>
    const pgValues = pg.insertCalls[0].values as Record<string, unknown>
    expect(pgValues.error_type).toBe(postgrestValues.error_type)
    expect(pgValues.message).toBe(postgrestValues.message)
    expect(pgValues.context).toEqual(postgrestValues.context)
    expect(pgValues.context).toEqual({ endpoint: '/api/x', method: 'POST', extra: 'data' })
  })

  it('DB_DRIVER 未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await reportError(new Error('boom'))

    expect(getDb).not.toHaveBeenCalled()
  })
})
