/**
 * #663: getUserPlanSnapshot（getLicensePlan / getCachedTwitchSubPlan）の
 * postgrest 経路 / pg 経路の形状互換テスト
 *
 * getUserPlanSnapshot は Twitch API を呼ばず DB 状態のみで判定するため、
 * getLicensePlan と getCachedTwitchSubPlan の両方の pg 実装を
 * 副作用なしで検証できる（tests/unit/announcements-driver-parity.test.ts と同じ流儀）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getUserPlanSnapshot } from '@/lib/plan'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  supportCodes as supportCodesTable,
  userLicenses as userLicensesTable,
  users as usersTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table) ごとに異なる結果を返す thenable builder
// ---------------------------------------------------------------------------

function createThenableBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

function createSupabaseClientMock(config: {
  licenseRows?: Array<{ plan_type: string; support_codes: { status: string } }>
  hasSub?: boolean | null
}) {
  const from = vi.fn((table: string) => {
    if (table === 'user_licenses') {
      return createThenableBuilder({ data: config.licenseRows ?? [], error: null })
    }
    return createThenableBuilder({
      data: config.hasSub === null ? null : { twitch_has_sub: config.hasSub ?? false },
      error: null,
    })
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields).from(table)[.innerJoin()].where()[.limit()]
// ---------------------------------------------------------------------------

interface DrizzleCallRecord {
  table: unknown
  joinTable?: unknown
  joinCondition?: unknown
  whereCondition?: unknown
}

function createDrizzleDbMock(config: {
  licenseRows?: Array<{ plan_type: string }>
  userRows?: Array<{ twitch_has_sub: boolean | null }>
}) {
  const calls: DrizzleCallRecord[] = []
  return {
    calls,
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const call: DrizzleCallRecord = { table }
        calls.push(call)
        const isLicenseQuery = table === userLicensesTable
        const rows = isLicenseQuery ? (config.licenseRows ?? []) : (config.userRows ?? [])
        const projected = rows.map((row) =>
          Object.fromEntries(
            Object.keys(fields).map((key) => [key, (row as Record<string, unknown>)[key] ?? null])
          )
        )
        const builder: any = {
          innerJoin: vi.fn((joinTable: unknown, condition: unknown) => {
            call.joinTable = joinTable
            call.joinCondition = condition
            return builder
          }),
          where: vi.fn((condition: unknown) => {
            call.whereCondition = condition
            return builder
          }),
          limit: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(projected).then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
  }
}

describe('getUserPlanSnapshot: postgrest / pg 経路の形状互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ライセンスなし・サブなしの場合、両経路とも basic を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ licenseRows: [], hasSub: false })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-1')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [{ twitch_has_sub: false }] })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await getUserPlanSnapshot('user-1')

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toBe('basic')
  })

  it('support ライセンス保持時、両経路とも support を返す', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      licenseRows: [{ plan_type: 'support', support_codes: { status: 'active' } }],
      hasSub: false,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-2')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: false }],
    })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await getUserPlanSnapshot('user-2')

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toBe('support')
  })

  it('twitch_has_sub=true が支援プランより優先されない場合、上位プランが勝つ（patron > twitch_sub）', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({
      licenseRows: [{ plan_type: 'patron', support_codes: { status: 'rotating' } }],
      hasSub: true,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-3')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'patron' }],
      userRows: [{ twitch_has_sub: true }],
    })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await getUserPlanSnapshot('user-3')

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toBe('patron')
  })

  it('users 行が存在しない場合、両経路とも basic 扱い', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ licenseRows: [], hasSub: null })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const postgrestResult = await getUserPlanSnapshot('user-4')

    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [] })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const pgResult = await getUserPlanSnapshot('user-4')

    expect(pgResult).toEqual(postgrestResult)
    expect(pgResult).toBe('basic')
  })

  it('pg クエリが user_licenses INNER JOIN support_codes + status IN 条件で発行される', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: false }],
    })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)

    await getUserPlanSnapshot('user-5')

    const licenseCall = pg.calls.find((c) => c.table === userLicensesTable)
    expect(licenseCall).toBeDefined()
    expect(licenseCall!.joinTable).toBe(supportCodesTable)
    expect(licenseCall!.joinCondition).toEqual(eq(userLicensesTable.code_id, supportCodesTable.id))
    expect(licenseCall!.whereCondition).toEqual(
      and(eq(userLicensesTable.twitch_user_id, 'user-5'), inArray(supportCodesTable.status, ['active', 'rotating']))
    )

    const userCall = pg.calls.find((c) => c.table === usersTable)
    expect(userCall).toBeDefined()
    expect(userCall!.whereCondition).toEqual(eq(usersTable.twitch_user_id, 'user-5'))
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない', async () => {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock({ licenseRows: [], hasSub: false })
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    await getUserPlanSnapshot('user-6')
    expect(getDb).not.toHaveBeenCalled()
  })
})
