import { describe, it, expect, vi, beforeEach } from 'vitest'

// Supabaseモック（user_licensesクエリ用）
function createLicenseQueryBuilder(returnData: unknown[] = []) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: returnData, error: null }),
  }
}

describe('PlanType with twitch_sub', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  function setupMocks(options: {
    licenses?: unknown[]
    hasTwitchSub?: boolean
  }) {
    const { licenses = [], hasTwitchSub = false } = options

    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({
        from: vi.fn(() => createLicenseQueryBuilder(licenses)),
      })),
    }))
    vi.doMock('@/lib/twitch/sub-check', () => ({
      hasTwitchSub: hasTwitchSub
        ? vi.fn().mockResolvedValue(true)
        : vi.fn().mockResolvedValue(false),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('react', () => ({ cache: (fn: (...args: unknown[]) => unknown) => fn }))
  }

  it('twitch_sub プランの定数値が patron と同等であること', async () => {
    setupMocks({})

    const { PLAN_STORAGE_BONUS, PLAN_MAX_IMAGE_WIDTH, PLAN_MAX_UPLOAD_SIZE } = await import('@/lib/plan')

    expect(PLAN_STORAGE_BONUS.twitch_sub).toBe(PLAN_STORAGE_BONUS.patron)
    expect(PLAN_MAX_IMAGE_WIDTH.twitch_sub).toBe(PLAN_MAX_IMAGE_WIDTH.patron)
    expect(PLAN_MAX_UPLOAD_SIZE.twitch_sub).toBe(PLAN_MAX_UPLOAD_SIZE.patron)
  })

  it('Twitchサブスクがある場合は twitch_sub を返す', async () => {
    setupMocks({ licenses: [], hasTwitchSub: true })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('twitch_sub')
  })

  it('patronライセンス保持者はTwitchサブスクがあってもpatronを返す', async () => {
    setupMocks({
      licenses: [{ plan_type: 'patron', support_codes: { status: 'active' } }],
      hasTwitchSub: true,
    })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    // patron(2) と twitch_sub(2) は同優先度。
    // subPlan(twitch_sub)の優先度(2) > licensePlan(patron)の優先度(2) は偽なので patron が返る
    expect(plan).toBe('patron')
  })

  it('Twitchサブスクなしでライセンスなしの場合は basic を返す', async () => {
    setupMocks({ licenses: [], hasTwitchSub: false })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('basic')
  })

  it('supportライセンスのみでTwitchサブスクがある場合は twitch_sub を返す', async () => {
    setupMocks({
      licenses: [{ plan_type: 'support', support_codes: { status: 'active' } }],
      hasTwitchSub: true,
    })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    // support(1) < twitch_sub(2) なので twitch_sub が返る
    expect(plan).toBe('twitch_sub')
  })

  it('Twitchサブスク判定でエラーが発生してもbasicにフォールバックする', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({
        from: vi.fn(() => createLicenseQueryBuilder([])),
      })),
    }))
    vi.doMock('@/lib/twitch/sub-check', () => ({
      hasTwitchSub: vi.fn().mockRejectedValue(new Error('Twitch API error')),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('react', () => ({ cache: (fn: (...args: unknown[]) => unknown) => fn }))

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('basic')
  })
})
