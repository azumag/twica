/**
 * #663: support-inquiries API ルート群の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/support-inquiries-api.test.ts のモック方法（session / plan / csrf /
 * rate-limit）と、announcements / sub-check の parity テストの流儀（同一 fixture を
 * 両経路に与えて HTTP ステータス・レスポンス body・副作用（insert/delete に渡る値）
 * を突き合わせる）を組み合わせる。
 *
 * フラグの使い分け（実装コメント参照）:
 * - GET（一覧・詳細）は読み取り専用 → DB_DRIVER=pg-read でも pg 経路
 * - POST（作成・返信）/ DELETE は書き込みを含む → DB_DRIVER=pg のときのみ pg 経路
 *   （pg-read では postgrest 経路のまま = getDb 不使用）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { GET, POST } from '@/app/api/support-inquiries/route'
import { DELETE as DELETE_DETAIL, GET as GET_DETAIL } from '@/app/api/support-inquiries/[id]/route'
import { POST as POST_MESSAGE } from '@/app/api/support-inquiries/[id]/messages/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { getDb } from '@/lib/db/client'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/plan')
vi.mock('@/lib/csrf')
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}))

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetUserPlan = vi.mocked(getUserPlan)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)

const MOCK_SESSION = {
  twitchUserId: 'user123',
  twitchUsername: 'testuser',
  twitchDisplayName: 'TestUser',
  twitchProfileImageUrl: '',
  broadcasterType: '' as const,
  expiresAt: Date.now() + 100000,
  version: 1,
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

/** 一覧・詳細 fixture（日付は Z 終端 ISO: 正規化が恒等変換になり両経路比較が成立） */
const INQUIRY_ROW = {
  id: VALID_UUID,
  twitch_user_id: 'user123',
  twitch_display_name: 'TestUser',
  category: 'bug',
  subject: 'テストバグ',
  body: 'バグの説明',
  status: 'open',
  created_at: '2026-01-02T03:04:05.000Z',
  updated_at: '2026-01-03T04:05:06.000Z',
}

const MESSAGE_ROW = {
  id: 'msg-1',
  inquiry_id: VALID_UUID,
  sender_type: 'user',
  sender_id: 'user123',
  body: '追記です',
  created_at: '2026-01-04T05:06:07.000Z',
}

/** pg 直結が返す PG テキスト形式のタイムスタンプ（正規化テスト用） */
const PG_TEXT_TIMESTAMP = '2026-01-02 03:04:05.123456+00'
const PG_TEXT_TIMESTAMP_ISO = '2026-01-02T03:04:05.123Z'

// ---------------------------------------------------------------------------
// リクエスト生成（tests/unit/support-inquiries-api.test.ts と同形式）
// ---------------------------------------------------------------------------

function createGetRequest(path = '/api/support-inquiries'): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`))
}

function createPostRequest(
  body: Record<string, unknown>,
  path = '/api/support-inquiries'
): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function createDeleteRequest(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from() 呼び出しごとに応答キューを消費する thenable builder。
// select/eq/order/insert/delete のチェーン引数を記録し、pg 経路の副作用と突き合わせる。
// ---------------------------------------------------------------------------

interface SupabaseResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: SupabaseResponse[]) {
  let index = 0
  const insertCalls: Array<Record<string, unknown>> = []
  const deleteCallCount = { value: 0 }
  const from = vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const result = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      insert: vi.fn((values: Record<string, unknown>) => {
        insertCalls.push(values)
        return builder
      }),
      delete: vi.fn(() => {
        deleteCallCount.value += 1
        return builder
      }),
      single: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from, insertCalls, deleteCallCount }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（announcements/sub-check の parity テストと同方式）:
// db.select / db.insert / db.delete の thenable builder。実引数を記録し、
// select は「指定された列だけ」を fixture 行から射影して返す。
// ---------------------------------------------------------------------------

interface PgCallRecord {
  kind: 'select' | 'insert' | 'delete'
  table?: unknown
  values?: Record<string, unknown>
  where?: unknown
  orderBy?: unknown
  limit?: number
  returning?: Record<string, unknown>
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: {
  selects?: PgResponse[]
  inserts?: PgResponse[]
  deletes?: PgResponse[]
} = {}) {
  let selectIndex = 0
  let insertIndex = 0
  let deleteIndex = 0
  const calls: PgCallRecord[] = []

  const makeResolve = (response: PgResponse) => () =>
    response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: PgCallRecord = { kind: 'select' }
      calls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn((table: unknown) => {
          call.table = table
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition
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
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: PgCallRecord = { kind: 'insert', table }
      calls.push(call)
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returning = selection
          return makeResolve(response)()
        }),
      }
      return builder
    }),
    delete: vi.fn((table: unknown) => {
      const responses = config.deletes ?? [{ rows: [] }]
      const response = responses[Math.min(deleteIndex, responses.length - 1)]
      deleteIndex += 1
      const call: PgCallRecord = { kind: 'delete', table }
      calls.push(call)
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returning = selection
          return makeResolve(response)()
        }),
      }
      return builder
    }),
  }
  return { db, calls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function allowRateLimit() {
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: Date.now() + 60000,
  })
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('support-inquiries API: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    allowRateLimit()
    mockGetSession.mockResolvedValue(MOCK_SESSION)
    mockGetUserPlan.mockResolvedValue('support')
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('GET /api/support-inquiries（読み取り: pg-read で pg 経路）', () => {
    it('同一 fixture で両経路のステータス・body が一致する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: [INQUIRY_ROW] }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await GET(createGetRequest())
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [INQUIRY_ROW] }] })
      primePgDb(pg)
      const pgRes = await GET(createGetRequest())
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ inquiries: [INQUIRY_ROW] })
      expect(pg.calls[0].table).toBe(supportInquiriesTable)
      expect(pg.calls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, 'user123'))
    })

    it('pg 経路は PG テキスト形式の日付を ISO 8601 に正規化して返す', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [{ ...INQUIRY_ROW, created_at: PG_TEXT_TIMESTAMP, updated_at: PG_TEXT_TIMESTAMP }] },
        ],
      })
      primePgDb(pg)

      const res = await GET(createGetRequest())
      const body = await res.json()
      expect(body.inquiries[0].created_at).toBe(PG_TEXT_TIMESTAMP_ISO)
      expect(body.inquiries[0].updated_at).toBe(PG_TEXT_TIMESTAMP_ISO)
    })

    it('DB エラー時は両経路とも 500 + 同一 body', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ error: { message: 'boom' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await GET(createGetRequest())

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)
      const pgRes = await GET(createGetRequest())

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })
  })

  describe('POST /api/support-inquiries（書き込み: pg のみ pg 経路）', () => {
    const REQUEST_BODY = { category: 'bug', subject: '  件名  ', body: '  本文  ' }

    it('両経路とも 201 + { id } を返し、insert に渡る値（trim 済み）が一致する', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: { id: 'new-inq-id' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createPostRequest(REQUEST_BODY))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ inserts: [{ rows: [{ id: 'new-inq-id' }] }] })
      primePgDb(pg)
      const pgRes = await POST(createPostRequest(REQUEST_BODY))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(201)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())

      // insert に渡る値のパリティ（github_issue_created 等を明示指定していないこと
      // も含めて完全一致 = Cron Worker の Issue 通知 (#643) トリガ挙動が両経路で同一）
      expect(pg.calls[0].table).toBe(supportInquiriesTable)
      expect(pg.calls[0].values).toEqual(client.insertCalls[0])
      expect(pg.calls[0].values).toEqual({
        twitch_user_id: 'user123',
        twitch_display_name: 'TestUser',
        category: 'bug',
        subject: '件名',
        body: '本文',
      })
      expect(pg.calls[0].returning).toEqual({ id: supportInquiriesTable.id })
    })

    it('INSERT 失敗時は両経路とも 500 + 同一 body', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ error: { message: 'boom' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await POST(createPostRequest(REQUEST_BODY))

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        inserts: [{ error: { code: '23514', message: 'check constraint' } }],
      })
      primePgDb(pg)
      const pgRes = await POST(createPostRequest(REQUEST_BODY))

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const client = createSupabaseClientMock([{ data: { id: 'new-inq-id' } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)

      const res = await POST(createPostRequest(REQUEST_BODY))
      expect(res.status).toBe(201)
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/support-inquiries/[id]（読み取り: pg-read で pg 経路）', () => {
    function run(driver: string | undefined) {
      if (driver === undefined) {
        vi.stubEnv('DB_DRIVER', undefined)
      } else {
        vi.stubEnv('DB_DRIVER', driver)
      }
      return GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      })
    }

    it('同一 fixture で両経路のステータス・body が一致する', async () => {
      const client = createSupabaseClientMock([
        { data: INQUIRY_ROW },
        { data: [MESSAGE_ROW] },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({
        selects: [{ rows: [INQUIRY_ROW] }, { rows: [MESSAGE_ROW] }],
      })
      primePgDb(pg)
      const pgRes = await run('pg-read')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())

      // 所有権チェック込みの where + PRIMARY KEY 根拠の limit(1)
      expect(pg.calls[0].where).toEqual(
        and(
          eq(supportInquiriesTable.id, VALID_UUID),
          eq(supportInquiriesTable.twitch_user_id, 'user123')
        )
      )
      expect(pg.calls[0].limit).toBe(1)
      expect(pg.calls[1].table).toBe(supportInquiryMessagesTable)
    })

    it('存在しない / 他ユーザーの問い合わせは両経路とも 404 + 同一 body', async () => {
      const client = createSupabaseClientMock([
        { data: null, error: { code: 'PGRST116', message: '0 rows' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgRes = await run('pg-read')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(404)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('問い合わせ取得の DB エラーは両経路とも 404（既存実装の error → 404 に合わせる）', async () => {
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)
      const pgRes = await run('pg-read')
      expect(pgRes.status).toBe(404)
    })

    it('メッセージ取得エラーは両経路とも 200 + messages: [] で継続する', async () => {
      const client = createSupabaseClientMock([
        { data: INQUIRY_ROW },
        { data: null, error: { message: 'boom' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({
        selects: [
          { rows: [INQUIRY_ROW] },
          { error: { code: '42601', message: 'syntax error' } },
        ],
      })
      primePgDb(pg)
      const pgRes = await run('pg-read')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })
  })

  describe('DELETE /api/support-inquiries/[id]（書き込み: pg のみ pg 経路）', () => {
    function run(driver: string | undefined) {
      if (driver === undefined) {
        vi.stubEnv('DB_DRIVER', undefined)
      } else {
        vi.stubEnv('DB_DRIVER', driver)
      }
      return DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      })
    }

    it('自分の問い合わせを削除でき、両経路のステータス・body・削除条件が一致する', async () => {
      const client = createSupabaseClientMock([{ data: { id: VALID_UUID } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({ deletes: [{ rows: [{ id: VALID_UUID }] }] })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())

      // DELETE クエリ自体に所有権条件が含まれること（ID 推測による他ユーザー削除の防止）
      expect(pg.calls[0].kind).toBe('delete')
      expect(pg.calls[0].table).toBe(supportInquiriesTable)
      expect(pg.calls[0].where).toEqual(
        and(
          eq(supportInquiriesTable.id, VALID_UUID),
          eq(supportInquiriesTable.twitch_user_id, 'user123')
        )
      )
      // 既存の .select('id').single() に対応する returning（0 行削除の検出）
      expect(pg.calls[0].returning).toEqual({ id: supportInquiriesTable.id })
    })

    it('存在しない / 他ユーザーの問い合わせ（0 行削除）は両経路とも 404 + 同一 body', async () => {
      const client = createSupabaseClientMock([
        { data: null, error: { code: 'PGRST116', message: '0 rows' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({ deletes: [{ rows: [] }] })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(404)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('DELETE の DB エラーは両経路とも 404（既存実装の error → 404 に合わせる）', async () => {
      const pg = createDrizzleDbMock({
        deletes: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)
      const pgRes = await run('pg')
      expect(pgRes.status).toBe(404)
      expect(await pgRes.json()).toEqual({ error: 'Inquiry not found' })
    })

    it('DB_DRIVER=pg-read では書き込みハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
      const client = createSupabaseClientMock([{ data: { id: VALID_UUID } }])
      mockGetSupabaseAdmin.mockReturnValue(client as any)

      const res = await run('pg-read')
      expect(res.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/support-inquiries/[id]/messages（読み書き混在: pg のみ pg 経路）', () => {
    function run(driver: string | undefined, body = { body: '  返信本文  ' }) {
      if (driver === undefined) {
        vi.stubEnv('DB_DRIVER', undefined)
      } else {
        vi.stubEnv('DB_DRIVER', driver)
      }
      return POST_MESSAGE(
        createPostRequest(body, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      )
    }

    it('両経路とも 201 + { message } を返し、insert に渡る値（trim 済み）が一致する', async () => {
      const client = createSupabaseClientMock([
        { data: { id: VALID_UUID, status: 'open', twitch_user_id: 'user123' } },
        { data: { ...MESSAGE_ROW, body: '返信本文' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: VALID_UUID, status: 'open', twitch_user_id: 'user123' }] }],
        inserts: [{ rows: [{ ...MESSAGE_ROW, body: '返信本文' }] }],
      })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(201)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())

      // 所有権チェックの where + PRIMARY KEY 根拠の limit(1)
      expect(pg.calls[0].kind).toBe('select')
      expect(pg.calls[0].where).toEqual(
        and(
          eq(supportInquiriesTable.id, VALID_UUID),
          eq(supportInquiriesTable.twitch_user_id, 'user123')
        )
      )
      expect(pg.calls[0].limit).toBe(1)
      // insert に渡る値のパリティ
      expect(pg.calls[1].kind).toBe('insert')
      expect(pg.calls[1].table).toBe(supportInquiryMessagesTable)
      expect(pg.calls[1].values).toEqual(client.insertCalls[0])
      expect(pg.calls[1].values).toEqual({
        inquiry_id: VALID_UUID,
        sender_type: 'user',
        sender_id: 'user123',
        body: '返信本文',
      })
    })

    it('pg 経路は message.created_at を ISO 8601 に正規化して返す', async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: VALID_UUID, status: 'open', twitch_user_id: 'user123' }] }],
        inserts: [{ rows: [{ ...MESSAGE_ROW, created_at: PG_TEXT_TIMESTAMP }] }],
      })
      primePgDb(pg)
      const res = await run('pg')
      const body = await res.json()
      expect(body.message.created_at).toBe(PG_TEXT_TIMESTAMP_ISO)
    })

    it('存在しない / 他ユーザーの問い合わせは両経路とも 404 + 同一 body', async () => {
      const client = createSupabaseClientMock([
        { data: null, error: { code: 'PGRST116', message: '0 rows' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(404)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('closed の問い合わせへの返信は両経路とも 400 + 同一 body（INSERT は実行されない）', async () => {
      const client = createSupabaseClientMock([
        { data: { id: VALID_UUID, status: 'closed', twitch_user_id: 'user123' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: VALID_UUID, status: 'closed', twitch_user_id: 'user123' }] }],
      })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(400)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
      expect(pg.calls.filter((c) => c.kind === 'insert')).toHaveLength(0)
    })

    it('INSERT 失敗時は両経路とも 500 + 同一 body', async () => {
      const client = createSupabaseClientMock([
        { data: { id: VALID_UUID, status: 'open', twitch_user_id: 'user123' } },
        { data: null, error: { message: 'boom' } },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)
      const postgrestRes = await run(undefined)

      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: VALID_UUID, status: 'open', twitch_user_id: 'user123' }] }],
        inserts: [{ error: { code: '23514', message: 'check constraint' } }],
      })
      primePgDb(pg)
      const pgRes = await run('pg')

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('DB_DRIVER=pg-read では読み書き混在ハンドラのため postgrest 経路のまま（getDb 不使用）', async () => {
      const client = createSupabaseClientMock([
        { data: { id: VALID_UUID, status: 'open', twitch_user_id: 'user123' } },
        { data: MESSAGE_ROW },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client as any)

      const res = await run('pg-read')
      expect(res.status).toBe(201)
      expect(getDb).not.toHaveBeenCalled()
    })
  })
})
