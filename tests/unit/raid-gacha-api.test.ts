// Issue #641: 連ガチャ上限を10枚から15枚に引き上げ。
// raid-gacha ルート(streamers.raid_gacha_draw_count)には元々このバリデーションの
// 境界値テストが存在しなかった(実装プランで既存カバレッジの欠落として指摘済み)ため、
// additional-rewards-api.test.ts の起こしパターンに倣って新規に追加する。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/raid-gacha/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { createMockQueryBuilder } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)

function postRequest(drawCount: unknown) {
  return new NextRequest('http://localhost/api/streamer/raid-gacha', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drawCount }),
  })
}

describe('/api/streamer/raid-gacha drawCount boundary validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'streamer-twitch-1',
      twitchUsername: 'streamer',
      twitchDisplayName: 'Streamer',
      twitchProfileImageUrl: null,
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
    })
    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    })
    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockValidateContentType.mockReturnValue(null)
  })

  it('rejects a drawCount above the new upper bound (16 > 15) with a 400 and updated error message', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(postRequest(16))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'drawCount must be an integer between 0 and 15',
    })
  })

  it('rejects a negative drawCount with a 400', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(postRequest(-1))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'drawCount must be an integer between 0 and 15',
    })
  })

  it('accepts the new upper boundary value (15) and persists it', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1', raid_gacha_active_until: null, raid_gacha_draw_count: 10 },
      error: null,
    })
    const updateQuery = createMockQueryBuilder()
    ;(updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { raid_gacha_active_until: null, raid_gacha_draw_count: 15 },
      error: null,
    })
    // getOwnedStreamer does a SELECT (streamerQuery); POST then does an
    // UPDATE (updateQuery) on the same table, so `from('streamers')` must
    // be called twice and return the right builder each time.
    let streamersCallCount = 0
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') {
        streamersCallCount += 1
        return streamersCallCount === 1 ? streamerQuery : updateQuery
      }
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(postRequest(15))

    expect(response.status).toBe(200)
    expect(updateQuery.update).toHaveBeenCalledWith({ raid_gacha_draw_count: 15 })
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true, drawCount: 15 })
    )
  })

  it('rejects the old upper boundary plus one (11) only if it exceeds the configured limit (non-regression: 11-15 now valid)', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1', raid_gacha_active_until: null, raid_gacha_draw_count: 0 },
      error: null,
    })
    const updateQuery = createMockQueryBuilder()
    ;(updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { raid_gacha_active_until: null, raid_gacha_draw_count: 11 },
      error: null,
    })
    let streamersCallCount = 0
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') {
        streamersCallCount += 1
        return streamersCallCount === 1 ? streamerQuery : updateQuery
      }
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    // 11 was rejected under the old (<=10) limit; issue #641 raises the cap to 15,
    // so this value (previously invalid) must now be accepted end to end.
    const response = await POST(postRequest(11))

    expect(response.status).toBe(200)
    expect(updateQuery.update).toHaveBeenCalledWith({ raid_gacha_draw_count: 11 })
  })
})
