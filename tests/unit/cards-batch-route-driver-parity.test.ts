/**
 * #663: POST /api/cards/batch の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/battle-routes-driver-parity.test.ts と同じ流儀。cards への一括
 * INSERT(書き込み)を含むハンドラのため、DB_DRIVER=pg のときのみ pg 経路に
 * 切り替わる(pg-read では postgrest のまま = getDb 不使用)。
 *
 * rarity_weights は全テストで null にして recalculateIfAutoMode の内部クエリを
 * 発火させない(本ハンドラの本質と無関係な副経路のため単純化する)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/cards/batch/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

const SESSION = {
  twitchUserId: 'user1',
  twitchUsername: 'streamer',
  twitchDisplayName: 'Streamer',
  twitchProfileImageUrl: '',
  broadcasterType: 'affiliate' as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60000,
  })
}

interface PostgrestResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResponse[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  )
  const insertCalls: Array<{ table: string; values: unknown }> = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`)
    }
    const response = queue.length > 1 ? queue.shift()! : queue[0]
    const resolved = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      insert: vi.fn((values: unknown) => {
        insertCalls.push({ table, values })
        return builder
      }),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, insertCalls }
}

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  inserts?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  const insertCalls: Array<{ table: unknown; values?: unknown }> = []

  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null])) : row
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const call: { table: unknown; values?: unknown } = { table }
      insertCalls.push(call)
      const responses = config.inserts ?? [{ rows: [] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const builder: any = {
        values: vi.fn((values: unknown) => {
          call.values = values
          return builder
        }),
        returning: vi.fn(() =>
          response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
        ),
      }
      return builder
    }),
  }
  return { db, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('POST /api/cards/batch（読み書き混在: DB_DRIVER=pg のときのみ pg 経路）', () => {
  const STREAMER_ROW = { id: 'streamer1', rarity_weights: null }
  const CREATED_ROWS = [
    { id: 'card1', streamer_id: 'streamer1', name: 'A', description: '', image_url: 'https://example.com/a.png', rarity: 'common', drop_rate: 0.5 },
    { id: 'card2', streamer_id: 'streamer1', name: 'B', description: '', image_url: 'https://example.com/b.png', rarity: 'rare', drop_rate: 0.2 },
  ]

  function createRequest(body: Record<string, unknown> = {
    streamerId: 'streamer1',
    cards: [
      { name: 'A', imageUrl: 'https://example.com/a.png', rarity: 'common', dropRate: 0.5 },
      { name: 'B', imageUrl: 'https://example.com/b.png', rarity: 'rare', dropRate: 0.2 },
    ],
  }): NextRequest {
    return new NextRequest('http://localhost/api/cards/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(SESSION)
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body と cards への一括 INSERT 値が一致する', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_ROWS }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ rows: CREATED_ROWS }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual(expect.objectContaining({ success: true, created: 2 }))

    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(cardsTable)
    expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values)
    expect(pg.insertCalls[0].values).toEqual([
      expect.objectContaining({ streamer_id: 'streamer1', name: 'A', drop_rate: 0.5 }),
      expect.objectContaining({ streamer_id: 'streamer1', name: 'B', drop_rate: 0.2 }),
    ])
  })

  it('streamer が所有者と一致しない: 両経路とも 403 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ streamers: [{ data: null }] })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(403)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('INSERT 失敗: 両経路とも 500 + 同一 body(二重作成防止のためリトライされない)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ error: { message: 'boom' } }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await POST(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: { code: '08006', message: 'connection failure' } }],
    })
    primePgDb(pg)
    const pgRes = await POST(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
    // 非冪等のためリトライは発生せず、INSERT は 1 回だけ試行される
    expect(pg.insertCalls).toHaveLength(1)
  })

  it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま(getDb 不使用)', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_ROWS }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    const res = await POST(createRequest())
    expect(res.status).toBe(200)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない(挙動不変の検証)', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      streamers: [{ data: STREAMER_ROW }],
      cards: [{ data: CREATED_ROWS }],
    })
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await POST(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
