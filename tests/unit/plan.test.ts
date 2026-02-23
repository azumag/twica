import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PLAN_STORAGE_BONUS,
  PLAN_MAX_IMAGE_WIDTH,
  PLAN_MAX_UPLOAD_SIZE,
  type PlanType,
} from '@/lib/plan'

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

describe('getCropModes', () => {
  // ImageCropperは"use client"なのでvitest/jsdomで動く
  it('デフォルト800pxでCROP_MODESと同じ値を返す', async () => {
    const { getCropModes, CROP_MODES } = await import('@/components/ImageCropper')
    const modes = getCropModes(800)
    expect(modes.square.width).toBe(CROP_MODES.square.width)
    expect(modes.square.height).toBe(CROP_MODES.square.height)
    expect(modes.portrait.width).toBe(CROP_MODES.portrait.width)
    expect(modes.portrait.height).toBe(CROP_MODES.portrait.height)
  })

  it('1920pxでFull HD幅のサイズを生成', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes = getCropModes(1920)
    expect(modes.square.width).toBe(1920)
    expect(modes.square.height).toBe(1920)
    expect(modes.portrait.width).toBe(1920)
    // 高さはアスペクト比 1118/800 を維持
    expect(modes.portrait.height).toBe(Math.round(1920 * (1118 / 800)))
    expect(modes.square.dimensions).toBe('1920x1920')
  })

  it('3840pxで4K幅のサイズを生成', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes = getCropModes(3840)
    expect(modes.square.width).toBe(3840)
    expect(modes.portrait.width).toBe(3840)
    expect(modes.portrait.height).toBe(Math.round(3840 * (1118 / 800)))
  })

  it('アスペクト比は幅に関わらず一定', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes800 = getCropModes(800)
    const modes1920 = getCropModes(1920)
    // 正方形のアスペクト比は常に1
    expect(modes800.square.aspect).toBe(1)
    expect(modes1920.square.aspect).toBe(1)
    // ポートレイトのアスペクト比は許容誤差0.001以内で同じ
    expect(Math.abs(modes800.portrait.aspect - modes1920.portrait.aspect)).toBeLessThan(0.001)
  })
})
