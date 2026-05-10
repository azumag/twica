import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { createSupabaseMock } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/constants')
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

  // Issue #230: 配信者が視聴者向けコレクション名を設定できる
  describe('collection name settings (Issue #230)', () => {
    it('should persist a trimmed collection name', async () => {
      const builder = createSupabaseMock()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
      const mockSupabase = builder.build()
      const queryBuilder = builder.getQueryBuilder()

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          collectionName: '  Weekly Cards  ',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(queryBuilder.update).toHaveBeenCalledWith({
        collection_name: 'Weekly Cards',
      })
    })

    it('should reset blank collection names to null', async () => {
      const builder = createSupabaseMock()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
      const mockSupabase = builder.build()
      const queryBuilder = builder.getQueryBuilder()

      const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
      vi.mocked(getSupabaseAdmin).mockReturnValue(
        mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>
      )

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          collectionName: '   ',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(queryBuilder.update).toHaveBeenCalledWith({
        collection_name: null,
      })
    })

    it('should reject collection names over 80 characters', async () => {
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
          collectionName: 'x'.repeat(81),
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
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
})
