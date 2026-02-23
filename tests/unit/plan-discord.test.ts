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
    hasDiscordSub?: boolean
    discordEnabled?: boolean
  }) {
    const { licenses = [], hasDiscordSub = false, discordEnabled = true } = options

    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({
        from: vi.fn(() => createLicenseQueryBuilder(licenses)),
      })),
    }))
    vi.doMock('@/lib/discord/role-check', () => ({
      hasDiscordSubRole: hasDiscordSub
        ? vi.fn().mockResolvedValue(true)
        : vi.fn().mockResolvedValue(false),
      isDiscordEnabled: vi.fn().mockReturnValue(discordEnabled),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('react', () => ({ cache: (fn: Function) => fn }))
  }

  it('twitch_sub プランの定数値が patron と同等であること', async () => {
    setupMocks({ discordEnabled: false })

    const { PLAN_STORAGE_BONUS, PLAN_MAX_IMAGE_WIDTH, PLAN_MAX_UPLOAD_SIZE } = await import('@/lib/plan')

    expect(PLAN_STORAGE_BONUS.twitch_sub).toBe(PLAN_STORAGE_BONUS.patron)
    expect(PLAN_MAX_IMAGE_WIDTH.twitch_sub).toBe(PLAN_MAX_IMAGE_WIDTH.patron)
    expect(PLAN_MAX_UPLOAD_SIZE.twitch_sub).toBe(PLAN_MAX_UPLOAD_SIZE.patron)
  })

  it('Discord連携でサブスクロールがある場合は twitch_sub を返す', async () => {
    setupMocks({ licenses: [], hasDiscordSub: true })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('twitch_sub')
  })

  it('patronライセンス保持者はDiscordサブスクがあってもpatronを返す', async () => {
    setupMocks({
      licenses: [{ plan_type: 'patron', support_codes: { status: 'active' } }],
      hasDiscordSub: true,
    })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    // patron(2) と twitch_sub(2) は同優先度。
    // discordPlan(twitch_sub)の優先度(2) > licensePlan(patron)の優先度(2) は偽なので patron が返る
    expect(plan).toBe('patron')
  })

  it('Discord連携なしでライセンスなしの場合は basic を返す', async () => {
    setupMocks({ licenses: [], hasDiscordSub: false })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('basic')
  })

  it('supportライセンスのみでDiscordサブスクがある場合は twitch_sub を返す', async () => {
    setupMocks({
      licenses: [{ plan_type: 'support', support_codes: { status: 'active' } }],
      hasDiscordSub: true,
    })

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    // support(1) < twitch_sub(2) なので twitch_sub が返る
    expect(plan).toBe('twitch_sub')
  })

  it('Discord判定でエラーが発生してもbasicにフォールバックする', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      getSupabaseAdmin: vi.fn(() => ({
        from: vi.fn(() => createLicenseQueryBuilder([])),
      })),
    }))
    vi.doMock('@/lib/discord/role-check', () => ({
      hasDiscordSubRole: vi.fn().mockRejectedValue(new Error('Discord API error')),
      isDiscordEnabled: vi.fn().mockReturnValue(true),
    }))
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }))
    vi.doMock('react', () => ({ cache: (fn: Function) => fn }))

    const { getUserPlan } = await import('@/lib/plan')
    const plan = await getUserPlan('user-123')

    expect(plan).toBe('basic')
  })
})
