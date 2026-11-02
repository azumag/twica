/**
 * #1953: POST /api/collection/hidden-streamers
 * CSRF → セッション → レートリミット → 入力検証 → INSERT/DELETE（冪等）の順序と、
 * 各分岐のレスポンスを固定する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/collection/hidden-streamers/route'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit } from '@/lib/rate-limit'
import { getDb } from '@/lib/db/client'
import { userCollectionHiddenStreamers as hiddenTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/csrf')
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimits: { collectionHiddenStreamers: { name: 'collectionHiddenStreamers' } },
  getRateLimitIdentifier: vi.fn().mockResolvedValue('user:user123'),
}))

const mockGetSession = vi.mocked(getSession)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockCheckRateLimit = vi.mocked(checkRateLimit)

const STREAMER_ID = '22222222-2222-4222-8222-222222222222'

function createRequest(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost:3000/api/collection/hidden-streamers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

interface DbCalls {
  inserts: Array<{ table: unknown; values?: Record<string, unknown>; conflictTarget?: unknown }>
  deletes: Array<{ table: unknown; where?: unknown }>
}

/** insert/delete のビルダーを記録するだけの Drizzle モック。error を渡すと await 時に reject する。 */
function primeDb(opts: { error?: unknown } = {}): DbCalls {
  const calls: DbCalls = { inserts: [], deletes: [] }
  const settle = () => (opts.error ? Promise.reject(opts.error) : Promise.resolve([]))
  const db = {
    insert: vi.fn((table: unknown) => {
      const call: DbCalls['inserts'][number] = { table }
      calls.inserts.push(call)
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoNothing: vi.fn((o: { target: unknown }) => {
          call.conflictTarget = o.target
          return builder
        }),
        then: (f: any, r: any) => settle().then(f, r),
      }
      return builder
    }),
    delete: vi.fn((table: unknown) => {
      const call: DbCalls['deletes'][number] = { table }
      calls.deletes.push(call)
      const builder: any = {
        where: vi.fn((cond: unknown) => {
          call.where = cond
          return builder
        }),
        then: (f: any, r: any) => settle().then(f, r),
      }
      return builder
    }),
  }
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
  return calls
}

describe('POST /api/collection/hidden-streamers (#1953)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ twitchUserId: 'user123' } as any)
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any)
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: Date.now() + 60000 } as any)
  })

  it('CSRF検証に失敗したら403で、セッション・DBに触れない', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false } as any)
    const calls = primeDb()

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(403)
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(calls.inserts).toHaveLength(0)
  })

  it('未認証なら401で、レートリミット・DBに触れない', async () => {
    mockGetSession.mockResolvedValue(null as any)
    const calls = primeDb()

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(401)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(calls.inserts).toHaveLength(0)
  })

  it('レートリミット超過は429でRetry-Afterを返し、DBに触れない', async () => {
    mockCheckRateLimit.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: Date.now() + 30000 } as any)
    const calls = primeDb()

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(calls.inserts).toHaveLength(0)
  })

  it.each([
    ['streamerId 欠落', { hidden: true }],
    ['streamerId がUUIDでない', { streamerId: 'not-a-uuid', hidden: true }],
    ['streamerId が文字列でない', { streamerId: 123, hidden: true }],
    ['hidden 欠落', { streamerId: STREAMER_ID }],
    ['hidden が文字列 "false"', { streamerId: STREAMER_ID, hidden: 'false' }],
    ['hidden が数値', { streamerId: STREAMER_ID, hidden: 1 }],
    ['body が配列', []],
    ['body が null', null],
  ])('入力不正(%s)は400でDBに触れない', async (_label, body) => {
    const calls = primeDb()

    const res = await POST(createRequest(body))

    expect(res.status).toBe(400)
    expect(calls.inserts).toHaveLength(0)
    expect(calls.deletes).toHaveLength(0)
  })

  it('不正なJSONは500ではなく400を返す', async () => {
    const calls = primeDb()

    const res = await POST(createRequest('{not json', true))

    expect(res.status).toBe(400)
    expect(calls.inserts).toHaveLength(0)
  })

  it('hidden=true: セッションのユーザーで INSERT ... ON CONFLICT DO NOTHING し、200を返す', async () => {
    const calls = primeDb()

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(calls.inserts).toHaveLength(1)
    expect(calls.inserts[0].table).toBe(hiddenTable)
    // twitch_user_id はリクエストbodyではなくセッションから取る
    expect(calls.inserts[0].values).toEqual({ twitch_user_id: 'user123', streamer_id: STREAMER_ID })
    expect(calls.inserts[0].conflictTarget).toEqual([hiddenTable.twitch_user_id, hiddenTable.streamer_id])
    expect(calls.deletes).toHaveLength(0)
  })

  it('hidden=true を重複して送っても（DO NOTHING）200を返す＝冪等', async () => {
    primeDb()
    const first = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))
    const second = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  it('hidden=false: 該当行を DELETE し、200を返す（INSERTはしない）', async () => {
    const calls = primeDb()

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: false }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(calls.deletes).toHaveLength(1)
    expect(calls.deletes[0].table).toBe(hiddenTable)
    expect(calls.deletes[0].where).toBeDefined()
    expect(calls.inserts).toHaveLength(0)
  })

  it('存在しないstreamer_id（FK違反 23503）は500ではなく400', async () => {
    primeDb({ error: Object.assign(new Error('fk violation'), { code: '23503' }) })

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(400)
  })

  it('その他のDBエラーは500', async () => {
    primeDb({ error: new Error('connection failure') })

    const res = await POST(createRequest({ streamerId: STREAMER_ID, hidden: true }))

    expect(res.status).toBe(500)
  })
})
