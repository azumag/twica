import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger')
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

  it('should return 500MB for support plan', async () => {
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
    expect(result).toBe(500 * 1024 * 1024)
  })

  it('should return 1GB for patron plan', async () => {
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
    expect(result).toBe(1024 * 1024 * 1024)
  })
})
