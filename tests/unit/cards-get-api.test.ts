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
  // Issue #542: user_cards から取得する発行済みカード行（issued_count集計の元データ）
  // user_cards rows fed into the issued_count aggregation (Issue #542)
  userCards?: Record<string, unknown>[]
  userCardsError?: Error | null
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
  ;(cardsQuery as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve(cardsResponse)
    return cardsQuery
  }

  // Issue #542: 発行済み枚数集計用のuser_cardsクエリビルダー（暗黙のawaitに対応）
  // user_cards query builder for the issued_count aggregation (implicit await)
  const userCardsQuery = createMockQueryBuilder()
  // MockQueryBuilder<unknown> と Record<string, unknown> は型として十分重ならないため
  // 直接キャストは TS2352 になる。`unknown` を経由して安全にキャストする。
  ;(userCardsQuery as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve({ data: options.userCards ?? [], error: options.userCardsError ?? null })
    return userCardsQuery
  }

  const from = vi.fn((table: string) => {
    if (table === 'streamers') return streamerQuery
    if (table === 'cards') {
      return cardsQuery
    }
    if (table === 'user_cards') {
      return userCardsQuery
    }
    return createMockQueryBuilder()
  })

  // モックの `{ from }` は SupabaseClient の一部プロパティしか持たないため、
  // `unknown` を経由してキャストする(既存テストで確立されたパターンに合わせる)。
  mockGetSupabaseAdmin.mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>)

  return { streamerQuery, cardsQuery, userCardsQuery, from }
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
  ;(firstCardsQuery as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve({ data: null, error: options.firstCardsError, count: null })
    return firstCardsQuery
  }

  const retryCardsQuery = createMockQueryBuilder()
  ;(retryCardsQuery as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
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
  } as unknown as ReturnType<typeof getSupabaseAdmin>)

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
    // `issuedAt` は SessionPayload に存在しないフィールド(本番コードでも未参照)のため削除し、
    // 他のテストと同じ形で必須フィールドを揃える。
    mockGetSession.mockResolvedValue({
      twitchUserId: 'user123',
      twitchUsername: 'testuser',
      twitchDisplayName: 'Test User',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      expiresAt: Date.now() + 60_000,
      version: 1,
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

    it('sortField=display_order の場合、card_number の後に作成日昇順で安定ソートする', async () => {
      const { cardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [],
      })

      await GET(createRequest({
        streamerId: 'streamer-1',
        sortField: 'display_order',
        sortDirection: 'asc',
      }))

      expect(cardsQuery.order).toHaveBeenNthCalledWith(1, 'card_number', { ascending: true, nullsFirst: false })
      expect(cardsQuery.order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true, nullsFirst: false })
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

  // Issue #542: CardManagerで発行済み枚数・残余枚数を表示する
  describe('issued_count (Issue #542)', () => {
    it('無制限カードのみの場合、user_cardsへの問い合わせをスキップし issued_count を付与しない', async () => {
      const { from } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [
          { id: 'card-1', drop_rate: 0.5, max_issuance_count: null },
          { id: 'card-2', drop_rate: 0.5, max_issuance_count: undefined },
        ],
      })

      const response = await GET(createRequest({ streamerId: 'streamer-1' }))
      const body = await response.json()

      expect(response.status).toBe(200)
      // 無駄なJOINを避けるため、限定カードが1件も無ければuser_cardsは問い合わせない
      expect(from).toHaveBeenCalledWith('cards')
      expect(from).not.toHaveBeenCalledWith('user_cards')
      expect(body.cards[0].issued_count).toBeUndefined()
      expect(body.cards[1].issued_count).toBeUndefined()
    })

    it('上限付きカードのみ user_cards をcard_idでグルーピングしたCOUNTを issued_count として付与する', async () => {
      const { userCardsQuery } = setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [
          { id: 'card-limited', drop_rate: 0.5, max_issuance_count: 10 },
          { id: 'card-unlimited', drop_rate: 0.5, max_issuance_count: null },
        ],
        // card-limited が3枚発行済み。card-unlimitedは対象外なので行が来ても無視される想定は無い
        // (実際のクエリは limitedCardIds のみで絞り込むため、ここではlimited分のみ用意)
        userCards: [
          { card_id: 'card-limited' },
          { card_id: 'card-limited' },
          { card_id: 'card-limited' },
        ],
      })

      const response = await GET(createRequest({ streamerId: 'streamer-1' }))
      const body = await response.json()

      expect(response.status).toBe(200)
      // 限定カードのIDのみでuser_cardsを絞り込むこと（無制限カードは対象外）
      expect(userCardsQuery.in).toHaveBeenCalledWith('card_id', ['card-limited'])

      const limited = body.cards.find((c: { id: string }) => c.id === 'card-limited')
      const unlimited = body.cards.find((c: { id: string }) => c.id === 'card-unlimited')
      expect(limited.issued_count).toBe(3)
      expect(unlimited.issued_count).toBeUndefined()
    })

    it('発行済み0枚の限定カードは issued_count: 0 になる', async () => {
      setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [{ id: 'card-limited', drop_rate: 0.5, max_issuance_count: 5 }],
        userCards: [],
      })

      const response = await GET(createRequest({ streamerId: 'streamer-1' }))
      const body = await response.json()

      expect(body.cards[0].issued_count).toBe(0)
    })

    it('user_cardsの取得に失敗してもカード一覧自体は200で返す（ベストエフォート、issued_countは付与しない）', async () => {
      setupCardsMock({
        streamer: { id: 'streamer-1' },
        cards: [{ id: 'card-limited', drop_rate: 0.5, max_issuance_count: 5 }],
        userCardsError: new Error('db unavailable'),
      })

      const response = await GET(createRequest({ streamerId: 'streamer-1' }))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.cards[0].issued_count).toBeUndefined()
    })
  })
})
