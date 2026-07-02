import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getUserPlan } from '@/lib/plan'
import { createSupabaseMock, createMockQueryBuilder } from '../utils/supabase-mock'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'

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
      // Issue #393再設計: channelPointCollectionName は card_pack_names に
      // 登録済みである必要がある。
      data: { id: 'streamer123', twitch_user_id: 'streamer123', card_pack_names: ['weapons'] },
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
      // 'empty-pack' は登録済み(card_pack_names)だが、アクティブカードが無い。
      data: { id: 'streamer123', twitch_user_id: 'streamer123', card_pack_names: ['empty-pack'] },
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

  // Issue #393再設計: channelPointCollectionName は登録済みパック名(または
  // 現在値と同じ/null)であることを要求するmembership検証。
  describe('card-pack membership validation (Issue #393再設計)', () => {
    it('rejects binding the main reward to an unregistered pack name (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['characters'] },
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
      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    it('allows resubmitting the SAME pack value even if it was since removed from the registered list (orphaned pack)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: 'weapons', card_pack_names: [] },
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
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_collection_name: 'weapons' })
      )
    })

    it('allows clearing an existing pack binding to null regardless of the registered list', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: 'weapons', card_pack_names: [] },
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
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_collection_name: null })
      )
    })

    // Issue #555: DEFAULT_PACK_SENTINEL ("default pack only") is a reserved
    // value that can never appear in card_pack_names, so the ordinary
    // membership check must be skipped for it — otherwise no streamer could
    // ever select it. Existence of at least one active unclassified card is
    // still required (checkCollectionHasActiveCards below).
    it('accepts DEFAULT_PACK_SENTINEL without requiring it in card_pack_names, given active unclassified cards', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        // card_pack_names intentionally does NOT (and never can) contain the sentinel.
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons'] },
        error: null,
      })
      const cardsQuery = createMockQueryBuilder()
      ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ count: 2, error: null })
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
          channelPointCollectionName: DEFAULT_PACK_SENTINEL,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      // existence check must use the sentinel-aware .is('collection_name', null) path
      expect(cardsQuery.is).toHaveBeenCalledWith('collection_name', null)
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_collection_name: DEFAULT_PACK_SENTINEL })
      )
    })

    it('rejects DEFAULT_PACK_SENTINEL when there are zero active unclassified cards (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] },
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
          channelPointCollectionName: DEFAULT_PACK_SENTINEL,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    // Self-review regression guard (carried over from #269): the
    // ownership-check SELECT reads channel_point_collection_name AND
    // card_pack_names. Either column being undeployed must not 403/break
    // unrelated settings saves.
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

    it('still saves other settings when card_pack_names is not deployed yet (deploy window)', async () => {
      const selectQuery = createMockQueryBuilder()
      ;(selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { code: '42703', message: 'column streamers.card_pack_names does not exist' },
      })
      const retrySelectQuery = createMockQueryBuilder()
      ;(retrySelectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', channel_point_collection_name: null },
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

  // Issue #269再設計: プレミアムゲートは「パック名一覧への新規追加」に移設。
  describe('cardPackNames management + premium gate (Issue #269再設計)', () => {
    it('rejects non-array cardPackNames (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: 'weapons' }),
      }))

      expect(response.status).toBe(400)
    })

    it('persists new pack names on a premium plan and returns the persisted list', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons', 'characters'] }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.cardPackNames).toEqual(['weapons', 'characters'])
      expect(data.cardPackNamesPremiumRequired).toBeUndefined()
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ card_pack_names: ['weapons', 'characters'] })
      )
    })

    it('drops NEW pack additions on the basic plan but keeps existing entries and removals (200, flag set)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons'] },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      // Request: keep "weapons" (existing), add "armor" (new, should be gated).
      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons', 'armor'] }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.cardPackNames).toEqual(['weapons'])
      expect(data.cardPackNamesPremiumRequired).toBe(true)
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ card_pack_names: ['weapons'] })
      )
    })

    it('allows removing pack names on the basic plan (never gated)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons', 'characters'] },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons'] }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.cardPackNames).toEqual(['weapons'])
      expect(data.cardPackNamesPremiumRequired).toBeUndefined()
      // Removal-only changes never consult getUserPlan.
      expect(mockGetUserPlan).not.toHaveBeenCalled()
    })

    it('does not call getUserPlan when cardPackNames is unchanged (no-op)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons'] },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons'] }),
      }))

      expect(response.status).toBe(200)
      expect(mockGetUserPlan).not.toHaveBeenCalled()
    })

    // 自己レビューで発見した重大バグの回帰テスト: SELECT側は card_pack_names
    // を正常に読めても、その後のUPDATEで同列が見つからずフォールバックする
    // 稀なケース(スキーマキャッシュの伝播遅延等)で、実際には保存されて
    // いないのに「この内容で保存できた」と偽ってはならない。
    it('reports the pre-write list (not the requested one) and a deploy-window flag when the UPDATE itself drops card_pack_names', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons'] },
        error: null,
      })
      // First update attempt fails because card_pack_names isn't actually
      // writable yet (e.g. PostgREST schema-cache lag), even though the
      // SELECT above succeeded moments earlier.
      ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({
          error: { code: 'PGRST204', message: "Could not find the 'card_pack_names' column" },
        }),
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons', 'armor'] }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      // Must report the list as it actually is in the DB (unchanged), not
      // the requested ['weapons', 'armor'] which never got persisted.
      expect(data.cardPackNames).toEqual(['weapons'])
      expect(data.cardPackNamesSkippedDeployWindow).toBe(true)
    })
  })

  // codexチームレビュー指摘の回帰テスト: 同一リクエストで cardPackNames の
  // 追加とその新パックへの channelPointCollectionName 紐付けを同時に送った
  // 場合、後者のmembership検証は「ゲート適用後の persistedCardPackNames」に
  // 対して行われる(リクエスト受信時点の古い一覧に対してではない)。
  describe('same-request ordering: cardPackNames gate → channelPointCollectionName membership', () => {
    it('accepts binding to a pack added in the SAME request on a premium plan', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] },
        error: null,
      })
      const cardsQuery = createMockQueryBuilder()
      ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
        resolve({ count: 1, error: null })
        return cardsQuery
      }

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          cardPackNames: ['weapons'],
          channelPointCollectionName: 'weapons',
        }),
      }))

      expect(response.status).toBe(200)
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ card_pack_names: ['weapons'], channel_point_collection_name: 'weapons' })
      )
    })

    it('rejects binding to a pack whose addition was gated out on the basic plan in the SAME request', async () => {
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: [] },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          cardPackNames: ['weapons'],
          channelPointCollectionName: 'weapons',
        }),
      }))

      // "weapons" was dropped from persistedCardPackNames by the gate, so
      // binding the main reward to it must fail membership validation.
      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })
  })

  // Issue #554: display-name override for the "default" (unclassified) pack.
  // No plan gate, no catalog membership check — a pure standalone string field.
  describe('defaultCardPackName (Issue #554)', () => {
    it('rejects a reserved (`__`-prefixed) value', async () => {
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: '__default__' }),
      }))

      expect(response.status).toBe(400)
    })

    it('rejects a value over the max length', async () => {
      const mockSupabase = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: 'a'.repeat(81) }),
      }))

      expect(response.status).toBe(400)
    })

    it('saves a trimmed, valid display name', async () => {
      const builder = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockSupabase = builder.build()
      const query = builder.getQueryBuilder()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: '  My Pack  ' }),
      }))

      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(
        expect.objectContaining({ default_card_pack_name: 'My Pack' })
      )
    })

    it('resets to the generic label when defaultCardPackName is explicitly null', async () => {
      const builder = createSupabaseMock()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockSupabase = builder.build()
      const query = builder.getQueryBuilder()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: null }),
      }))

      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(
        expect.objectContaining({ default_card_pack_name: null })
      )
    })

    // 自己レビュー観点(card_pack_names と同型): デプロイ窓でUPDATE自体が
    // default_card_pack_name 列を見つけられなかった場合、実際には保存されて
    // いないことをフラグで示す(黙って「保存できた」と偽らない)。
    it('reports a deploy-window flag when the UPDATE drops default_card_pack_name', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123' },
        error: null,
      })
      ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({
          error: { code: 'PGRST204', message: "Could not find the 'default_card_pack_name' column" },
        }),
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: 'My Pack' }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.defaultCardPackNameSkippedDeployWindow).toBe(true)
    })
  })

  // Issue #578 (#576 Phase 1): per-pack rarity weight foundation. This phase
  // only stores rarityWeightsScope / packRarityWeights — it never recalculates
  // drop_rate (effective per-pack weights are computed at draw time in #576
  // Phase 2), and packRarityWeights keys must be members of the effective
  // pack catalog (cardPackNames in the same request, else the streamer's
  // current card_pack_names).
  describe('pack rarity weights (Issue #578)', () => {
    it('saves a valid rarityWeightsScope + packRarityWeights (named pack + __default__)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          rarityWeightsScope: 'per_pack',
          packRarityWeights: {
            weapons: { common: 70, rare: 30 },
            [DEFAULT_PACK_SENTINEL]: { common: 50, rare: 50 },
          },
        }),
      }))

      expect(response.status).toBe(200)
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          rarity_weights_scope: 'per_pack',
          pack_rarity_weights: {
            weapons: { common: 70, rare: 30 },
            [DEFAULT_PACK_SENTINEL]: { common: 50, rare: 50 },
          },
        })
      )
    })

    it('rejects an invalid rarityWeightsScope value (400)', async () => {
      const mockSupabase = createSupabaseMock().build()
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', rarityWeightsScope: 'bogus' }),
      }))

      expect(response.status).toBe(400)
    })

    it('rejects a packRarityWeights key that is not in the effective pack catalog (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          // 'armor' is not registered in card_pack_names.
          packRarityWeights: { armor: { common: 100 } },
        }),
      }))

      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    it('rejects a packRarityWeights entry whose distribution does not sum to 100% (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          packRarityWeights: { weapons: { common: 50, rare: 30 } },
        }),
      }))

      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    it('rejects a packRarityWeights entry that is an empty object (400) — omit the key to inherit global instead', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          packRarityWeights: { weapons: {} },
        }),
      }))

      expect(response.status).toBe(400)
      expect(streamerQuery.update).not.toHaveBeenCalled()
    })

    it('prunes stale pack_rarity_weights entries when cardPackNames is saved (keeps __default__), even though packRarityWeights itself was not sent', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons', 'armor'],
          pack_rarity_weights: {
            weapons: { common: 70, rare: 30 },
            armor: { common: 60, rare: 40 },
            [DEFAULT_PACK_SENTINEL]: { common: 50, rare: 50 },
          },
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      // Removing 'armor' from the catalog — packRarityWeights is NOT part of this request.
      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', cardPackNames: ['weapons'] }),
      }))

      expect(response.status).toBe(200)
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          card_pack_names: ['weapons'],
          pack_rarity_weights: {
            weapons: { common: 70, rare: 30 },
            [DEFAULT_PACK_SENTINEL]: { common: 50, rare: 50 },
          },
        })
      )
    })

    it('prunes weights for a plan-gated new pack and echoes the persisted packRarityWeights back', async () => {
      // basic プランで cardPackNames に新パック追加 + そのパック向け配分を同時送信
      // したケース。検証はゲート適用前の要求カタログに対して通るため 400 には
      // ならず、プレミアムゲートが追加を却下 → prune で配分エントリが落ちる。
      // クライアントが state を再同期できるよう、確定後の永続値がレスポンスに
      // エコーバックされることを担保する(cardPackNames と同じ規約)。
      mockGetUserPlan.mockResolvedValue('basic')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          cardPackNames: ['weapons', 'armor'],
          packRarityWeights: {
            weapons: { common: 70, rare: 30 },
            armor: { common: 100 },
          },
        }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.cardPackNamesPremiumRequired).toBe(true)
      // armor はゲート却下された追加パックなので配分も prune され、
      // 永続値(weapons のみ)がそのままエコーバックされる。
      expect(data.packRarityWeights).toEqual({ weapons: { common: 70, rare: 30 } })
      expect(streamerQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          card_pack_names: ['weapons'],
          pack_rarity_weights: { weapons: { common: 70, rare: 30 } },
        })
      )
    })

    it('does not trigger drop-rate recalculation when saving rarityWeightsScope/packRarityWeights', async () => {
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'streamer123',
          twitch_user_id: 'streamer123',
          channel_point_collection_name: null,
          card_pack_names: ['weapons'],
          pack_rarity_weights: null,
        },
        error: null,
      })

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue({
        from: vi.fn(() => streamerQuery),
      } as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          rarityWeightsScope: 'per_pack',
          packRarityWeights: { weapons: { common: 100 } },
        }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.recalculatedCards).toBeNull()
    })

    describe('deploy-window: new columns not yet migrated', () => {
      it('skips rarity_weights_scope and reports the flag when the UPDATE fails on that column', async () => {
        const streamerQuery = createMockQueryBuilder()
        ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
          data: { id: 'streamer123', twitch_user_id: 'streamer123' },
          error: null,
        })
        ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          eq: vi.fn().mockResolvedValue({
            error: { code: 'PGRST204', message: "Could not find the 'rarity_weights_scope' column" },
          }),
        })

        const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
        vi.mocked(getSupabaseAdmin).mockReturnValue({
          from: vi.fn(() => streamerQuery),
        } as unknown as ReturnType<typeof getSupabaseAdmin>)

        const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ streamerId: 'streamer123', rarityWeightsScope: 'per_pack' }),
        }))

        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.rarityWeightsScopeSkippedDeployWindow).toBe(true)
      })

      it('skips pack_rarity_weights and reports the flag when the UPDATE fails on that column', async () => {
        const streamerQuery = createMockQueryBuilder()
        ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
          data: {
            id: 'streamer123',
            twitch_user_id: 'streamer123',
            channel_point_collection_name: null,
            card_pack_names: ['weapons'],
            pack_rarity_weights: null,
          },
          error: null,
        })
        ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          eq: vi.fn().mockResolvedValue({
            error: { code: 'PGRST204', message: "Could not find the 'pack_rarity_weights' column" },
          }),
        })

        const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
        vi.mocked(getSupabaseAdmin).mockReturnValue({
          from: vi.fn(() => streamerQuery),
        } as unknown as ReturnType<typeof getSupabaseAdmin>)

        const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            streamerId: 'streamer123',
            packRarityWeights: { weapons: { common: 100 } },
          }),
        }))

        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.packRarityWeightsSkippedDeployWindow).toBe(true)
      })
    })
  })
})
