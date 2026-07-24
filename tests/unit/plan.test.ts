import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PLAN_STORAGE_BONUS,
  PLAN_MAX_IMAGE_WIDTH,
  PLAN_MAX_UPLOAD_SIZE,
  type PlanType,
} from '@/lib/plan'
import { hasTwitchSub } from '@/lib/twitch/sub-check'
import { getDb } from '@/lib/db/client'
import { getTableName } from 'drizzle-orm'

vi.mock('@/lib/logger')
vi.mock('@/lib/twitch/sub-check', () => ({
  hasTwitchSub: vi.fn().mockResolvedValue(false),
  isTwitchSubCheckEnabled: vi.fn().mockReturnValue(false),
}))
vi.mock('@/lib/db/client', () => ({ getDb: vi.fn() }))

function primePlanDb(config: {
  licenseRows?: Array<{ plan_type: string }>
  userRows?: Array<{ twitch_has_sub: boolean | null }>
  error?: Error
}) {
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      const tableName = getTableName(table as never)
      const rows =
        tableName === 'user_licenses'
          ? (config.licenseRows ?? [])
          : tableName === 'users'
            ? (config.userRows ?? [])
            : []
      const projected = rows.map((row) =>
        Object.fromEntries(
          Object.keys(fields).map((key) => [
            key,
            (row as Record<string, unknown>)[key] ?? null,
          ]),
        ),
      )
      const builder: any = {
        innerJoin: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) =>
          (config.error
            ? Promise.reject(config.error)
            : Promise.resolve(projected)
          ).then(onFulfilled, onRejected),
      }
      return builder
    }),
  }))
  vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never)
  return select
}

describe('getUserPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should return basic when user has no licenses', async () => {
    primePlanDb({ licenseRows: [] })

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-no-license')
    expect(result).toBe('basic')
  })

  it('should return support when user has active support license', async () => {
    primePlanDb({ licenseRows: [{ plan_type: 'support' }] })

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-support')
    expect(result).toBe('support')
  })

  it('should return patron when user has both support and patron licenses (highest wins)', async () => {
    primePlanDb({
      licenseRows: [{ plan_type: 'support' }, { plan_type: 'patron' }],
    })

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-multi')
    expect(result).toBe('patron')
  })

  it('should return basic when DB query fails (graceful degradation)', async () => {
    primePlanDb({ error: new Error('DB connection error') })

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-error')
    expect(result).toBe('basic')
  })

  it('should return basic when an exception is thrown', async () => {
    vi.mocked(getDb).mockRejectedValue(new Error('unexpected error'))

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-throw')
    expect(result).toBe('basic')
  })

  it('getUserPlanSnapshot uses DB state without calling Twitch subscription API', async () => {
    primePlanDb({
      licenseRows: [{ plan_type: 'support' }],
      userRows: [{ twitch_has_sub: true }],
    })

    const { getUserPlanSnapshot } = await import('@/lib/plan')
    const result = await getUserPlanSnapshot('user-snapshot')

    expect(result).toBe('twitch_sub')
    expect(hasTwitchSub).not.toHaveBeenCalled()
  })
})

describe('Plan image constants', () => {
  const planTypes: PlanType[] = ['basic', 'support', 'patron']

  describe('PLAN_MAX_IMAGE_WIDTH', () => {
    it('全プランタイプに定義がある', () => {
      for (const plan of planTypes) {
        expect(PLAN_MAX_IMAGE_WIDTH[plan]).toBeDefined()
        expect(typeof PLAN_MAX_IMAGE_WIDTH[plan]).toBe('number')
      }
    })

    it('basic=800, support=1920, patron=3840', () => {
      expect(PLAN_MAX_IMAGE_WIDTH.basic).toBe(800)
      expect(PLAN_MAX_IMAGE_WIDTH.support).toBe(1920)
      expect(PLAN_MAX_IMAGE_WIDTH.patron).toBe(3840)
    })

    it('上位プランほど解像度が高い', () => {
      expect(PLAN_MAX_IMAGE_WIDTH.patron).toBeGreaterThan(PLAN_MAX_IMAGE_WIDTH.support)
      expect(PLAN_MAX_IMAGE_WIDTH.support).toBeGreaterThan(PLAN_MAX_IMAGE_WIDTH.basic)
    })
  })

  describe('PLAN_MAX_UPLOAD_SIZE', () => {
    it('basic=1MB, support=5MB, patron=10MB', () => {
      expect(PLAN_MAX_UPLOAD_SIZE.basic).toBe(1 * 1024 * 1024)
      expect(PLAN_MAX_UPLOAD_SIZE.support).toBe(5 * 1024 * 1024)
      expect(PLAN_MAX_UPLOAD_SIZE.patron).toBe(10 * 1024 * 1024)
    })

    it('上位プランのサイズは basic 以上', () => {
      expect(PLAN_MAX_UPLOAD_SIZE.support).toBeGreaterThanOrEqual(PLAN_MAX_UPLOAD_SIZE.basic)
      expect(PLAN_MAX_UPLOAD_SIZE.patron).toBeGreaterThanOrEqual(PLAN_MAX_UPLOAD_SIZE.basic)
    })
  })

  describe('PLAN_STORAGE_BONUS', () => {
    it('basic=0, support=250MB, patron=500MB', () => {
      expect(PLAN_STORAGE_BONUS.basic).toBe(0)
      expect(PLAN_STORAGE_BONUS.support).toBe(250 * 1024 * 1024)
      expect(PLAN_STORAGE_BONUS.patron).toBe(500 * 1024 * 1024)
    })
  })
})

describe('getPlanStorageBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should return 0 for basic plan', async () => {
    primePlanDb({ licenseRows: [] })

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-basic')
    expect(result).toBe(0)
  })

  it('should return 250MB for support plan', async () => {
    primePlanDb({ licenseRows: [{ plan_type: 'support' }] })

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-support')
    expect(result).toBe(250 * 1024 * 1024)
  })

  it('should return 500MB for patron plan', async () => {
    primePlanDb({ licenseRows: [{ plan_type: 'patron' }] })

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-patron')
    expect(result).toBe(500 * 1024 * 1024)
  })
})
