/**
 * #663: src/lib/plan.ts の postgrest 経路 / pg 経路の互換テスト
 *
 * getLicensePlan / getCachedTwitchSubPlan はいずれもモジュール非公開関数のため、
 * 両方を呼び出す getUserPlanSnapshot（DB 保存済みライセンス/サブスク状態のみで
 * 判定する軽量パス。外部 Twitch API を叩く hasTwitchSub は使わない）経由で
 * 間接的に検証する。tests/unit/announcements-driver-parity.test.ts /
 * storage-db-driver-parity.test.ts と同じ流儀（同一 fixture を両経路に与えて
 * deepEqual を比較し、実クエリ引数の構造もあわせて検証する）。
 *
 * 両関数とも読み取り専用のため isPgReadEnabled() で分岐する（DB_DRIVER=pg-read
 * でも pg 経路に切り替わる）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getUserPlanSnapshot } from '@/lib/plan'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import {
  supportCodes as supportCodesTable,
  userLicenses as userLicensesTable,
  users as usersTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
// getUserPlanSnapshot は hasTwitchSub を使わないため sub-check 側のモックは不要。

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table) ごとの応答（user_licenses / users）
// ---------------------------------------------------------------------------

interface PostgrestResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: Record<string, PostgrestResponse>) {
  const from = vi.fn((table: string) => {
    const response = responses[table] ?? { data: null, error: null }
    const resolved = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(fields).from(table)[.innerJoin()].where()[.limit()]。
// テーブルごとに応答・実引数を記録する（Promise.all で並列実行されるため呼び出し
// 順序に依存しない table キー方式にする）。
// ---------------------------------------------------------------------------

interface PgCallRecord {
  table: unknown
  joinTable?: unknown
  joinOn?: unknown
  where?: unknown
  limit?: number
}

function createDrizzleDbMock(config: {
  licenseRows?: Array<{ plan_type: string }>
  licenseError?: unknown
  userRows?: Array<{ twitch_has_sub: boolean | null }>
  userError?: unknown
} = {}) {
  const calls: PgCallRecord[] = []
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const call: PgCallRecord = { table }
        calls.push(call)
        const builder: any = {
          innerJoin: vi.fn((joinTable: unknown, on: unknown) => {
            call.joinTable = joinTable
            call.joinOn = on
            return builder
          }),
          where: vi.fn((condition: unknown) => {
            call.where = condition
            return builder
          }),
          limit: vi.fn((n: number) => {
            call.limit = n
            return builder
          }),
          then: (onFulfilled: any, onRejected: any) => {
            let resultPromise: Promise<unknown[]>
            if (table === userLicensesTable) {
              resultPromise = config.licenseError
                ? Promise.reject(config.licenseError)
                : Promise.resolve(
                    (config.licenseRows ?? []).map((row) =>
                      Object.fromEntries(Object.keys(fields).map((key) => [key, (row as any)[key] ?? null]))
                    )
                  )
            } else if (table === usersTable) {
              resultPromise = config.userError
                ? Promise.reject(config.userError)
                : Promise.resolve(
                    (config.userRows ?? []).map((row) =>
                      Object.fromEntries(Object.keys(fields).map((key) => [key, (row as any)[key] ?? null]))
                    )
                  )
            } else {
              resultPromise = Promise.resolve([])
            }
            return resultPromise.then(onFulfilled, onRejected)
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

describe('plan.ts (getUserPlanSnapshot 経由): postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ライセンスなし・サブなし: 両経路とも basic を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { data: [] },
      users: { data: { twitch_has_sub: false } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-1')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [{ twitch_has_sub: false }] })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-1')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('basic')
  })

  it('support ライセンスあり: 両経路とも support を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { data: [{ plan_type: 'support', support_codes: { status: 'active' } }] },
      users: { data: { twitch_has_sub: false } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-2')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: false }],
    })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-2')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('support')
  })

  it('patron ライセンス + キャッシュ済み twitch_sub: 両経路とも上位プラン patron を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: {
        data: [
          { plan_type: 'support', support_codes: { status: 'active' } },
          { plan_type: 'patron', support_codes: { status: 'rotating' } },
        ],
      },
      users: { data: { twitch_has_sub: true } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-3')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }, { plan_type: 'patron' }],
      userRows: [{ twitch_has_sub: true }],
    })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-3')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('patron')
  })

  it('キャッシュ済み twitch_sub のみ（ライセンスなし）: 両経路とも twitch_sub を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { data: [] },
      users: { data: { twitch_has_sub: true } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-4')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [{ twitch_has_sub: true }] })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-4')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('twitch_sub')
  })

  it('user_licenses クエリ失敗: 両経路とも basic にフォールバックする', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { error: { message: 'boom' } },
      users: { data: { twitch_has_sub: false } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-5')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseError: new Error('boom'),
      userRows: [{ twitch_has_sub: false }],
    })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-5')

    expect(pgResult).toBe(postgrestResult)
    expect(pgResult).toBe('basic')
    // pg 経路の getLicensePlanPg は想定外の例外を logger.error に記録する
    // （Sentry/GitHub Issue 自動化パイプラインのトリガー要件）
    expect(logger.error).toHaveBeenCalledWith(
      '[Plan] Failed to get license plan:',
      expect.any(Error)
    )
  })

  it('users（サブキャッシュ）クエリ失敗: 両経路とも basic にフォールバックする（ライセンスは有効）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { data: [{ plan_type: 'support', support_codes: { status: 'active' } }] },
      users: { error: { message: 'boom' } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-6')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userError: new Error('boom'),
    })
    primePgDb(pg)
    const pgResult = await getUserPlanSnapshot('user-6')

    expect(pgResult).toBe(postgrestResult)
    // users クエリ失敗時は twitch_sub 判定が basic に落ちるが、有効な support
    // ライセンスは無関係に生きているため最終的に support が返る
    expect(pgResult).toBe('support')
    // 修正対象: getCachedTwitchSubPlanPg の catch は元は無ログだったが、
    // 旧 supabase-js 実装の catch 節（想定外の例外）と同じ logger.error を
    // 出すよう修正した。ログが欠落すると DB 接続断等の障害が無音になり
    // Sentry/GitHub Issue 自動化に乗らないため、ここで回帰を検知する。
    expect(logger.error).toHaveBeenCalledWith(
      '[Plan] Error getting cached Twitch sub plan:',
      expect.any(Error)
    )
  })

  it('pg クエリが INNER JOIN（status IN (active, rotating)）と twitch_user_id 絞り込みを正しい実引数で発行する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: false }],
    })
    primePgDb(pg)

    await getUserPlanSnapshot('user-7')

    const licenseCall = pg.calls.find((c) => c.table === userLicensesTable)
    expect(licenseCall).toBeDefined()
    expect(licenseCall!.joinTable).toBe(supportCodesTable)
    expect(licenseCall!.joinOn).toEqual(
      and(eq(supportCodesTable.id, userLicensesTable.code_id), inArray(supportCodesTable.status, ['active', 'rotating']))
    )
    expect(licenseCall!.where).toEqual(eq(userLicensesTable.twitch_user_id, 'user-7'))

    const userCall = pg.calls.find((c) => c.table === usersTable)
    expect(userCall).toBeDefined()
    expect(userCall!.where).toEqual(eq(usersTable.twitch_user_id, 'user-7'))
    expect(userCall!.limit).toBe(1)
  })

  it('フラグ未設定（postgrest 既定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      user_licenses: { data: [] },
      users: { data: { twitch_has_sub: false } },
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

    await getUserPlanSnapshot('user-8')

    expect(getDb).not.toHaveBeenCalled()
  })
})
