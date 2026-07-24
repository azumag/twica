/**
 * #803: user-data.ts の PlanetScale/Drizzle 専用契約テスト。
 *
 * Supabase/PostgREST との比較 fixture は、実行不能になった退役経路を再実装するだけで
 * 現行コードの回帰検出力を持たないため削除した。代わりに、Drizzle が選択した列だけを
 * 返す fixture を使い、戻り値の形状・テーブル・WHERE・LIMIT とエラー時の安全側挙動を
 * 直接固定する。実DBを抽象化する境界は getDb() のみに絞り、実装と同じ schema objectを
 * 比較することで、文字列ベースの疑似PostgRESTチェーンより列/テーブル取り違えを検知する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  getStreamerIdByTwitchUserId,
  getTosAcceptanceRow,
  getTwitchSubRow,
} from '@/lib/user-data'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

interface DrizzleCallRecord {
  fields: Record<string, unknown>
  table: unknown
  whereCondition?: unknown
  limitArg?: unknown
}

/**
 * select(fields) で指定されたキーだけを返す最小Drizzle fixture。
 * fixture行をそのまま返すと、実装が誤った列を選んでもテストが通るため、射影を行う。
 */
function createDrizzleDbMock(response: {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}) {
  const calls: DrizzleCallRecord[] = []
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      const call: DrizzleCallRecord = { fields, table }
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
        where: vi.fn((condition: unknown) => {
          call.whereCondition = condition
          return builder
        }),
        limit: vi.fn((n: unknown) => {
          call.limitArg = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }))
  return { select, calls }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: { select: mock.select }, sql: {} } as any)
}

describe('user-data.ts: PlanetScale/Drizzle 契約 (#803)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getTosAcceptanceRow', () => {
    it('行あり・同意済みを { row, error: null } で返す', async () => {
      const isoValue = '2026-01-01T00:00:00.000+00:00'
      const fixture = createDrizzleDbMock({ rows: [{ tos_accepted_at: isoValue }] })
      primeDb(fixture)

      await expect(getTosAcceptanceRow('user-1')).resolves.toEqual({
        row: { tos_accepted_at: isoValue },
        error: null,
      })
    })

    it('行あり・未同意は row 内の null を保つ', async () => {
      const fixture = createDrizzleDbMock({ rows: [{ tos_accepted_at: null }] })
      primeDb(fixture)

      await expect(getTosAcceptanceRow('user-1')).resolves.toEqual({
        row: { tos_accepted_at: null },
        error: null,
      })
    })

    it('行なしと「行あり・値null」を区別する', async () => {
      const fixture = createDrizzleDbMock({ rows: [] })
      primeDb(fixture)

      const result = await getTosAcceptanceRow('user-1')
      expect(result).toEqual({ row: null, error: null })
      // 呼び出し側が optional chaining で判定しているため、行なしを疑似行へ
      // 正規化すると既存の同意判定が変わる。null のまま保つことが契約である。
      expect(result.row).toBeNull()
    })

    it('DB例外を throw せず { row: null, error: { message } } に写像して記録する', async () => {
      const fixture = createDrizzleDbMock({ error: new Error('database boom') })
      primeDb(fixture)

      const result = await getTosAcceptanceRow('user-1')

      expect(result).toEqual({ row: null, error: { message: 'database boom' } })
      expect(logger.error).toHaveBeenCalled()
    })

    it('users の対象列を twitch_user_id / limit(1) で取得する', async () => {
      const fixture = createDrizzleDbMock({ rows: [{ tos_accepted_at: null }] })
      primeDb(fixture)
      await getTosAcceptanceRow('user-1')

      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]).toMatchObject({
        fields: { tos_accepted_at: usersTable.tos_accepted_at },
        table: usersTable,
        limitArg: 1,
      })
      expect(fixture.calls[0].whereCondition).toEqual(
        eq(usersTable.twitch_user_id, 'user-1')
      )
    })
  })

  describe('getTwitchSubRow', () => {
    it.each([
      [[{ twitch_has_sub: true }], { twitch_has_sub: true }],
      [[{ twitch_has_sub: null }], { twitch_has_sub: null }],
      [[], null],
    ])('行の有無と nullable 値をそのまま返す', async (rows, expected) => {
      const fixture = createDrizzleDbMock({ rows })
      primeDb(fixture)

      await expect(getTwitchSubRow('user-1')).resolves.toEqual(expected)
    })

    it('DB例外時はアカウント画面を止めず null を返して記録する', async () => {
      const fixture = createDrizzleDbMock({ error: new Error('database boom') })
      primeDb(fixture)

      await expect(getTwitchSubRow('user-1')).resolves.toBeNull()
      expect(logger.error).toHaveBeenCalled()
    })

    it('users.twitch_has_sub を twitch_user_id / limit(1) で取得する', async () => {
      const fixture = createDrizzleDbMock({ rows: [{ twitch_has_sub: false }] })
      primeDb(fixture)
      await getTwitchSubRow('user-1')

      expect(fixture.calls[0]).toMatchObject({
        fields: { twitch_has_sub: usersTable.twitch_has_sub },
        table: usersTable,
        limitArg: 1,
      })
      expect(fixture.calls[0].whereCondition).toEqual(
        eq(usersTable.twitch_user_id, 'user-1')
      )
    })
  })

  describe('getStreamerIdByTwitchUserId', () => {
    it.each([
      [[{ id: 'streamer-1' }], { id: 'streamer-1' }],
      [[], null],
    ])('行の有無を呼び出し側の表示契約へ保つ', async (rows, expected) => {
      const fixture = createDrizzleDbMock({ rows })
      primeDb(fixture)

      await expect(getStreamerIdByTwitchUserId('user-1')).resolves.toEqual(expected)
    })

    it('DB例外時は Server Component をクラッシュさせず null を返す', async () => {
      const fixture = createDrizzleDbMock({ error: new Error('database boom') })
      primeDb(fixture)

      await expect(getStreamerIdByTwitchUserId('user-1')).resolves.toBeNull()
      expect(logger.error).toHaveBeenCalled()
    })

    it('streamers.id を twitch_user_id / limit(1) で取得する', async () => {
      const fixture = createDrizzleDbMock({ rows: [{ id: 'streamer-1' }] })
      primeDb(fixture)
      await getStreamerIdByTwitchUserId('user-1')

      expect(fixture.calls[0]).toMatchObject({
        fields: { id: streamersTable.id },
        table: streamersTable,
        limitArg: 1,
      })
      expect(fixture.calls[0].whereCondition).toEqual(
        eq(streamersTable.twitch_user_id, 'user-1')
      )
    })
  })
})
