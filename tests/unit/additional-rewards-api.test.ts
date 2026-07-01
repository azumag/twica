import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/streamer/additional-rewards/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { createMockQueryBuilder } from '../utils/supabase-mock'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'

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

  // Issue #393: pack binding for additional rewards
  it('persists collectionName when the pack has active cards', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      // Issue #393再設計: collectionName は card_pack_names に登録済みである必要がある。
      data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: ['weapons'] },
      error: null,
    })
    // existence check: cards query is awaited directly → must be thenable {count}
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 2, error: null })
      return cardsQuery
    }
    const insertQuery = createMockQueryBuilder()
    ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'additional-1', reward_id: 'extra-reward', collection_name: 'weapons' },
      error: null,
    })
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'cards') return cardsQuery
      if (table === 'streamer_additional_gacha_rewards') return insertQuery
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }),
    }))

    expect(response.status).toBe(200)
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({ collection_name: 'weapons' }))
  })

  it('rejects an additional reward bound to a pack with no active cards (400)', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      // 'empty-pack' は登録済み(card_pack_names)だが、アクティブカードが無い。
      data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: ['empty-pack'] },
      error: null,
    })
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 0, error: null })
      return cardsQuery
    }
    const insertQuery = createMockQueryBuilder()
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'cards') return cardsQuery
      if (table === 'streamer_additional_gacha_rewards') return insertQuery
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Empty', collectionName: 'empty-pack' }),
    }))

    expect(response.status).toBe(400)
    // the insert must never run when the pack is empty
    expect(insertQuery.insert).not.toHaveBeenCalled()
  })

  it('rejects a present-but-invalid collectionName type (400)', async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: vi.fn() } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardId: 'extra-reward', collectionName: 123 }),
    }))

    expect(response.status).toBe(400)
  })

  // Issue #393再設計: 追加報酬は更新エンドポイントが無いため、非null値は常に
  // 「新規紐付け」として扱われ、事前登録済み(card_pack_names)であることを要求する。
  // #269のプレミアムゲートは廃止(パック管理モーダルでの追加時のみに移設)。
  describe('card-pack membership validation (Issue #393再設計)', () => {
    it('rejects binding an unregistered pack name (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: ['characters'] },
        error: null,
      })
      const insertQuery = createMockQueryBuilder()
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
        body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }),
      }))

      expect(response.status).toBe(400)
      expect(insertQuery.insert).not.toHaveBeenCalled()
    })

    // Non-regression: collectionName-less reward creation is pre-#393
    // functionality and must keep working regardless of card_pack_names.
    it('still creates a reward with no pack (non-regression)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: [] },
        error: null,
      })
      const insertQuery = createMockQueryBuilder()
      ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'additional-1', reward_id: 'extra-reward' },
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
        body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'No Pack' }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
    })

    // Issue #555: DEFAULT_PACK_SENTINEL ("default pack only") is a reserved
    // value that can never appear in card_pack_names, so the ordinary
    // membership check must be skipped for it. Existence of at least one
    // active unclassified card is still required.
    it('accepts DEFAULT_PACK_SENTINEL without requiring it in card_pack_names, given active unclassified cards', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        // card_pack_names intentionally does NOT (and never can) contain the sentinel.
        data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: ['weapons'] },
        error: null,
      })
      const cardsQuery = createMockQueryBuilder()
      ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ count: 1, error: null })
        return cardsQuery
      }
      const insertQuery = createMockQueryBuilder()
      ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'additional-1', reward_id: 'extra-reward', collection_name: DEFAULT_PACK_SENTINEL },
        error: null,
      })
      const fromMock = vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'cards') return cardsQuery
        if (table === 'streamer_additional_gacha_rewards') return insertQuery
        return createMockQueryBuilder()
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Default', collectionName: DEFAULT_PACK_SENTINEL }),
      }))

      expect(response.status).toBe(200)
      // existence check must use the sentinel-aware .is('collection_name', null) path
      expect(cardsQuery.is).toHaveBeenCalledWith('collection_name', null)
      expect(insertQuery.insert).toHaveBeenCalledWith(
        expect.objectContaining({ collection_name: DEFAULT_PACK_SENTINEL })
      )
    })

    it('rejects DEFAULT_PACK_SENTINEL when there are zero active unclassified cards (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer-1', channel_point_reward_id: 'main-reward', card_pack_names: [] },
        error: null,
      })
      const cardsQuery = createMockQueryBuilder()
      ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ count: 0, error: null })
        return cardsQuery
      }
      const insertQuery = createMockQueryBuilder()
      const fromMock = vi.fn((table: string) => {
        if (table === 'streamers') return streamerQuery
        if (table === 'cards') return cardsQuery
        if (table === 'streamer_additional_gacha_rewards') return insertQuery
        return createMockQueryBuilder()
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Default', collectionName: DEFAULT_PACK_SENTINEL }),
      }))

      expect(response.status).toBe(400)
      expect(insertQuery.insert).not.toHaveBeenCalled()
    })

    // Self-review regression guard (carried over from #269): the
    // ownership-check SELECT reads card_pack_names. Undeployed must not
    // break reward creation (only the pack binding is dropped).
    it('creates the reward but drops the pack binding when card_pack_names is not deployed yet (deploy window)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { code: '42703', message: 'column streamers.card_pack_names does not exist' },
      })
      const retryStreamerQuery = createMockQueryBuilder()
      ;(retryStreamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer-1', channel_point_reward_id: 'main-reward' },
        error: null,
      })
      const insertQuery = createMockQueryBuilder()
      ;(insertQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'additional-1', reward_id: 'extra-reward', collection_name: null },
        error: null,
      })
      let streamerCalls = 0
      const fromMock = vi.fn((table: string) => {
        if (table === 'streamers') {
          streamerCalls += 1
          return streamerCalls === 1 ? streamerQuery : retryStreamerQuery
        }
        if (table === 'streamer_additional_gacha_rewards') return insertQuery
        return createMockQueryBuilder()
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost/api/streamer/additional-rewards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rewardId: 'extra-reward', rewardName: 'Weapons', collectionName: 'weapons' }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.collectionNameSkippedDeployWindow).toBe(true)
      expect(insertQuery.insert).toHaveBeenCalledWith(
        expect.not.objectContaining({ collection_name: expect.anything() })
      )
    })
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

  // Issue #393: GET read-path fallback when only the collection_name column is
  // missing (deploy window). Real PostgREST returns 42703 on SELECT, and this
  // must fall back BEFORE the raid-options branch so draw_count/is_raid_limited
  // are preserved (not reset).
  it('normalizes rows on GET when the collection_name column is not deployed yet (READ 42703)', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer-1' },
      error: null,
    })
    const collectionMissingQuery = createThenableQuery(null, {
      message: 'column streamer_additional_gacha_rewards.collection_name does not exist',
      code: '42703',
    })
    const fallbackQuery = createThenableQuery([
      {
        id: 'additional-1',
        reward_id: 'reward-1',
        reward_name: 'Reward',
        draw_count: 5,
        is_raid_limited: true,
        created_at: '2026-05-12T00:00:00Z',
      },
    ])
    let additionalQueryCount = 0
    const fromMock = vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'streamer_additional_gacha_rewards') {
        additionalQueryCount += 1
        return additionalQueryCount === 1 ? collectionMissingQuery : fallbackQuery
      }
      return createMockQueryBuilder()
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const response = await GET(new NextRequest('http://localhost/api/streamer/additional-rewards'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      // draw_count / is_raid_limited preserved; collection_name defaulted to null
      expect.objectContaining({
        reward_id: 'reward-1',
        draw_count: 5,
        is_raid_limited: true,
        collection_name: null,
      }),
    ])
  })
})
