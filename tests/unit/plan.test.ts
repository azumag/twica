import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PLAN_STORAGE_BONUS,
  PLAN_MAX_IMAGE_WIDTH,
  PLAN_MAX_UPLOAD_SIZE,
  type PlanType,
} from '@/lib/plan'
import { hasTwitchSub } from '@/lib/twitch/sub-check'

vi.mock('@/lib/logger')
vi.mock('@/lib/twitch/sub-check', () => ({
  hasTwitchSub: vi.fn().mockResolvedValue(false),
  isTwitchSubCheckEnabled: vi.fn().mockReturnValue(false),
}))
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

describe('getUserPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should return basic when user has no licenses', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
    } as any)

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-no-license')
    expect(result).toBe('basic')
  })

  it('should return support when user has active support license', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [{ plan_type: 'support', support_codes: { status: 'active' } }],
          error: null,
        }),
      })),
    } as any)

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-support')
    expect(result).toBe('support')
  })

  it('should return patron when user has both support and patron licenses (highest wins)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [
            { plan_type: 'support', support_codes: { status: 'active' } },
            { plan_type: 'patron', support_codes: { status: 'active' } },
          ],
          error: null,
        }),
      })),
    } as any)

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-multi')
    expect(result).toBe('patron')
  })

  it('should return basic when DB query fails (graceful degradation)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'DB connection error' },
        }),
      })),
    } as any)

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-error')
    expect(result).toBe('basic')
  })

  it('should return basic when an exception is thrown', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => {
        throw new Error('unexpected error')
      }),
    } as any)

    const { getUserPlan } = await import('@/lib/plan')
    const result = await getUserPlan('user-throw')
    expect(result).toBe('basic')
  })

  it('getUserPlanSnapshot uses DB state without calling Twitch subscription API', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const from = vi.fn((table: string) => {
      if (table === 'user_licenses') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({
            data: [{ plan_type: 'support', support_codes: { status: 'active' } }],
            error: null,
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { twitch_has_sub: true },
          error: null,
        }),
      }
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as any)

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
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
    } as any)

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-basic')
    expect(result).toBe(0)
  })

  it('should return 250MB for support plan', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [{ plan_type: 'support', support_codes: { status: 'active' } }],
          error: null,
        }),
      })),
    } as any)

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-support')
    expect(result).toBe(250 * 1024 * 1024)
  })

  it('should return 500MB for patron plan', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [{ plan_type: 'patron', support_codes: { status: 'active' } }],
          error: null,
        }),
      })),
    } as any)

    const { getPlanStorageBytes } = await import('@/lib/plan')
    const result = await getPlanStorageBytes('user-patron')
    expect(result).toBe(500 * 1024 * 1024)
  })
})
