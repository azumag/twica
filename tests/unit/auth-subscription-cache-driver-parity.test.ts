/**
 * #663/#708: サブスク状態キャッシュのPlanetScale書き込みテスト
 *
 * 対象:
 *   - POST /api/auth/twitch/check-subscription（UPSERT + 読み戻し検証）
 *   - POST /api/auth/twitch/disable-subscription（UPDATE）
 *
 * token-manager-driver-parity.test.ts の流儀を踏襲する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { hasScope } from '@/lib/twitch/token-manager'
import { checkTwitchSubViaApi, isTwitchSubCheckEnabled } from '@/lib/twitch/sub-check'
import { getDb } from '@/lib/db/client'
import { users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/csrf')
vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { twitchCheckSubscription: {}, twitchDisableSubscription: {} },
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  removeScope: vi.fn(),
}))
vi.mock('@/lib/twitch/sub-check', () => ({
  checkTwitchSubViaApi: vi.fn(),
  isTwitchSubCheckEnabled: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SESSION = {
  twitchUserId: '123456789',
  twitchUsername: 'test-user',
  twitchDisplayName: 'Test User',
  twitchProfileImageUrl: 'https://example.com/avatar.png',
  broadcasterType: 'affiliate',
  expiresAt: Date.now() + 60_000,
  version: 1,
}

interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

/** pg 経路の insert/update/select 兼用モック（onConflictDoUpdate/returning 対応） */
function createDrizzleDbMock(config: { selects?: PgResponse[]; inserts?: PgResponse[]; updates?: PgResponse[] } = {}) {
  let selectIndex = 0
  let insertIndex = 0
  let updateIndex = 0
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown>; conflictSet?: Record<string, unknown> }> = []
  const updateCalls: Array<{ table: unknown; set?: Record<string, unknown>; where?: unknown }> = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
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
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{}] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: { table: unknown; values?: Record<string, unknown>; conflictSet?: Record<string, unknown> } = { table }
      insertCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        onConflictDoUpdate: vi.fn((opts: { set: Record<string, unknown> }) => {
          call.conflictSet = opts.set
          return builder
        }),
        returning: vi.fn(() => resolve()),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{}] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: { table: unknown; set?: Record<string, unknown>; where?: unknown } = { table }
      updateCalls.push(call)
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []))
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = values
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn(() => resolve()),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, insertCalls, updateCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

function createRequest(path: string): Request {
  return new Request(`http://localhost:3000${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
}

describe('サブスク状態キャッシュ書き込みルート: PlanetScale経路 (#663/#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any)
    vi.mocked(getSession).mockResolvedValue(SESSION as any)
    vi.mocked(getRateLimitIdentifier).mockResolvedValue('user:123456789')
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60000 } as any)
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(checkTwitchSubViaApi).mockResolvedValue({ hasSub: true, authError: false })
    vi.mocked(isTwitchSubCheckEnabled).mockReturnValue(true)
  })

  describe('POST /api/auth/twitch/check-subscription', () => {
    it('正しいset/onConflictでUPSERTし成功レスポンスを返す', async () => {
      const pg = createDrizzleDbMock({ inserts: [{ rows: [{ twitch_user_id: '123456789' }] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')
      const response = await POST(createRequest('/api/auth/twitch/check-subscription'))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ success: true, hasSub: true, saved: true })
      expect(getDb).toHaveBeenCalled()
      expect(pg.insertCalls[0].table).toBe(usersTable)
      expect(pg.insertCalls[0].values).toMatchObject({
        twitch_user_id: '123456789',
        twitch_username: 'test-user',
        twitch_has_sub: true,
      })
    })

    it('列欠落(42703)はスキーマ不一致としてsaved=false・200を返す', async () => {
      const pg = createDrizzleDbMock({
        inserts: [{ error: { code: '42703', message: 'column does not exist' } }],
      })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')
      const response = await POST(createRequest('/api/auth/twitch/check-subscription'))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ success: true, hasSub: true, saved: false, saveFailureCode: '42703' })
    })

    it('returning行が空の場合は読み戻しで検証しsaved=trueを返す', async () => {
      const pg = createDrizzleDbMock({
        inserts: [{ rows: [] }],
        selects: [{ rows: [{ twitch_has_sub: true, twitch_sub_verified_at: new Date().toISOString() }] }],
      })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/twitch/check-subscription/route')
      const response = await POST(createRequest('/api/auth/twitch/check-subscription'))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ success: true, hasSub: true, saved: true })
    })
  })

  describe('POST /api/auth/twitch/disable-subscription', () => {
    it('正しいset/whereでUPDATEし成功レスポンスを返す', async () => {
      const pg = createDrizzleDbMock({ updates: [{ rows: [{ twitch_user_id: '123456789' }] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/twitch/disable-subscription/route')
      const response = await POST(createRequest('/api/auth/twitch/disable-subscription'))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ success: true, hasSub: false, twitchSubVerifiedAt: '9999-12-31T00:00:00.000Z' })
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual({
        twitch_has_sub: false,
        twitch_sub_verified_at: '9999-12-31T00:00:00.000Z',
      })
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, '123456789'))
    })

    it('更新対象行が無ければ500を返す', async () => {
      const pg = createDrizzleDbMock({ updates: [{ rows: [] }] })
      primePgDb(pg)

      const { POST } = await import('@/app/api/auth/twitch/disable-subscription/route')
      const response = await POST(createRequest('/api/auth/twitch/disable-subscription'))

      expect(response.status).toBe(500)
    })
  })
})
