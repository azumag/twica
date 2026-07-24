/**
 * #663: getUserPlanSnapshot（getLicensePlan / getCachedTwitchSubPlan）の
 * PlanetScale/Drizzle 契約テスト
 *
 * getUserPlanSnapshot は Twitch API を呼ばず DB 状態のみで判定するため、
 * getLicensePlan と getCachedTwitchSubPlan の両方の pg 実装を
 * 副作用なしで検証できる（tests/unit/announcements-driver-parity.test.ts と同じ流儀）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getUserPlanSnapshot } from '@/lib/plan'
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

describe('getUserPlanSnapshot: PlanetScale 経路 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ライセンスなし・サブなしの場合 basic を返す', async () => {
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [{ twitch_has_sub: false }] })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const result = await getUserPlanSnapshot('user-1')

    expect(result).toBe('basic')
  })

  it('support ライセンス保持時 support を返す', async () => {
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: false }],
    })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const result = await getUserPlanSnapshot('user-2')

    expect(result).toBe('support')
  })

  it('twitch_has_sub=true が支援プランより優先されない場合、上位プランが勝つ（patron > twitch_sub）', async () => {
    const pg = createDrizzleDbMock({
      licenseRows: [{ plan_type: 'patron' }],
      userRows: [{ twitch_has_sub: true }],
    })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const result = await getUserPlanSnapshot('user-3')

    expect(result).toBe('patron')
  })

  it('users 行が存在しない場合 basic 扱い', async () => {
    const pg = createDrizzleDbMock({ licenseRows: [], userRows: [] })
    vi.mocked(getDb).mockResolvedValue({ db: pg, sql: {} } as any)
    const result = await getUserPlanSnapshot('user-4')

    expect(result).toBe('basic')
  })

  it('user_licenses INNER JOIN support_codes + status IN 条件で発行される', async () => {
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

})
