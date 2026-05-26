import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/streamer/additional-rewards/route'
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

function createThenableQuery(data: unknown, error: unknown = null) {
  const query = createMockQueryBuilder()
  ;(query as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve({ data, error })
    return query
  }
  return query
}

describe('/api/streamer/additional-rewards raid options', () => {
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

  it('persists drawCount and raid-limited options for an additional reward', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1', channel_point_reward_id: 'main-reward' },
      error: null,
    })
    const insertQuery = createMockQueryBuilder()
    ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: 'additional-1',
        reward_id: 'raid-reward',
        reward_name: 'Raid 10',
        draw_count: 10,
        is_raid_limited: true,
      },
      error: null,
    })
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'streamer_additional_gacha_rewards') return insertQuery
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rewardId: 'raid-reward',
        rewardName: 'Raid 10',
        drawCount: 10,
        isRaidLimited: true,
      }),
    }))

    expect(response.status).toBe(200)
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      draw_count: 10,
      is_raid_limited: true,
    }))
  })

  it('rejects drawCount outside the supported range', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rewardId: 'raid-reward',
        rewardName: 'Raid 20',
        drawCount: 20,
        isRaidLimited: true,
      }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'drawCount must be an integer between 1 and 10',
    })
  })

  it('rejects new additional rewards while raid option columns are not in schema cache yet', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1', channel_point_reward_id: 'main-reward' },
      error: null,
    })
    const insertQuery = createMockQueryBuilder()
    ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: {
        message: "Could not find the 'draw_count' column",
        code: 'PGRST204',
      },
    })
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'streamer_additional_gacha_rewards') return insertQuery
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rewardId: 'raid-reward',
        rewardName: 'Raid 10',
        drawCount: 10,
        isRaidLimited: true,
      }),
    }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: '追加報酬のN連ガチャ設定がまだDBに反映されていません。少し待ってから再度追加してください。',
    })
  })

  it('normalizes legacy rows on GET when raid option columns are not in schema cache yet', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1' },
      error: null,
    })
    const optionQuery = createThenableQuery(null, {
      message: "Could not find the 'draw_count' column",
      code: 'PGRST204',
    })
    const fallbackQuery = createThenableQuery([
      {
        id: 'additional-1',
        reward_id: 'legacy-reward',
        reward_name: 'Legacy',
        created_at: '2026-05-12T00:00:00Z',
      },
    ])
    let additionalQueryCount = 0
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'streamer_additional_gacha_rewards') {
        additionalQueryCount += 1
        return additionalQueryCount === 1 ? optionQuery : fallbackQuery
      }
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await GET(new NextRequest('http://localhost/api/streamer/additional-rewards'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        reward_id: 'legacy-reward',
        draw_count: 1,
        is_raid_limited: false,
      }),
    ])
  })
})
