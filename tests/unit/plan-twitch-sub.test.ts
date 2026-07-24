/**
 * twitch_sub を含むプラン優先順位の PlanetScale/Drizzle 契約テスト。
 *
 * DB fixture は getLicensePlan が実際に使う Drizzle の
 * select().from().innerJoin().where() チェーンを再現する。退役した埋め込み
 * PostgRESTレスポンスではなく、JOIN後に選択される plan_type 行だけを入力にする。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface LicenseFixture {
  plan_type: string
}

function createLicenseDbFixture(licenses: LicenseFixture[], error?: unknown) {
  const calls: Array<{
    fields: Record<string, unknown>
    from?: unknown
    join?: unknown
    where?: unknown
  }> = []
  const select = vi.fn((fields: Record<string, unknown>) => {
    const call = { fields } as (typeof calls)[number]
    calls.push(call)
    const resolve = () =>
      error
        ? Promise.reject(error)
        : Promise.resolve(licenses.map(({ plan_type }) => ({ plan_type })))
    const builder: any = {
      from: vi.fn((table: unknown) => {
        call.from = table
        return builder
      }),
      innerJoin: vi.fn((table: unknown) => {
        call.join = table
        return builder
      }),
      where: vi.fn((condition: unknown) => {
        call.where = condition
        return builder
      }),
      then: (onFulfilled: any, onRejected: any) =>
        resolve().then(onFulfilled, onRejected),
    }
    return builder
  })
  return { db: { select }, calls }
}

describe('PlanType with twitch_sub', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  function setupMocks(options: {
    licenses?: LicenseFixture[]
    licenseError?: unknown
    hasTwitchSub?: boolean
    twitchSubError?: unknown
  } = {}) {
    const {
      licenses = [],
      licenseError,
      hasTwitchSub = false,
      twitchSubError,
    } = options
    const fixture = createLicenseDbFixture(licenses, licenseError)

    vi.doMock('@/lib/db/client', () => ({
      getDb: vi.fn().mockResolvedValue({ db: fixture.db, sql: {} }),
    }))
    vi.doMock('@/lib/twitch/sub-check', () => ({
      hasTwitchSub: twitchSubError
        ? vi.fn().mockRejectedValue(twitchSubError)
        : vi.fn().mockResolvedValue(hasTwitchSub),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    // React cacheはリクエスト境界の責務であり、単体テストでは関数をそのまま返して
    // 各fixtureが前テストの結果を再利用しないようにする。
    vi.doMock('react', () => ({
      cache: (fn: (...args: unknown[]) => unknown) => fn,
    }))

    return fixture
  }

  it('twitch_sub の容量・画像上限は patron と同等である', async () => {
    setupMocks()
    const {
      PLAN_MAX_IMAGE_WIDTH,
      PLAN_MAX_UPLOAD_SIZE,
      PLAN_STORAGE_BONUS,
    } = await import('@/lib/plan')

    expect(PLAN_STORAGE_BONUS.twitch_sub).toBe(PLAN_STORAGE_BONUS.patron)
    expect(PLAN_MAX_IMAGE_WIDTH.twitch_sub).toBe(PLAN_MAX_IMAGE_WIDTH.patron)
    expect(PLAN_MAX_UPLOAD_SIZE.twitch_sub).toBe(PLAN_MAX_UPLOAD_SIZE.patron)
  })

  it('有効ライセンスなし + Twitchサブスクありは twitch_sub を返す', async () => {
    const fixture = setupMocks({ hasTwitchSub: true })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('twitch_sub')
    expect(fixture.calls).toHaveLength(1)
  })

  it('patron と twitch_sub が同優先度なら既存ライセンス patron を維持する', async () => {
    setupMocks({
      licenses: [{ plan_type: 'patron' }],
      hasTwitchSub: true,
    })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('patron')
  })

  it('support より twitch_sub を優先する', async () => {
    setupMocks({
      licenses: [{ plan_type: 'support' }],
      hasTwitchSub: true,
    })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('twitch_sub')
  })

  it('複数ライセンスから最上位の patron を選ぶ', async () => {
    setupMocks({
      licenses: [{ plan_type: 'support' }, { plan_type: 'patron' }],
      hasTwitchSub: false,
    })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('patron')
  })

  it('ライセンスもTwitchサブスクもなければ basic を返す', async () => {
    setupMocks()
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('basic')
  })

  it('ライセンスDB障害は basic に縮退し、Twitchサブスク判定は継続する', async () => {
    setupMocks({
      licenseError: new Error('database unavailable'),
      hasTwitchSub: true,
    })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('twitch_sub')
  })

  it('Twitchサブスク判定自体が例外なら全体を basic にフォールバックする', async () => {
    setupMocks({ twitchSubError: new Error('Twitch API error') })
    const { getUserPlan } = await import('@/lib/plan')

    await expect(getUserPlan('user-123')).resolves.toBe('basic')
  })
})
