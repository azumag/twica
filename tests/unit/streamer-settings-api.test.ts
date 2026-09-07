import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/streamer/settings/route'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getUserPlan } from '@/lib/plan'
import { getDb } from '@/lib/db/client'
import {
  cards as cardsTable,
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from '@/lib/db/schema'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { legacySoundToRules } from '@/lib/gacha-sound-rules'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
// Issue #269: most pre-existing tests below assume an authorized (non-basic)
// streamer, since they predate plan gating. Default to a premium plan here so
// they keep exercising collection-name persistence rather than the gate;
// gate-specific tests override this per-case. This also covers Issue #176's
// gachaSoundRules premium gate (support plan by default; basic-plan tests
// override the mock to exercise the 403 path).
vi.mock('@/lib/plan')
// 本物の constants モジュールを保持する。RARITIES が空配列になると
// route.ts の DEFAULT_RARITY_VALUES が空となり、デフォルトレアリティとの
// 衝突検出ができなくなるため、ファクトリで実体をそのまま返す。
vi.mock('@/lib/constants', async (importOriginal) => await importOriginal())
const mockGetSession = vi.mocked(getSession)
const mockCheckRateLimit = vi.mocked(checkRateLimit)
const mockValidateCSRFToken = vi.mocked(validateCSRFToken)
const mockValidateContentType = vi.mocked(validateContentType)
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures)
const mockGetUserPlan = vi.mocked(getUserPlan)
let currentDbFixture: any

function createMockQueryBuilder() {
  const query: any = {}
  for (const method of [
    'select', 'insert', 'upsert', 'update', 'delete',
    'eq', 'neq', 'gt', 'or', 'gte', 'lt', 'lte',
    'like', 'ilike', 'in', 'is', 'not',
    'order', 'limit', 'range',
  ]) {
    query[method] = vi.fn().mockReturnValue(query)
  }
  query.single = vi.fn().mockResolvedValue({ data: null, error: null })
  query.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  query.count = vi.fn().mockResolvedValue({ count: null, error: null })
  return query
}

/**
 * 設定値テスト用の最小fixture builder。DB固有のクライアントを模倣するのではなく、
 * installDrizzleFixtureAdapter が消費する行データとエラーだけを組み立てる。
 */
function createDbFixture() {
  const query = createMockQueryBuilder()
  return {
    withMaybeSingleResponse(data: unknown, error: unknown = null) {
      query.maybeSingle.mockResolvedValue({ data, error })
      return this
    },
    build() {
      return { from: vi.fn(() => query) }
    },
    getQueryBuilder() {
      return query
    },
  }
}

function installDbFixture(fixture: any) {
  currentDbFixture = fixture
}

function tableName(table: unknown): string {
  if (table === streamersTable) return 'streamers'
  if (table === cardsTable) return 'cards'
  if (table === streamerChatSenderSettingsTable) return 'streamer_chat_sender_settings'
  if (table === twitchBotAccountsTable) return 'twitch_bot_accounts'
  throw new Error('Unexpected Drizzle table in streamer settings test adapter')
}

/**
 * 既存76ケースが持つ詳細な行fixtureを、現行 Drizzle のクエリ形状へ
 * 接続するテスト専用アダプタ。fixture のデータ/エラーキューはそのまま利用しつつ、
 * DB層では「エラーを返す」のではなく throw する本番 Drizzle の契約へ正規化する。
 *
 * このファイルの目的は設定値の検証・正規化・フォールバック網羅であり、SQL条件の
 * 厳密な検証は streamer-settings-driver-parity.test.ts が担当する。
 */
function installDrizzleFixtureAdapter() {
  vi.mocked(getDb).mockImplementation(async () => {
    if (!currentDbFixture) {
      throw new Error('No DB fixture installed for this test')
    }
    const client = currentDbFixture

    const db = {
      select: vi.fn((fields: Record<string, unknown>) => {
        let table: unknown
        const resolve = async () => {
          const name = tableName(table)
          const query = client.from(name)
          query.select(Object.keys(fields).join(','))
          if (name === 'streamers') {
            query.eq('id', 'streamer123').eq('twitch_user_id', 'streamer123')
            const result = await query.maybeSingle()
            if (result.error) throw result.error
            return result.data ? [result.data] : []
          }

          // collection existence checks are the only cards SELECTs in this
          // suite. Calling both filters keeps the old fixture spies observable;
          // preconfigured fixtures determine the result independently.
          query
            .eq('streamer_id', 'streamer123')
            .eq('is_active', true)
            .is('collection_name', null)
          const result = await query
          if (result.error) throw result.error
          if (typeof result.count === 'number') return [{ count: result.count }]
          return Array.isArray(result.data) ? result.data : []
        }
        const builder: any = {
          from: vi.fn((value: unknown) => {
            table = value
            return builder
          }),
          where: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            resolve().then(onFulfilled, onRejected),
        }
        return builder
      }),
      update: vi.fn((table: unknown) => {
        let values: Record<string, unknown> = {}
        const resolve = async () => {
          const query = client.from(tableName(table))
          const result = await query.update(values).eq('id', 'streamer123')
          if (result?.error) throw result.error
          return []
        }
        const builder: any = {
          set: vi.fn((next: Record<string, unknown>) => {
            values = { ...next }
            return builder
          }),
          where: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            resolve().then(onFulfilled, onRejected),
        }
        return builder
      }),
      insert: vi.fn((table: unknown) => {
        let values: unknown
        const resolve = async () => {
          const query = client.from(tableName(table))
          const result = await query.upsert(values)
          if (result?.error) throw result.error
          return []
        }
        const builder: any = {
          values: vi.fn((next: unknown) => {
            values = next
            return builder
          }),
          onConflictDoUpdate: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            resolve().then(onFulfilled, onRejected),
        }
        return builder
      }),
      delete: vi.fn((table: unknown) => {
        const resolve = async () => {
          const query = client.from(tableName(table))
          const result = await query.delete().eq('streamer_id', 'streamer123')
          if (result?.error) throw result.error
          return []
        }
        const builder: any = {
          where: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) =>
            resolve().then(onFulfilled, onRejected),
        }
        return builder
      }),
    }
    return { db, sql: vi.fn() } as any
  })
}

describe('POST /api/streamer/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentDbFixture = undefined

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
    // デフォルトは support プラン（gachaSoundRules を使用可能）
    mockGetUserPlan.mockResolvedValue('support')
    installDrizzleFixtureAdapter()
  })

  it('should update streamer settings with valid data', async () => {
    const mockDbFixture = createDbFixture()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
      .build()

    installDbFixture(mockDbFixture)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: '11111111-1111-1111-1111-111111111111',
        channelPointRewardName: 'Test Reward',
      }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.success).toBe(true)
    expect(data.recalculatedCards).toBeNull()
    expect(getDb).toHaveBeenCalled()
  })

  it('should update multi-draw chat announcement settings', async () => {
    const builder = createDbFixture()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
    const mockDbFixture = builder.build()
    const query = builder.getQueryBuilder()

    installDbFixture(mockDbFixture)

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
    const mockDbFixture = createDbFixture().build()

    installDbFixture(mockDbFixture)

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

  it('rejects non-UUID channelPointRewardId (issue #836)', async () => {
    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: 'reward-123',
      }),
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('accepts an empty channelPointRewardName alongside a valid reward id (issue #836 regression)', async () => {
    // ChannelPointSettings.tsx の handleSave は保存のたびに channelPointRewardName を
    // 送信する（useState(currentRewardName || "") で初期化）。reward_name が未設定な
    // 既存データを持つ配信者がこの保存操作で 400 にならないことを固定する。
    const mockDbFixture = createDbFixture()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
      .build()

    installDbFixture(mockDbFixture)

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: '11111111-1111-1111-1111-111111111111',
        channelPointRewardName: '',
      }),
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
  })

  it('rejects non-boolean gachaSoundEnabled (issue #836)', async () => {
    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        gachaSoundEnabled: 'yes',
      }),
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('rejects oversized chatAnnouncementTemplate (issue #836)', async () => {
    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        chatAnnouncementTemplate: 'a'.repeat(501),
      }),
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('should allow empty rarity weights object for manual mode switch', async () => {
    const mockDbFixture = createDbFixture()
      .withMaybeSingleResponse({
        id: 'streamer123',
        twitch_user_id: 'streamer123',
      })
      .build()

    installDbFixture(mockDbFixture)

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
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const built = mockDbFixture.build()
      installDbFixture(built)
      return mockDbFixture.getQueryBuilder()
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
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const built = mockDbFixture.build()
      installDbFixture(built)
      return mockDbFixture.getQueryBuilder()
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
    const mockDbFixture = createDbFixture().build()
    installDbFixture(mockDbFixture)

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
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      installDbFixture(mockDbFixture)

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
      const mockDbFixture = createDbFixture().build()
      installDbFixture(mockDbFixture)

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
      const mockDbFixture = createDbFixture().build()
      installDbFixture(mockDbFixture)

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
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      installDbFixture(mockDbFixture)

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

  // Issue #738/#740: 配信中一覧への掲載・ランキング上のチャネル表示オプトイン
  describe('live directory settings (Issue #738)', () => {
    it('should accept publishLiveStatus/publishStats when both are booleans', async () => {
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          publishLiveStatus: true,
          publishStats: false,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.success).toBe(true)
    })

    it('should reject publishLiveStatus when not a boolean', async () => {
      const mockDbFixture = createDbFixture().build()
      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          publishLiveStatus: 'true',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
    })

    it('should reject publishStats when not a boolean', async () => {
      const mockDbFixture = createDbFixture().build()
      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          publishStats: 1,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(400)
    })

    it('should accept independent publishStats toggle without publishLiveStatus', async () => {
      // 設定UIはトグル単位で部分送信するため、片方だけが届くケースが正常系
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({
          id: 'streamer123',
          twitch_user_id: 'streamer123',
        })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          publishStats: true,
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
    })
  })

  describe('gachaSoundRules premium gate (Issue #946)', () => {
    // Issue #946: 以前は gachaSoundRules が送られた時点でbasicプランを一律403拒否
    // しており、「単一のall対象ルール1件」すら設定できない意図しない制限になって
    // いた。cardPackNames(#269再設計)と同じ「超過分だけ静かに落とし200で返す」
    // パターンへ変更した。以下は新しいゲート挙動の回帰テスト。
    //
    // 【自動レビュー指摘（必須・修正済み）】最初の実装は「今回送信された配列全体」に
    // basicゲートを適用しており、プレミアム時代に保存された複数ルールを持つ
    // ユーザーが、無関係なルールを1件トグルするだけの操作で他の既存ルールを
    // まとめて失うデータ喪失バグがあった。以下の "preserves"/"drops a genuinely
    // new rule" の2ケースがこの修正の直接の回帰テスト（更新前のDB状態を
    // gacha_sound_rules 付きでfixtureに含める）。
    it('basic plan users can save a single all-target sound rule (200, persisted as-is)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [{ id: 'rule1', url: 'https://example.com/s.mp3', enabled: true, label: 'a', targetType: 'all', rarity: null, rewardId: null, rewardName: null }],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'rule1' })
      expect(data.gachaSoundRulesPremiumRequired).toBeUndefined()
    })

    it('basic plan users submitting a 2nd rule get only the first all-target rule persisted, with gachaSoundRulesPremiumRequired flagged', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'first', url: 'https://example.com/a.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
            { id: 'second', url: 'https://example.com/b.mp3', enabled: true, label: 'B', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'first' })
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('basic plan users submitting a rarity-targeted rule get it dropped entirely (not silently downgraded to all), with gachaSoundRulesPremiumRequired flagged', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'legendary-only', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toHaveLength(0)
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('basic plan users can still clear all rules (empty array never gated)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', gachaSoundRules: [] }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toHaveLength(0)
      expect(data.gachaSoundRulesPremiumRequired).toBeUndefined()
    })

    it('getUserPlan resolving to basic (its own internal fail-safe) still applies basic-tier gating rather than full premium pass-through', async () => {
      // plan.ts 自身の「例外時はbasicへフォールバック」自体はplan-twitch-sub.test.tsで
      // 別途検証済み。ここでは「basicとして扱われた場合に、本当にプレミアム機能
      // （複数ルール・ターゲット指定）が通ってしまわないか」というこのルート側の
      // ゲート実装の健全性を検証する(フェイルセーフの意味を保つ回帰テスト)。
      mockGetUserPlan.mockResolvedValue('basic')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'a', url: 'https://example.com/a.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
            { id: 'b', url: 'https://example.com/b.mp3', enabled: true, label: 'B', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // premiumでないため、2件目(rarity指定)は保存されない
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'a', targetType: 'all' })
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('preserves pre-existing premium-era rules untouched when a basic-plan user makes an unrelated edit (regression test for the data-loss bug found in review)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      // 更新前のDBには、premium時代に保存された「rarity指定1件 + all対象1件」の
      // 2ルールが既に存在する。
      const existingRules = [
        { id: 'legendary-rule', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
        { id: 'catch-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
      ]

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123', gacha_sound_rules: existingRules })
        .build()

      installDbFixture(mockDbFixture)

      // ユーザーは "legendary-rule" を無効化しただけ(無関係な単純トグル)で、
      // クライアントの仕様どおり配列全体(既存2件)をそのまま再送信する。
      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { ...existingRules[0], enabled: false },
            existingRules[1],
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // 両方のルールが残っており、legendary-ruleのenabledだけが変わっている
      // (basicプランだからといって、既存のrarity指定ルールが消えてはいけない)
      expect(data.gachaSoundRules).toHaveLength(2)
      expect(data.gachaSoundRules.find((r: { id: string }) => r.id === 'legendary-rule')).toMatchObject({
        enabled: false,
        targetType: 'rarity',
      })
      expect(data.gachaSoundRules.find((r: { id: string }) => r.id === 'catch-all')).toMatchObject({
        enabled: true,
        targetType: 'all',
      })
      expect(data.gachaSoundRulesPremiumRequired).toBeUndefined()
    })

    it('drops a genuinely new rule for basic-plan users while still preserving pre-existing (non-all-target) rules untouched', async () => {
      // 【自動レビュー指摘（任意）】既存ルールも新規ルールもtargetType"all"だと、
      // getCurrentGachaSoundRulesが壊れて常に[]を返す場合でも結果的に同じ
      // ("先頭のallルールが残るだけ")になり、DB読み取りパスが実際に使われて
      // いることを判別できない弱いテストだった。既存ルールをrarity指定にする
      // ことで、DB読み取りが機能しているかどうかで結果が明確に分岐するようにした
      // （壊れていれば既存ルールごと失われ新規ルールだけが残ってしまう）。
      mockGetUserPlan.mockResolvedValue('basic')

      const existingRules = [
        { id: 'legendary-rule', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
      ]

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123', gacha_sound_rules: existingRules })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { ...existingRules[0], enabled: false },
            { id: 'new-all', url: 'https://example.com/new.mp3', enabled: true, label: 'N', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // 既存のrarity指定ルールは(all対象ではないため上限に影響せず)そのまま温存され、
      // かつ既存にall対象ルールが無いため新規のall対象ルールも追加で許可される。
      // DB読み取りが壊れていれば、legendary-ruleが消え new-all だけが残るはず。
      expect(data.gachaSoundRules).toHaveLength(2)
      expect(data.gachaSoundRules.find((r: { id: string }) => r.id === 'legendary-rule')).toMatchObject({
        enabled: false,
        targetType: 'rarity',
      })
      expect(data.gachaSoundRules.find((r: { id: string }) => r.id === 'new-all')).toMatchObject({
        targetType: 'all',
      })
      expect(data.gachaSoundRulesPremiumRequired).toBeUndefined()
    })

    it('reverts an existing rule id whose plan-gated fields were changed back to the DB value, rather than silently bypassing the plan gate (Issue #946 security fix)', async () => {
      // 【自動レビュー指摘（必須・修正済み）】idが一致するだけで温存すると、basic
      // プランのユーザーが既存の"all"ルールのidを再利用しつつtargetTypeを
      // rarity/rewardへ書き換えて送信するだけでプラン制限を完全にバイパスできて
      // しまう脆弱性があった。この回帰テストは、既存"all"ルールのidを再利用して
      // targetTypeをrarityへ書き換えつつ、同一リクエストで新規のall対象ルールも
      // 追加しようとするケースを固定する。
      mockGetUserPlan.mockResolvedValue('basic')

      const existingRules = [
        { id: 'was-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
      ]

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123', gacha_sound_rules: existingRules })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            // 既存のidを再利用しつつtargetTypeをrarityへ書き換える(プラン制限バイパス試行)
            { id: 'was-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
            // 同時に新規のall対象ルールも追加しようとする
            { id: 'new-all', url: 'https://example.com/new.mp3', enabled: true, label: 'N', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // "was-all"のtargetType変更はDB上の元の値("all")へ差し戻され、ルール自体は
      // 消えない(単純な編集で既存ルールが失われるIssue #946のデータ喪失バグの
      // 再発防止)。差し戻し後は既にall対象ルールが1件あるとみなされるため、
      // 新規の"new-all"は追加されない(rarity指定が生き残る・2件とも保存される、
      // はいずれもプラン制限のバイパスになるためNG)。
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'was-all', targetType: 'all', rarity: null })
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('rejects duplicate submission of the same existing rule id, rather than persisting it twice (Issue #946 security fix)', async () => {
      // 【自動レビュー指摘（必須・修正済み）】idごとの重複除去が無かったため、
      // 同じidを持つ(かつgated fieldsが既存と一致する)ルールを配列内に複数回
      // 含めて送信すると、両方ともpreservedExistingへ積み上がり、
      // 「合計高々1件のall対象ルール」という不変条件を、正当な既存ルールの
      // 複製によって突破できてしまっていた。
      mockGetUserPlan.mockResolvedValue('basic')

      const existingRules = [
        { id: 'catch-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
      ]

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123', gacha_sound_rules: existingRules })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          // 同じidのルールを2回含める(gated fieldsは既存と一致)
          gachaSoundRules: [existingRules[0], existingRules[0]],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // 複製されず、1件だけが保存される
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'catch-all' })
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('rejects duplicate submission of an existing non-all rule combined with a new all-target rule, rather than persisting 3 rules total (Issue #946 security fix)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const existingRules = [
        { id: 'legendary-rule', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
      ]

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123', gacha_sound_rules: existingRules })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            // 既存のrarity指定ルールを2回重複させる
            existingRules[0],
            existingRules[0],
            // 新規のall対象ルールも追加する
            { id: 'new-all', url: 'https://example.com/new.mp3', enabled: true, label: 'N', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      // 重複が1件に正規化された上で、新規のall対象ルールも1件だけ追加される(合計2件)
      expect(data.gachaSoundRules).toHaveLength(2)
      expect(data.gachaSoundRules.filter((r: { id: string }) => r.id === 'legendary-rule')).toHaveLength(1)
      expect(data.gachaSoundRules.find((r: { id: string }) => r.id === 'new-all')).toMatchObject({ targetType: 'all' })
      expect(data.gachaSoundRulesPremiumRequired).toBe(true)
    })

    it('treats a missing gacha_sound_rules column as an empty current state during the deploy window (Issue #991)', async () => {
      mockGetUserPlan.mockResolvedValue('basic')

      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()
      query.maybeSingle.mockResolvedValueOnce({
        data: { id: 'streamer123', twitch_user_id: 'streamer123' },
        error: null,
      })
      query.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: {
          code: '42703',
          message: 'column \"gacha_sound_rules\" of relation \"streamers\" does not exist',
        },
      })

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'rule1', url: 'https://example.com/s.mp3', enabled: true, label: 'a', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toEqual([expect.objectContaining({ id: 'rule1', targetType: 'all' })])
      expect(data.gachaSoundRulesPremiumRequired).toBeUndefined()
      expect(query.maybeSingle).toHaveBeenCalledTimes(2)
    })

    it('fails the whole request rather than silently treating existing rules as new when reading current state fails for a non-missing-column reason (Issue #946 security fix)', async () => {
      // 【自動レビュー指摘（必須・修正済み）】getCurrentGachaSoundRulesが、列欠落
      // 以外のエラー(接続断・タイムアウト等)でも一律[]にフォールバックしていた。
      // これだとUPDATE自体は実行されてしまうため、basicプランの既存ルールが
      // 全て「新規」とみなされ、"all"1件を除いて誤って削除されうる
      // (Issue #946が解決しようとしたデータ喪失の再発)。「何が既存か判定できない」
      // 場合はリクエスト全体を失敗させ、変更なしで再試行できる方が安全。
      mockGetUserPlan.mockResolvedValue('basic')

      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()
      // 1回目(getStreamerForSettingsUpdate)は成功、2回目(getCurrentGachaSoundRules)
      // だけ列欠落ではないエラーを返す。withDbRetryのリトライ対象コード
      // （08006等）だとリトライで消費されモックのキューが尽きて既定値
      // (エラー無し)にフォールバックしてしまうため、意図的にリトライ対象外の
      // 恒久的エラーコードを使う。
      query.maybeSingle.mockResolvedValueOnce({
        data: { id: 'streamer123', twitch_user_id: 'streamer123' },
        error: null,
      })
      query.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: { code: '42P01', message: 'undefined table' },
      })

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [{ id: 'rule1', url: 'https://example.com/s.mp3', enabled: true, label: 'a', targetType: 'all', rarity: null, rewardId: null, rewardName: null }],
        }),
      })

      const response = await POST(request)
      // 200で静かにデータを失うのではなく、エラーとして扱われるべき
      expect(response.status).not.toBe(200)
    })

    it('should allow support plan users to set gachaSoundRules', async () => {
      mockGetUserPlan.mockResolvedValue('support')

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
    })

    it.each(['patron', 'twitch_sub'] as const)('%s plan users can set gachaSoundRules', async (plan) => {
      mockGetUserPlan.mockResolvedValue(plan)

      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', gachaSoundRules: [] }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
    })

  })

  describe('gachaSoundRules legacy mirror + save echo (Issue #451 followup F1/F5)', () => {
    it('F1: mirrors ONLY an enabled all-type rule into gacha_sound_url/gacha_sound_enabled, not any enabled rule', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()

      installDbFixture(mockDbFixture)

      // Only a rarity-scoped rule is configured (no catch-all "all" rule).
      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'legendary-only', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      // Must NOT mirror the rarity-only rule's URL — there is no "always play"
      // sound configured, so the legacy mirror must be cleared, not borrow a
      // rarity-limited sound (that was the bug: legendary-only sound playing
      // for every rarity via the legacy no-match fallback).
      expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
        gacha_sound_url: null,
        gacha_sound_enabled: false,
      }))
    })

    it('F1: mirrors an enabled all-type rule\'s URL even when a rarity rule is also present', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'legendary', url: 'https://example.com/legendary.mp3', enabled: true, label: 'L', targetType: 'rarity', rarity: 'legendary', rewardId: null, rewardName: null },
            { id: 'catch-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
        gacha_sound_url: 'https://example.com/all.mp3',
        gacha_sound_enabled: true,
      }))
    })

    it('F1: does not mirror a DISABLED all-type rule', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'catch-all', url: 'https://example.com/all.mp3', enabled: false, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
        gacha_sound_url: null,
        gacha_sound_enabled: false,
      }))
    })

    it('F5: echoes the server-normalized (persisted) gachaSoundRules on success, not the raw submitted array', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()

      installDbFixture(mockDbFixture)

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'keep', url: 'https://example.com/a.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
            // Dead rule: reward-targeted with an empty rewardId never fires;
            // normalizeGachaSoundRules drops it server-side.
            { id: 'dead-reward', url: 'https://example.com/b.mp3', enabled: true, label: 'B', targetType: 'reward', rarity: null, rewardId: '', rewardName: null },
          ],
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRules).toHaveLength(1)
      expect(data.gachaSoundRules[0]).toMatchObject({ id: 'keep' })
      expect(data.gachaSoundRulesSkippedDeployWindow).toBeUndefined()
    })

    it('F5: reports a deploy-window flag and the actually-persisted legacy-mirror value when the UPDATE drops gacha_sound_rules', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123' },
        error: null,
      })
      // First update attempt fails because gacha_sound_rules migration is not
      // deployed yet.
      ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({
          error: {
            code: '42703',
            message: 'column "gacha_sound_rules" of relation "streamers" does not exist',
          },
        }),
      })

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          gachaSoundRules: [
            { id: 'catch-all', url: 'https://example.com/all.mp3', enabled: true, label: 'A', targetType: 'all', rarity: null, rewardId: null, rewardName: null },
          ],
        }),
      }))

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.gachaSoundRulesSkippedDeployWindow).toBe(true)
      // gacha_sound_rules列自体は書けなかったが、旧来ミラー列
      // (gacha_sound_url/gacha_sound_enabled)は書き込めている(グレースフル
      // デグレード)ため、そこから復元した legacy ルール1件が実態として返る
      // (クライアントに送信したルール一覧そのものではない)。
      expect(data.gachaSoundRules).toEqual(
        legacySoundToRules('https://example.com/all.mp3', true)
      )
    })
  })

  describe('gachaSoundUrl URL validation', () => {
    beforeEach(() => {
      installDbFixture(
        createDbFixture()
          .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
          .build()
      )
    })

    it('should return 400 for non-HTTPS gachaSoundUrl', async () => {
      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', gachaSoundUrl: 'http://example.com/sound.mp3' }),
      })
      const response = await POST(request)
      expect(response.status).toBe(400)
    })

    it('should accept null gachaSoundUrl (delete)', async () => {
      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', gachaSoundUrl: null }),
      })
      const response = await POST(request)
      expect(response.status).toBe(200)
    })

    it('should accept HTTPS gachaSoundUrl', async () => {
      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', gachaSoundUrl: 'https://example.com/sound.mp3' }),
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

    installDbFixture({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
    })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: '11111111-1111-1111-1111-111111111111',
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

    installDbFixture({
      from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
    })

    const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamerId: 'streamer123',
        channelPointRewardId: '11111111-1111-1111-1111-111111111111',
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

    installDbFixture({
      from: vi.fn(() => streamerQuery),
    })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      })

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

      installDbFixture({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      })

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

      installDbFixture({ from: fromMock })

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointRewardId: '11111111-1111-1111-1111-111111111111',
          channelPointRewardName: 'Test Reward',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(updateQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_reward_id: '11111111-1111-1111-1111-111111111111' })
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

      installDbFixture({ from: fromMock })

      const request = new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          streamerId: 'streamer123',
          channelPointRewardId: '11111111-1111-1111-1111-111111111111',
          channelPointRewardName: 'Test Reward',
        }),
      })

      const response = await POST(request)
      expect(response.status).toBe(200)
      expect(updateQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel_point_reward_id: '11111111-1111-1111-1111-111111111111' })
      )
    })
  })

  // Issue #269再設計: プレミアムゲートは「パック名一覧への新規追加」に移設。
  describe('cardPackNames management + premium gate (Issue #269再設計)', () => {
    it('rejects non-array cardPackNames (400)', async () => {
      const streamerQuery = createMockQueryBuilder()
      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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
    // 稀なケース（rolling deploy で migration が遅延）でも、実際には保存されて
    // いないのに「この内容で保存できた」と偽ってはならない。
    it('reports the pre-write list (not the requested one) and a deploy-window flag when the UPDATE itself drops card_pack_names', async () => {
      mockGetUserPlan.mockResolvedValue('support')
      const streamerQuery = createMockQueryBuilder()
      ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'streamer123', twitch_user_id: 'streamer123', channel_point_collection_name: null, card_pack_names: ['weapons'] },
        error: null,
      })
      // First update attempt fails because card_pack_names isn't actually
      // writable yet (migration lag), even though the
      // SELECT above succeeded moments earlier.
      ;(streamerQuery.update as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({
          error: {
            code: '42703',
            message: 'column "card_pack_names" of relation "streamers" does not exist',
          },
        }),
      })

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn((table: string) => (table === 'cards' ? cardsQuery : streamerQuery)),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()
      installDbFixture(mockDbFixture)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: '__default__' }),
      }))

      expect(response.status).toBe(400)
    })

    it('rejects a value over the max length', async () => {
      const mockDbFixture = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
        .build()
      installDbFixture(mockDbFixture)

      const response = await POST(new NextRequest('http://localhost:3000/api/streamer/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamerId: 'streamer123', defaultCardPackName: 'a'.repeat(81) }),
      }))

      expect(response.status).toBe(400)
    })

    it('saves a trimmed, valid display name', async () => {
      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()
      installDbFixture(mockDbFixture)

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
      const builder = createDbFixture()
        .withMaybeSingleResponse({ id: 'streamer123', twitch_user_id: 'streamer123' })
      const mockDbFixture = builder.build()
      const query = builder.getQueryBuilder()
      installDbFixture(mockDbFixture)

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
          error: {
            code: '42703',
            message: 'column "default_card_pack_name" of relation "streamers" does not exist',
          },
        }),
      })

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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
      const mockDbFixture = createDbFixture().build()
      installDbFixture(mockDbFixture)

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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

      installDbFixture({
        from: vi.fn(() => streamerQuery),
      })

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
            error: {
              code: '42703',
              message: 'column "rarity_weights_scope" of relation "streamers" does not exist',
            },
          }),
        })

        installDbFixture({
          from: vi.fn(() => streamerQuery),
        })

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
            error: {
              code: '42703',
              message: 'column "pack_rarity_weights" of relation "streamers" does not exist',
            },
          }),
        })

        installDbFixture({
          from: vi.fn(() => streamerQuery),
        })

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
