import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getUserPlan } from '@/lib/plan'
import { createSupabaseMock, createMockQueryBuilder } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
// Issue #269: most pre-existing tests below assume an authorized (non-basic)
// streamer, since they predate plan gating. Default to a premium plan here so
// they keep exercising collection-name persistence rather than the gate;
// gate-specific tests override this per-case.
vi.mock('@/lib/plan')
// 本物の constants モジュールを保持する。RARITIES が空配列になると
// route.ts の DEFAULT_RARITY_VALUES が空となり、デフォルトレアリティとの
// 衝突検出ができなくなるため、ファクトリで実体をそのまま返す。
vi.mock('@/lib/constants', async (importOriginal) => await importOriginal())
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockGetUserPlan = vi.mocked(getUserPlan)

describe('POST /api/streamer/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockGetSession.mockResolvedValue({
      twitchUserId: 'streamer123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.jpg',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      version: 1,
    })

    mockCanUseStreamerFeatures.mockReturnValue(true)
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    })

    mockValidateCSRFToken.mockResolvedValue({ valid: true })
    mockValidateContentType.mockReturnValue(null)
    mockGetUserPlan.mockResolvedValue('support')
  })

  it('should update streamer settings with valid data', async () => {
    const mockSupabase = createSupabaseMock()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
      .build()

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: 'reward-123',
        channelPointRewardName: 'Test Reward',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.recalculatedCards).toBeNull()
    expect(getSupabaseAdmin).toHaveBeenCalled()
  })

  it('should update multi-draw chat announcement settings', async () => {
    const builder = createSupabaseMock()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
    const mockSupabase = builder.build()
    const query = builder.getQueryBuilder()

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        chatAnnouncementEnabled: true,
        chatAnnouncementTemplate: '@{user} got {card}',
        chatAnnouncementMultiTemplate: '@{user}: {draws}連 {rarityCounts} {cards}',
        chatAnnouncementMultiShowCards: false,
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
      chat_announcement_enabled: true,
      chat_announcement_template: '@{user} got {card}',
      chat_announcement_multi_template: '@{user}: {draws}連 {rarityCounts} {cards}',
      chat_announcement_multi_show_cards: false,
    }))
  })

  it('should reject rarity weights when total is not 100%', async () => {
    const mockSupabase = createSupabaseMock().build()

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        rarityWeights: { common: 50, rare: 30, epic: 15, legendary: 15 },
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe('Rarity weights total must be 100%')
  })

  it('should allow empty rarity weights object for manual mode switch', async () => {
    const mockSupabase = createSupabaseMock()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
      .build()

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        rarityWeights: {},
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
  })

  // C5: rarity_weights キーのバリデーション/正規化
  describe('rarity weights key validation (C5)', () => {
    const buildRequest = (rarityWeights: unknown) =>
      new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', rarityWeights }),
      })

    const mockOk = async () => {
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const built = mockSupabase.build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        built as unknown as ReturnType<typeof getSupabaseAdmin>
      )
      return mockSupabase.getQueryBuilder()
    }

    it('rejects empty string key', async () => {
      await mockOk()
      const response = await POST(buildRequest({ '': 100 }))
      expect(response.status).toBe(400)
    })

    it('rejects key that is whitespace only (empty after trim)', async () => {
      await mockOk()
      const response = await POST(buildRequest({ '   ': 100 }))
      expect(response.status).toBe(400)
    })

    it('rejects key longer than 40 chars', async () => {
      await mockOk()
      const response = await POST(buildRequest({ ['a'.repeat(41)]: 100 }))
      expect(response.status).toBe(400)
    })

    it('rejects key containing control characters', async () => {
      await mockOk()
      const response = await POST(buildRequest({ ['rare\u0001']: 100 }))
      expect(response.status).toBe(400)
    })

    it('rejects key containing bidi override characters', async () => {
      await mockOk()
      const response = await POST(buildRequest({ ['rare\u202E']: 100 }))
      expect(response.status).toBe(400)
    })

    it('rejects duplicate keys after trim/NFC normalization', async () => {
      await mockOk()
      // " common " と "common" は trim 後に衝突する
      const response = await POST(buildRequest({ common: 50, ' common ': 50 }))
      expect(response.status).toBe(400)
    })

    it('persists trimmed/NFC-normalized keys when valid', async () => {
      const query = await mockOk()
      // 前後空白付きキー(合計100%)。trim 後の "common"/"rare" で保存されること。
      const response = await POST(buildRequest({ ' common ': 70, rare: 30 }))
      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(
        expect.objectContaining({ rarity_weights: { common: 70, rare: 30 } })
      )
    })
  })

  describe('custom rarities validation', () => {
    const buildRequest = (customRarities: unknown) =>
      new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', customRarities }),
      })

    const mockOk = async () => {
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const built = mockSupabase.build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        built as unknown as ReturnType<typeof getSupabaseAdmin>
      )
      return mockSupabase.getQueryBuilder()
    }

    it('rejects non-array value', async () => {
      await mockOk()
      const response = await POST(buildRequest({ super: 1 }))
      expect(response.status).toBe(400)
    })

    it('rejects non-string element', async () => {
      await mockOk()
      const response = await POST(buildRequest(['super', 123]))
      expect(response.status).toBe(400)
    })

    it('rejects empty / whitespace-only name', async () => {
      await mockOk()
      const response = await POST(buildRequest(['   ']))
      expect(response.status).toBe(400)
    })

    it('rejects name longer than 40 chars', async () => {
      await mockOk()
      const response = await POST(buildRequest(['a'.repeat(41)]))
      expect(response.status).toBe(400)
    })

    it('rejects control characters', async () => {
      await mockOk()
      const response = await POST(buildRequest(['super']))
      expect(response.status).toBe(400)
    })

    it('rejects bidi override characters', async () => {
      await mockOk()
      const response = await POST(
        buildRequest([`super${String.fromCharCode(0x202e)}`])
      )
      expect(response.status).toBe(400)
    })

    it('rejects collision with a default rarity', async () => {
      await mockOk()
      const response = await POST(buildRequest(['common']))
      expect(response.status).toBe(400)
    })

    it('rejects duplicates after trim/NFC normalization', async () => {
      await mockOk()
      const response = await POST(buildRequest(['super', ' super ']))
      expect(response.status).toBe(400)
    })

    it('rejects more than 50 entries', async () => {
      await mockOk()
      const many = Array.from({ length: 51 }, (_, i) => `r${i}`)
      const response = await POST(buildRequest(many))
      expect(response.status).toBe(400)
    })

    it('persists trimmed/NFC-normalized names when valid', async () => {
      const query = await mockOk()
      const response = await POST(buildRequest([' super ', 'ultra']))
      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(
        expect.objectContaining({ custom_rarities: ['super', 'ultra'] })
      )
    })

    it('does not trigger drop-rate recalculation', async () => {
      await mockOk()
      const response = await POST(buildRequest(['super']))
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.recalculatedCards).toBeNull()
    })
  })

  it('should return 403 when CSRF token is invalid', async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    const data = await response.json()
    expect(data.error).toBe('Forbidden')
  })

  it('should return 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('should return 401 when user cannot use streamer features', async () => {
    const mockSupabase = createSupabaseMock().build()
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

    vi.mocked(canUseStreamerFeatures).mockReturnValue(false)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(401)
    const data = await response.json()
    expect(data.error).toBe('Unauthorized')
  })

  // Issue #395: 視聴者向け未所持カード表示設定
  // The settings API must accept showUnownedCards / showUnownedCardDetails as
  // independent booleans, validate non-boolean inputs strictly, and persist
  // them via the existing dynamic updateData pattern.
  describe('unowned card visibility settings (Issue #395)', () => {
    it('should accept showUnownedCards/showUnownedCardDetails when both are booleans', async () => {
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          showUnownedCards: true,
          showUnownedCardDetails: false,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
    })

    it('should reject showUnownedCards when not a boolean', async () => {
      const mockSupabase = createSupabaseMock().build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          // 文字列 "true" は truthy だが boolean ではないので 400 にしたい
          showUnownedCards: 'true',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
    })

    it('should reject showUnownedCardDetails when not a boolean', async () => {
      const mockSupabase = createSupabaseMock().build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          showUnownedCardDetails: 1,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
    })

    it('should accept independent showUnownedCardDetails toggle without showUnownedCards', async () => {
      // 設定UIはトグル単位で部分送信するため、片方だけが届くケースが正常系
      // The UI may send only one of the two booleans on toggle; both halves must work alone.
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          showUnownedCardDetails: true,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
    })
  })

  it('should return 429 when rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60000,
    })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(429)
    const data = await response.json()
    expect(data.error).toBe('Too many requests. Please try again later.')
  })

  // Issue #393: main-reward pack binding
  it('persists channelPointCollectionName when the pack has active cards', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer123', twitch_user_id: 'streamer123' },
      error: null,
    })
    // existence check: cards query awaited directly → thenable {count}
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 3, error: null })
      return cardsQuery
    }

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: 'reward-123',
        channelPointCollectionName: 'weapons',
      }),
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(streamerQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel_point_collection_name: 'weapons' })
    )
  })

  it('rejects binding the main reward to a pack with no active cards (400)', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer123', twitch_user_id: 'streamer123' },
      error: null,
    })
    const cardsQuery = createMockQueryBuilder()
    ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 0, error: null })
      return cardsQuery
    }

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: 'reward-123',
        channelPointCollectionName: 'empty-pack',
      }),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(streamerQuery.update).not.toHaveBeenCalled()
  })

  it('rejects a present-but-invalid channelPointCollectionName type (400)', async () => {
    const streamerQuery = createMockQueryBuilder()
    ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'streamer123', twitch_user_id: 'streamer123' },
      error: null,
    })

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn(() => streamerQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointCollectionName: 123,
      }),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  // Issue #269: premium gate for the main-reward pack binding.
  describe('card-pack premium gate (Issue #269)', () => {
    it('drops a NEW pack binding on the basic plan but still saves it (200, no DB write, flag set)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointCollectionName: 'weapons',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
      expect(data.collectionNamePremiumRequired).toBe(true)
      // Gated: the pack binding itself must never reach the DB write, and the
      // pack-existence check must be skipped (it would otherwise wrongly 400
      // on a since-deactivated pack even though nothing is being persisted).
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    it('saves rarityWeights alongside a gated pack-binding attempt on the basic plan (no collateral failure)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointCollectionName: 'weapons',
          rarityWeights: { common: 50, rare: 50 },
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.collectionNamePremiumRequired).toBe(true)
      // The unrelated field still saves — basic-plan users keep settings access.
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ rarity_weights: { common: 50, rare: 50 } })
      )
      const updateCall = (streamerQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateCall).not.toHaveProperty('channel_point_collection_name')
    })

    it('allows resubmitting the SAME pack value on the basic plan (no-op change, no gate)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: 'weapons' },
        error: null,
      })
      const cardsQuery = createMockQueryBuilder()
      ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ count: 3, error: null })
        return cardsQuery
      }

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointCollectionName: 'weapons',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.collectionNamePremiumRequired).toBeUndefined()
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_collection_name: 'weapons' })
      )
      // getUserPlan must not even be consulted for a no-op resubmission.
      expect(mockGetUserPlan).not.toHaveBeenCalled()
    })

    it('allows clearing an existing pack binding to null on the basic plan', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: 'weapons' },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointCollectionName: null,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.collectionNamePremiumRequired).toBeUndefined()
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_collection_name: null })
      )
      expect(mockGetUserPlan).not.toHaveBeenCalled()
    })

    // Self-review regression guard: the ownership-check SELECT now also
    // reads channel_point_collection_name for the gate's currentValue. If
    // that column isn't migrated yet, the SELECT itself errors (42703) and
    // must NOT 403 an otherwise-valid settings save unrelated to packs.
    it('still saves other settings when channel_point_collection_name is not deployed yet (deploy window)', async () => {
      const selectQuery = createMockQueryBuilder()
      ;(selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { code: '42703', message: 'column streamers.channel_point_collection_name does not exist' },
      })
      const retrySelectQuery = createMockQueryBuilder()
      ;(retrySelectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123' },
        error: null,
      })
      const updateQuery = createMockQueryBuilder()
      let selectCalls = 0
      const fromMock = vi.fn(() => {
        selectCalls += 1
        if (selectCalls === 1) return selectQuery
        if (selectCalls === 2) return retrySelectQuery
        return updateQuery
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointRewardId: 'reward-123',
          channelPointRewardName: 'Test Reward',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(updateQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_reward_id: 'reward-123' })
      )
    })
  })
})
