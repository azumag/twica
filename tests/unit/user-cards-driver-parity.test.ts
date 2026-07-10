/**
 * #663: /api/user-cards (GET) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/tos-accept-driver-parity.test.ts / announcements-driver-parity.test.ts と
 * 同じ流儀。GET は読み取り専用のため isPgReadEnabled() で分岐し、DB_DRIVER=pg-read
 * でも pg 経路に切り替わることを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { GET } from '@/app/api/user-cards/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { userCards as userCardsTable, users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return { ...actual, checkRateLimit: vi.fn() }
})
vi.mock('@/lib/sentry/error-handler', () => ({
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

const MOCK_SESSION = {
  twitchUserId: 'user123',
  twitchUsername: 'testuser',
  twitchDisplayName: 'TestUser',
  twitchProfileImageUrl: '',
  broadcasterType: '' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const USER_ROW = { id: 'u1', twitch_user_id: 'user123' }
const USER_CARDS_ROWS = [
  { id: 'uc-1', user_id: 'u1', card_id: 'card-1', obtained_at: '2026-01-01T00:00:00.000+00:00' },
  { id: 'uc-2', user_id: 'u1', card_id: 'card-2', obtained_at: '2026-01-02T00:00:00.000+00:00' },
]

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/user-cards')
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from() 呼び出しごとに応答キューを消費する thenable builder
// （support-inquiries-api-driver-parity.test.ts と同方式）
// ---------------------------------------------------------------------------

interface SupabaseResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: SupabaseResponse[]) {
  let index = 0
  const from = vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const result = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      range: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts と同方式）
// ---------------------------------------------------------------------------

interface PgSelectCall {
  fields: Record<string, unknown>
  where?: unknown
  limit?: number
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[] } = {}) {
  let selectIndex = 0
  const selectCalls: PgSelectCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: PgSelectCall = { fields }
      selectCalls.push(call)
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60000,
  })
}

describe('/api/user-cards: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(MOCK_SESSION)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('成功時: 両経路のレスポンス body が一致する（obtained_at を含め完全一致）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: USER_CARDS_ROWS }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { rows: USER_CARDS_ROWS }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgBody = await pgRes.json()

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(200)
    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual(USER_CARDS_ROWS)

    // .range(0, 9999) 対応の LIMIT 10000（実装コメント参照）と user_id 条件のパリティ
    expect(pg.selectCalls[1].where).toEqual(eq(userCardsTable.user_id, 'u1'))
    expect(pg.selectCalls[1].limit).toBe(10000)
    expect(pg.selectCalls[0].where).toEqual(eq(usersTable.twitch_user_id, 'user123'))
    expect(pg.selectCalls[0].limit).toBe(1)
  })

  it('所持カード 0 件: 両経路とも空配列を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: [] }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())
    const postgrestBody = await postgrestRes.json()

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [USER_ROW] }, { rows: [] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())
    const pgBody = await pgRes.json()

    expect(pgBody).toEqual(postgrestBody)
    expect(pgBody).toEqual([])
  })

  it('ユーザー不在: 両経路とも 500 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: null }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    const pgBody = await pgRes.json()
    expect(pgBody).toEqual(await postgrestRes.json())
    expect(pgBody).toEqual({ error: 'Database error' })
  })

  it('ユーザー取得失敗: 両経路とも 500 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ error: { message: 'boom' } }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      selects: [{ error: { code: '08006', message: 'connection_failure' } }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('user_cards 取得失敗: 両経路とも 500 + 同一 body', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: USER_ROW }, { error: { message: 'boom' } }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)
    const postgrestRes = await GET(createRequest())

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      selects: [{ rows: [USER_ROW] }, { error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)
    const pgRes = await GET(createRequest())

    expect(pgRes.status).toBe(postgrestRes.status)
    expect(pgRes.status).toBe(500)
    expect(await pgRes.json()).toEqual(await postgrestRes.json())
  })

  it('未認証: 両経路とも 401（フラグに依らず同一）', async () => {
    mockGetSession.mockResolvedValue(null)
    for (const driver of [undefined, 'pg-read']) {
      vi.stubEnv('DB_DRIVER', driver)
      const res = await GET(createRequest())
      expect(res.status).toBe(401)
    }
    expect(getDb).not.toHaveBeenCalled()
  })

  it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock([{ data: USER_ROW }, { data: USER_CARDS_ROWS }])
    mockGetSupabaseAdmin.mockReturnValue(client as any)

    await GET(createRequest())
    expect(getDb).not.toHaveBeenCalled()
  })
})
