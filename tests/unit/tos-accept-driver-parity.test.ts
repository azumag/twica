/**
 * #663: /api/tos/accept (POST / GET) の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/announcements-driver-parity.test.ts / twitch-sub-check-driver-parity.test.ts
 * と同じ流儀。POST は書き込み（users への UPDATE）のため DB_DRIVER=pg のときのみ
 * pg 経路（pg-read では postgrest のまま）、GET は読み取り専用のため pg-read でも
 * pg 経路に切り替わることを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { POST, GET } from '@/app/api/tos/accept/route'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/session')
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockGetSession = vi.mocked(getSession)

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/tos/accept', { method: 'POST' })
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: update→eq / select→eq→maybeSingle
// ---------------------------------------------------------------------------

function createSupabaseClientMock(options: {
  selectResult?: { data: unknown; error: unknown }
  updateResult?: { error: unknown }
} = {}) {
  const { selectResult = { data: null, error: null }, updateResult = { error: null } } = options
  const updateCalls: Array<Record<string, unknown>> = []
  const queryBuilder = {
    update: vi.fn((values: Record<string, unknown>) => {
      updateCalls.push(values)
      return { eq: vi.fn().mockResolvedValue(updateResult) }
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
  }
  return { from: vi.fn(() => queryBuilder), updateCalls }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（twitch-sub-check-driver-parity.test.ts と同方式）
// ---------------------------------------------------------------------------

interface PgUpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
}

interface PgSelectCall {
  fields: Record<string, unknown>
  where?: unknown
  limit?: number
}

function createDrizzleDbMock(config: {
  selectRows?: Array<Record<string, unknown>>
  selectError?: unknown
  updateError?: unknown
} = {}) {
  const updateCalls: PgUpdateCall[] = []
  const selectCalls: PgSelectCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: PgSelectCall = { fields }
      selectCalls.push(call)
      const resolve = () =>
        config.selectError
          ? Promise.reject(config.selectError)
          : Promise.resolve(
              (config.selectRows ?? []).map((row) =>
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
    update: vi.fn((table: unknown) => {
      const call: PgUpdateCall = { table }
      updateCalls.push(call)
      const resolve = () =>
        config.updateError ? Promise.reject(config.updateError) : Promise.resolve({ count: 1 })
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = values
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, updateCalls, selectCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('/api/tos/accept: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user-1',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: null,
      broadcasterType: '',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    } as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  describe('POST（書き込み: DB_DRIVER=pg のときのみ pg 経路）', () => {
    it('成功時: 両経路のレスポンスと UPDATE 内容（tos_accepted_at）が一致する', async () => {
      // 両経路が書く tos_accepted_at（実行時刻由来）を一致させるため Date のみ固定
      // （setTimeout は fake にしない: withDbRetry のリトライ遅延を巻き込まないため）
      vi.useFakeTimers({ toFake: ['Date'] })

      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock()
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestRes = await POST(createRequest())
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock()
      primePgDb(pg)
      const pgRes = await POST(createRequest())
      const pgBody = await pgRes.json()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(200)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ success: true, redirectUrl: '/dashboard' })

      // UPDATE の set 内容・対象テーブル・where 条件のパリティ
      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].set).toEqual(client.updateCalls[0])
      expect(pg.updateCalls[0].set).toEqual({ tos_accepted_at: expect.any(String) })
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
    })

    it('UPDATE 失敗時: 両経路とも 500 + 同一 body を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ updateResult: { error: { message: 'boom' } } })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestRes = await POST(createRequest())

      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({ updateError: new Error('boom') })
      primePgDb(pg)
      const pgRes = await POST(createRequest())

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('未認証: 両経路とも 401（フラグに依らず同一）', async () => {
      mockGetSession.mockResolvedValue(null)
      for (const driver of [undefined, 'pg']) {
        vi.stubEnv('DB_DRIVER', driver)
        const res = await POST(createRequest())
        expect(res.status).toBe(401)
      }
      expect(getDb).not.toHaveBeenCalled()
    })

    it('DB_DRIVER=pg-read では書き込みを含む POST は postgrest 経路のまま（getDb 不使用）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const client = createSupabaseClientMock()
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      const res = await POST(createRequest())
      expect(res.status).toBe(200)
      expect(getDb).not.toHaveBeenCalled()
      expect(client.updateCalls).toHaveLength(1)
    })

    it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock()
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await POST(createRequest())
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('GET（読み取り専用: DB_DRIVER=pg-read でも pg 経路）', () => {
    async function runBothPaths(userRow: Record<string, unknown> | null) {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ selectResult: { data: userRow, error: null } })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestRes = await GET()
      const postgrestBody = await postgrestRes.json()

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selectRows: userRow ? [userRow] : [] })
      primePgDb(pg)
      const pgRes = await GET()
      const pgBody = await pgRes.json()

      return { postgrestRes, postgrestBody, pgRes, pgBody, pg }
    }

    it('同意済みユーザー: 両経路とも accepted: true + acceptedAt が一致する', async () => {
      const { postgrestRes, postgrestBody, pgRes, pgBody, pg } = await runBothPaths({
        tos_accepted_at: '2020-01-01T00:00:00.000+00:00',
      })

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ accepted: true, acceptedAt: '2020-01-01T00:00:00.000+00:00' })

      // 読み取りクエリの実引数（where / limit 1 = .maybeSingle() 対応）のパリティ
      expect(pg.selectCalls).toHaveLength(1)
      expect(pg.selectCalls[0].where).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
      expect(pg.selectCalls[0].limit).toBe(1)
    })

    it('未同意ユーザー（tos_accepted_at = null）: 両経路とも accepted: false', async () => {
      const { postgrestBody, pgBody } = await runBothPaths({ tos_accepted_at: null })

      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ accepted: false, acceptedAt: null })
    })

    it('ユーザー不在: 両経路とも accepted: true / acceptedAt キー欠落（既存の undefined !== null 挙動の保存）', async () => {
      const { postgrestBody, pgBody } = await runBothPaths(null)

      // user?.tos_accepted_at = undefined のため accepted は true、acceptedAt は
      // JSON からキーごと欠落する（既存実装の挙動をそのまま保存していることの検証）
      expect(pgBody).toEqual(postgrestBody)
      expect(pgBody).toEqual({ accepted: true })
      expect('acceptedAt' in pgBody).toBe(false)
    })

    it('取得失敗時: 両経路とも 500 + 同一 body を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        selectResult: { data: null, error: { message: 'boom' } },
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestRes = await GET()

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selectError: new Error('boom') })
      primePgDb(pg)
      const pgRes = await GET()

      expect(pgRes.status).toBe(postgrestRes.status)
      expect(pgRes.status).toBe(500)
      expect(await pgRes.json()).toEqual(await postgrestRes.json())
    })

    it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({
        selectResult: { data: { tos_accepted_at: null }, error: null },
      })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await GET()
      expect(getDb).not.toHaveBeenCalled()
    })
  })
})
