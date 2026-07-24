/**
 * #711: GET/POST /api/tos/accept のPlanetScale回帰テスト
 *
 * tests/unit/auth-logout-api.test.ts（ルートハンドラを直接 import して呼ぶ形式）と
 * tests/unit/token-manager-driver-parity.test.tsのDrizzleモック方式を踏襲する。
 *
 * 特に重要なクセ: GET は「users 行が存在しない」場合、既存実装の
 * `user?.tos_accepted_at !== null` が `undefined !== null` → true と評価されるため
 * accepted: true を返す（バグ的挙動だが Phase 1 は挙動パリティ維持が正。修正は別Issue）。
 * このテストは pg 経路でも同じ挙動になることを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as tosAcceptRoute from '@/app/api/tos/accept/route'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import { ERROR_MESSAGES } from '@/lib/constants'
import { users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SESSION = { twitchUserId: 'user-1' } as any

function createPostRequest(): Request {
  return new Request('http://localhost:3000/api/tos/accept', { method: 'POST' })
}

// ---------------------------------------------------------------------------
// pg 経路のモック（token-manager-driver-parity.test.ts と同方式）
// select: 指定列で射影した行を返す thenable
// update: set/where を記録し、複数回呼び出し（リトライ）に対応するため
//         レスポンスキューを消費する
// ---------------------------------------------------------------------------
interface PgResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface PgUpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; updates?: PgResponse[] } = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const updateCalls: PgUpdateCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() => {
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
          where: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
    update: vi.fn((table: unknown) => {
      // updates はリトライ検証用にキューから毎回消費する（announcements とは異なり
      // 同一呼び出し内で複数回 update が発生しうるため、末尾で固定しない）
      const responses = config.updates ?? [{ rows: [] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: PgUpdateCall = { table }
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
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, updateCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

describe('GET/POST /api/tos/accept: PlanetScale契約 (#711)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(SESSION)
  })

  describe('GET', () => {
    it('未認証: 401 を返し DB に触れない', async () => {
      vi.mocked(getSession).mockResolvedValue(null)

      const res = await tosAcceptRoute.GET()
      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED })
      expect(getDb).not.toHaveBeenCalled()
    })

    it('行あり・同意済み: { accepted: true, acceptedAt: <ISO> } を返す', async () => {
      const isoValue = '2026-01-01T00:00:00.000+00:00'

      const pg = createDrizzleDbMock({ selects: [{ rows: [{ tos_accepted_at: isoValue }] }] })
      primePgDb(pg)
      const pgJson = await (await tosAcceptRoute.GET()).json()

      expect(pgJson).toEqual({ accepted: true, acceptedAt: isoValue })
    })

    it('行あり・未同意: { accepted: false, acceptedAt: null } を返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ tos_accepted_at: null }] }] })
      primePgDb(pg)
      const pgJson = await (await tosAcceptRoute.GET()).json()

      expect(pgJson).toEqual({ accepted: false, acceptedAt: null })
    })

    it('クセ: 行なし（未登録ユーザー）はaccepted: true・acceptedAtキーなし', async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      const pgJson = await (await tosAcceptRoute.GET()).json()

      expect(pgJson).toEqual({ accepted: true })
      expect(Object.prototype.hasOwnProperty.call(pgJson, 'acceptedAt')).toBe(false)
    })

    it('DBエラー時: 500 + 安定したエラーJSONとログを返す', async () => {
      const pg = createDrizzleDbMock({ selects: [{ error: new Error('pg boom') }] })
      primePgDb(pg)
      const pgRes = await tosAcceptRoute.GET()
      expect(pgRes.status).toBe(500)
      const pgJson = await pgRes.json()
      expect(pgJson).toEqual({ error: 'Failed to check TOS acceptance' })
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to check TOS acceptance',
        expect.objectContaining({ twitchUserId: 'user-1', error: 'pg boom' })
      )
    })
  })

  describe('POST', () => {
    it('未認証: 401 を返し DB に触れない', async () => {
      vi.mocked(getSession).mockResolvedValue(null)

      const res = await tosAcceptRoute.POST(createPostRequest() as any)
      expect(res.status).toBe(401)
      expect(getDb).not.toHaveBeenCalled()
    })

    it('成功時: successレスポンスを返しusers.tos_accepted_atを更新する', async () => {
      const pg = createDrizzleDbMock({ updates: [{ rows: [] }] })
      primePgDb(pg)
      const pgJson = await (await tosAcceptRoute.POST(createPostRequest() as any)).json()

      expect(pgJson).toEqual({ success: true, redirectUrl: '/dashboard' })
      expect(pg.updateCalls).toHaveLength(1)
      expect(pg.updateCalls[0].table).toBe(usersTable)
      expect(pg.updateCalls[0].where).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
      expect(typeof pg.updateCalls[0].set?.tos_accepted_at).toBe('string')
    })

    it('pg 経路: リトライが発生しても書き込むタイムスタンプが同一値になる（queryFn の外で1度だけ計算する設計の検証）', async () => {
      // 1回目は接続断（リトライ対象）、2回目で成功
      const pg = createDrizzleDbMock({
        updates: [{ error: { message: 'closed', code: 'CONNECTION_CLOSED' } }, { rows: [] }],
      })
      primePgDb(pg)

      const res = await tosAcceptRoute.POST(createPostRequest() as any)
      expect(res.status).toBe(200)

      // リトライで2回 update が呼ばれるが、書き込む値（タイムスタンプ）は同一
      expect(pg.updateCalls).toHaveLength(2)
      expect(pg.updateCalls[0].set?.tos_accepted_at).toBeDefined()
      expect(pg.updateCalls[1].set?.tos_accepted_at).toBe(pg.updateCalls[0].set?.tos_accepted_at)

      // ログの acceptedAt も DB へ書き込んだ値と同一（queryFn の外で計算した値を再利用する設計）
      expect(logger.info).toHaveBeenCalledWith(
        'TOS accepted',
        expect.objectContaining({
          twitchUserId: 'user-1',
          acceptedAt: pg.updateCalls[0].set?.tos_accepted_at,
        })
      )
    })

    it('DBエラー時: 500 + 安定したエラーJSONとログを返す', async () => {
      // 非リトライ対象エラー（恒久的エラー想定）で即失敗させる
      const pg = createDrizzleDbMock({ updates: [{ error: { message: 'constraint violation', code: '23505' } }] })
      primePgDb(pg)
      const pgRes = await tosAcceptRoute.POST(createPostRequest() as any)
      expect(pgRes.status).toBe(500)
      const pgJson = await pgRes.json()
      expect(pgJson).toEqual({ error: 'Failed to record TOS acceptance' })
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to update TOS acceptance',
        expect.objectContaining({ twitchUserId: 'user-1' })
      )
    })
  })
})
