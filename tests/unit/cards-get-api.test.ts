import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/cards/route'
import { getSession } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { createMockQueryBuilder, createMockResponse } from '../utils/supabase-mock'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/constants')>()
  return { ...actual }
})
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))
// unstable_cache をバイパスし、関数を即時実行させる
// Bypass unstable_cache so the wrapped function runs directly
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}))

const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)

/**
 * Cards GET APIテスト用のSupabaseモックを構築
 * Build Supabase mock for Cards GET API tests
 *
 * GET内部の呼び出し順序:
 * 1. from("streamers").select("id").eq().eq().maybeSingle()  → ストリーマー認証
 * 2. from("cards").select("*", { count: "exact" }).eq()...   → カード取得
 *
 * カードクエリは暗黙の await（.then()）で解決されるため、
 * queryBuilder 自体を thenable にする必要がある
 */
function setupCardsMock(options: {
  streamer?: { id: string } | null
  cards?: Record<string, unknown>[]
  cardsError?: Error | null
}) {
  // ストリーマー確認用クエリビルダー
  const streamerQuery = createMockQueryBuilder()
  ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
    createMockResponse(options.streamer ?? null)
  )

  // カード取得用クエリビルダー（暗黙のawaitに対応）
  const cardsQuery = createMockQueryBuilder()
  const cardsResponse = {
    data: options.cards ?? [],
    error: options.cardsError ?? null,
    count: options.cards?.length ?? 0,
  }
  // PostgREST returns result via implicit await (thenable)
  // PostgRESTは暗黙のawait（thenable）で結果を返す
  ;(cardsQuery as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve(cardsResponse)
    return cardsQuery
  }

  mockGetSupabaseAdmin.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'streamers') return streamerQuery
      if (table === 'cards') {
        return cardsQuery
      }
      return createMockQueryBuilder()
    }),
  } as ReturnType<typeof getSupabaseAdmin>)

  return { streamerQuery, cardsQuery }
}

function setupCardsMockWithRetry(options: {
  streamer?: { id: string } | null
  firstCardsError: Error
  retryCards?: Record<string, unknown>[]
}) {
  const streamerQuery = createMockQueryBuilder()
  ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
    createMockResponse(options.streamer ?? null)
  )

  const firstCardsQuery = createMockQueryBuilder()
  ;(firstCardsQuery as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve({ data: null, error: options.firstCardsError, count: null })
    return firstCardsQuery
  }

  const retryCardsQuery = createMockQueryBuilder()
  ;(retryCardsQuery as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve({
      data: options.retryCards ?? [],
      error: null,
      count: options.retryCards?.length ?? 0,
    })
    return retryCardsQuery
  }

  const from = vi.fn((table: string) => {
    if (table === 'streamers') return streamerQuery
    if (table === 'cards') {
      return from.mock.calls.filter(([calledTable]) => calledTable === 'cards').length === 1
        ? firstCardsQuery
        : retryCardsQuery
    }
    return createMockQueryBuilder()
  })

  mockGetSupabaseAdmin.mockReturnValue({
    from,
  } as ReturnType<typeof getSupabaseAdmin>)

  return { firstCardsQuery, retryCardsQuery }
}

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/cards')
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return new NextRequest(url)
}

describe('GET /api/cards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      broadcasterType: 'affiliate',
      issuedAt: Date.now(),
    })
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Math.floor(Date.now() / 1000) + 60,
    })
  })

  describe('rarity sort field mapping', () => {
    it('sortField=rarity の場合、rarity_order カラムでorder()が呼ばれる', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [
          { id: '1', rarity: 'legendary', drop_rate: 0.05, rarity_order: 1 },
          { id: '2', rarity: 'common', drop_rate: 0.5, rarity_order: 4 },
        ],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'rarity',
        sortDirection: 'asc',
      }))

      // rarity ではなく rarity_order でDBソートされることを検証
      expect(cardsQuery.order).toHaveBeenCalledWith('rarity_order', { ascending: true, nullsFirst: false })
    })

    it('sortField=created_at の場合、created_at カラムでorder()が呼ばれる', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'created_at',
        sortDirection: 'desc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('created_at', { ascending: false, nullsFirst: false })
    })

    it('sortField=drop_rate の場合、drop_rate カラムでorder()が呼ばれる', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'drop_rate',
        sortDirection: 'asc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('drop_rate', { ascending: true, nullsFirst: false })
    })

    it('sortField=card_number の場合、card_number カラムでorder()が呼ばれる', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'card_number',
        sortDirection: 'asc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('card_number', { ascending: true, nullsFirst: false })
    })

    it('card_number が schema cache にない場合は created_at ソートで再試行する', async () => {
      const { firstCardsQuery, retryCardsQuery } = setupCardsMockWithRetry({
        streamer: { id: 'streamer-1' },
        firstCardsError: Object.assign(new Error("Could not find the 'card_number' column of 'cards' in the schema cache"), {
          code: 'PGRST204',
        }),
        retryCards: [{ id: '1', drop_rate: 0.5 }],
      })

      const response = await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'card_number',
        sortDirection: 'asc',
      }))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.cards).toHaveLength(1)
      expect(firstCardsQuery.order).toHaveBeenCalledWith('card_number', { ascending: true, nullsFirst: false })
      expect(retryCardsQuery.order).toHaveBeenCalledWith('created_at', { ascending: true, nullsFirst: false })
    })

    it('不正なsortFieldはcreated_atにフォールバックする', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'invalid_field',
        sortDirection: 'desc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('created_at', { ascending: false, nullsFirst: false })
    })
  })

  describe('pagination', () => {
    it('rarity ソート時もDB側でrange()が呼ばれる', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'rarity',
        limit: '10',
        offset: '20',
      }))

      // DB側でページネーションが適用されることを検証
      expect(cardsQuery.range).toHaveBeenCalledWith(20, 29)
      expect(cardsQuery.order).toHaveBeenCalledWith('rarity_order', { ascending: false, nullsFirst: false })
    })
  })

  describe('sort direction', () => {
    it('asc でレアリティソートした場合 ascending: true', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'rarity',
        sortDirection: 'asc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('rarity_order', { ascending: true, nullsFirst: false })
    })

    it('desc でレアリティソートした場合 ascending: false', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'rarity',
        sortDirection: 'desc',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('rarity_order', { ascending: false, nullsFirst: false })
    })

    it('不正なsortDirectionはdescにフォールバックする', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'rarity',
        sortDirection: 'invalid',
      }))

      expect(cardsQuery.order).toHaveBeenCalledWith('rarity_order', { ascending: false, nullsFirst: false })
    })
  })

  describe('error handling', () => {
    it('streamerId が未指定の場合 400 を返す', async () => {
      const response = await GET(createRequest({}))
      expect(response.status).toBe(400)
    })

    it('ストリーマーが見つからない場合 403 を返す', async () => {
      setupCardsMock({ streamer: null, cards: [] })

      const response = await GET(createRequest({ streamerId: 'nonexistent' }))
      expect(response.status).toBe(403)
    })
  })
})
