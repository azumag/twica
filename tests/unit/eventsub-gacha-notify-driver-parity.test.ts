/**
 * #663: eventsub ガチャフロー内の残余 2 箇所の postgrest / pg 直結ドライバ切替
 * パリティテスト
 *
 * 対象（いずれもガチャ EventSub フロー内のため、全体フラグ isPgReadEnabled では
 * なくガチャ経路専用の getGachaDbDriver() === 'pg' で分岐する。#573 の
 * fetchUserCardCountsRpcPg と同じ緊急ロールバック1レバー原則）:
 *   1. postSoldOutNotify 内の streamers.chat_announcement_enabled 読み取り
 *      （fetchSoldOutChatSettingsPg）
 *   2. sendChatAnnouncement の {all} プレースホルダ用 cards count クエリ
 *      （fetchActiveCardCountPg）
 *
 * 検証事項:
 *   - フラグ未設定時(既定 'postgrest')は getDb が一切呼ばれず既存挙動が不変
 *   - pg 経路では同一 fixture から同一の外部挙動（チャット送信可否・メッセージ・
 *     プレースホルダ値）が得られ、postgrest クライアントへ流れない
 *   - pg 経路のエラーは postgrest 経路のエラーと同じ「warn ログ + 安全側の継続」
 *     に正規化される（postgrest へのフォールスルーもしない）
 *   - GACHA_DB_DRIVER=postgrest による緊急ロールバックで通知経路も一括で旧経路へ
 *     戻る（DB_DRIVER=pg が生きていても pg 直結に残らない）
 *
 * モックの流儀は tests/unit/eventsub-user-card-counts-driver-parity.test.ts
 * （EventSub 署名付き POST + GachaService / chat-service モック + getDb 上書き +
 * vi.stubEnv）を踏襲。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { POST } from '@/app/api/twitch/eventsub/route'
import { CARD_ISSUANCE_MESSAGES } from '@/lib/card-issuance'
import { getSupabaseAdmin, getSupabaseAdminNoCache } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { cards as cardsTable, streamers as streamersTable } from '@/lib/db/schema'
import { logger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  buildMessage: vi.fn(() => 'built message'),
  sendChatMessage: vi.fn().mockResolvedValue(true),
  cancelRedemption: vi.fn(),
}))

vi.mock('@/lib/services/gacha', () => ({
  GachaService: vi.fn().mockImplementation(() => ({
    executeGachaForEventSub: mocks.executeGachaForEventSub,
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAdminNoCache: vi.fn(),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { eventsub: {} },
}))

vi.mock('@/lib/realtime', () => ({
  broadcastGachaResult: vi.fn(),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  DEFAULT_CHAT_TEMPLATE: '{user} got {card}',
  TwitchChatService: vi.fn().mockImplementation(() => ({
    buildMessage: mocks.buildMessage,
    sendChatMessage: mocks.sendChatMessage,
  })),
}))

vi.mock('@/lib/twitch/channel-points', () => ({
  cancelRedemption: mocks.cancelRedemption,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockGetSupabaseAdminNoCache = vi.mocked(getSupabaseAdminNoCache)

async function signEventSubBody(secret: string, messageId: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(messageId + timestamp + body))
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

/** 署名付き EventSub redemption 通知リクエストを作る（gacha 結果は呼び出し元で設定） */
async function createRedemptionRequest(messageId: string): Promise<NextRequest> {
  const secret = 'eventsub-test-secret'
  process.env.TWITCH_EVENTSUB_SECRET = secret
  const timestamp = '2026-07-01T10:00:00Z'
  const body = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      // redemption id は含めない = postSoldOutNotify は返還をスキップして
      // チャット通知のみ行う（このテストの関心は streamers 読み取りの経路切替）
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'viewer-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
    },
  })
  const signature = await signEventSubBody(secret, messageId, timestamp, body)

  return new NextRequest('http://localhost:3000/api/twitch/eventsub', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-signature': signature,
    },
    body,
  })
}

/** 売り切れ（発行枚数上限到達）の gacha 結果を設定する */
function mockSoldOutGacha() {
  mocks.executeGachaForEventSub.mockResolvedValue({
    success: false,
    error: CARD_ISSUANCE_MESSAGES.soldOut,
  })
}

/** {all} プレースホルダ付きテンプレートでの単発ガチャ成功を設定する */
function mockAllCountGacha() {
  mocks.executeGachaForEventSub.mockResolvedValue({
    success: true,
    data: {
      card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      userTwitchUsername: 'Viewer',
      streamer: {
        id: 'streamer-1',
        chat_announcement_enabled: true,
        chat_announcement_template: '@{user} {card} 全{all}種',
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: false,
      },
    },
  })
}

// redemption id なし + 返還スキップ時の固定文言（route.ts の SOLD_OUT_CHAT_MESSAGE）
const EXPECTED_SOLD_OUT_MESSAGE =
  '@Viewer カードの発行枚数上限に達しているため、カードを付与できませんでした。'

/**
 * Drizzle db.select のモック。呼び出しごとに from/where/limit を記録し、
 * 応答キューの rows / reject を返す（storage-db-driver-parity.test.ts の
 * createDrizzleDbMock を本ファイルの対象クエリ（JOIN なし select）向けに簡略化）。
 */
function createDbSelectMock(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  let callIndex = 0
  const calls: Array<{ from?: unknown; where?: unknown; limit?: unknown }> = []
  const db = {
    select: vi.fn(() => {
      const response = responses[Math.min(callIndex, responses.length - 1)]
      callIndex += 1
      const call: { from?: unknown; where?: unknown; limit?: unknown } = {}
      calls.push(call)
      const resolve = () =>
        response.reject !== undefined
          ? Promise.reject(response.reject)
          : Promise.resolve(response.rows ?? [])
      const builder: any = {
        from: vi.fn((table: unknown) => {
          call.from = table
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, calls }
}

function setupPgDb(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  const mock = createDbSelectMock(responses)
  vi.mocked(getDb).mockResolvedValue({
    db: mock.db as never,
    // 本ファイルの対象クエリはすべて Drizzle 経由（sql タグ不使用）
    sql: (() => {
      throw new Error('sql tag must not be used by #663 queries')
    }) as never,
  })
  return mock
}

/** postSoldOutNotify の streamers 読み取り用 postgrest クライアント */
function createStreamersSettingsClient(result: { data?: unknown; error?: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  })
  const from = vi.fn((table: string) => {
    if (table !== 'streamers') {
      throw new Error(`Unexpected table: ${table}`)
    }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle,
    }
    return builder
  })
  return { from, maybeSingle }
}

/** {all} count 用 NoCache postgrest クライアント（cards の head count クエリ） */
function createNoCacheCardsCountClient(result: { count?: number | null; error?: unknown }) {
  const eqCalls: Array<[string, unknown]> = []
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push([column, value])
      return builder
    }),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ count: result.count ?? null, error: result.error ?? null }).then(
        onFulfilled,
        onRejected,
      ),
  }
  const from = vi.fn((table: string) => {
    if (table !== 'cards') {
      throw new Error(`Unexpected table: ${table}`)
    }
    return builder
  })
  return { from, builder, eqCalls }
}

/** 呼ばれてはならない postgrest クライアント（経路の食い違い検出用） */
function createThrowingClient(label: string) {
  return {
    from: vi.fn((table: string) => {
      throw new Error(`${label} must not be used (table: ${table})`)
    }),
    rpc: vi.fn(() => {
      throw new Error(`${label} rpc must not be used`)
    }),
  }
}

describe('EventSub ガチャ通知残余クエリのドライバパリティ (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildMessage.mockReturnValue('built message')
    mocks.sendChatMessage.mockResolvedValue(true)
    // 既定では両クライアントとも「呼ばれたら失敗」に倒し、各テストで必要な
    // 経路のみ明示的に差し替える（想定外のクエリを握り潰さない）
    mockGetSupabaseAdmin.mockReturnValue(
      createThrowingClient('getSupabaseAdmin') as unknown as ReturnType<typeof getSupabaseAdmin>,
    )
    mockGetSupabaseAdminNoCache.mockReturnValue(
      createThrowingClient('getSupabaseAdminNoCache') as unknown as ReturnType<typeof getSupabaseAdminNoCache>,
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('postSoldOutNotify の chat_announcement_enabled 読み取り', () => {
    it('postgrest 経路(フラグ未設定): streamers を supabase-js で読み getDb は呼ばれない', async () => {
      mockSoldOutGacha()
      const client = createStreamersSettingsClient({ data: { chat_announcement_enabled: true } })
      mockGetSupabaseAdmin.mockReturnValue(client as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(await createRedemptionRequest('soldout-postgrest'))

      expect(response.status).toBe(200)
      expect(client.from).toHaveBeenCalledWith('streamers')
      expect(getDb).not.toHaveBeenCalled()
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', EXPECTED_SOLD_OUT_MESSAGE)
    })

    it('pg 経路(GACHA_DB_DRIVER=pg): UNIQUE 前提の LIMIT 1 クエリで読み、同一のメッセージが送信される(supabase-js は不呼出)', async () => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
      mockSoldOutGacha()
      const pg = setupPgDb([{ rows: [{ chat_announcement_enabled: true }] }])

      const response = await POST(await createRedemptionRequest('soldout-pg'))

      expect(response.status).toBe(200)
      // .maybeSingle() 相当: streamers を twitch_user_id で絞り LIMIT 1
      expect(pg.calls).toHaveLength(1)
      expect(pg.calls[0].from).toBe(streamersTable)
      expect(pg.calls[0].where).toEqual(eq(streamersTable.twitch_user_id, 'broadcaster-1'))
      expect(pg.calls[0].limit).toBe(1)
      // postgrest 経路と同一のメッセージ（経路間パリティ）
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', EXPECTED_SOLD_OUT_MESSAGE)
      // streamers 読み取りが postgrest 経路へ流れていないこと（pg 分岐では
      // getSupabaseAdmin() 自体が呼ばれない）
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    })

    it('pg 経路で無効/行なし: 既存挙動どおりチャット通知しない', async () => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
      for (const rows of [[{ chat_announcement_enabled: false }], []]) {
        vi.clearAllMocks()
        mockSoldOutGacha()
        setupPgDb([{ rows }])

        const response = await POST(await createRedemptionRequest(`soldout-pg-disabled-${rows.length}`))

        expect(response.status).toBe(200)
        expect(mocks.sendChatMessage).not.toHaveBeenCalled()
        // 「機能無効でスキップ」の info ログ（postgrest 経路の !streamer?.chat_
        // announcement_enabled 分岐と同一の消費コードを通る）
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          '[postSoldOutNotify] Chat announcement skipped - feature disabled',
          expect.objectContaining({ broadcasterTwitchUserId: 'broadcaster-1' }),
        )
      }
    })

    it('pg 経路の取得失敗: postgrest の error と同じ warn + 通知なしで 200 を返す（throw しない・フォールスルーしない）', async () => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
      mockSoldOutGacha()
      const pgErrorObj = Object.assign(new Error('permission denied'), { code: '42501' })
      setupPgDb([{ reject: pgErrorObj }])

      const response = await POST(await createRedemptionRequest('soldout-pg-error'))

      expect(response.status).toBe(200)
      expect(mocks.sendChatMessage).not.toHaveBeenCalled()
      // postgrest 経路の error 分岐と同じ warn ログ（メッセージ本文はドライバ由来）
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        '[postSoldOutNotify] Failed to fetch chat announcement settings',
        expect.objectContaining({
          broadcasterTwitchUserId: 'broadcaster-1',
          error: 'permission denied',
        }),
      )
    })

    it('緊急ロールバック(DB_DRIVER=pg + GACHA_DB_DRIVER=postgrest): ガチャ経路と揃って postgrest で読む', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
      mockSoldOutGacha()
      const client = createStreamersSettingsClient({ data: { chat_announcement_enabled: true } })
      mockGetSupabaseAdmin.mockReturnValue(client as unknown as ReturnType<typeof getSupabaseAdmin>)

      const response = await POST(await createRedemptionRequest('soldout-rollback'))

      expect(response.status).toBe(200)
      expect(client.from).toHaveBeenCalledWith('streamers')
      expect(getDb).not.toHaveBeenCalled()
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', EXPECTED_SOLD_OUT_MESSAGE)
    })
  })

  describe('sendChatAnnouncement の {all} 用 cards count クエリ', () => {
    it('postgrest 経路(フラグ未設定): NoCache クライアントの head count で実行され getDb は呼ばれない', async () => {
      mockAllCountGacha()
      const noCache = createNoCacheCardsCountClient({ count: 7 })
      mockGetSupabaseAdminNoCache.mockReturnValue(
        noCache as unknown as ReturnType<typeof getSupabaseAdminNoCache>,
      )

      const response = await POST(await createRedemptionRequest('allcount-postgrest'))

      expect(response.status).toBe(200)
      // 既存経路の呼び出し形状（head count + streamer_id / is_active フィルタ）が不変であること
      expect(noCache.from).toHaveBeenCalledWith('cards')
      expect(noCache.builder.select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
      expect(noCache.eqCalls).toEqual([
        ['streamer_id', 'streamer-1'],
        ['is_active', true],
      ])
      expect(getDb).not.toHaveBeenCalled()
      expect(mocks.buildMessage).toHaveBeenCalledWith(
        '@{user} {card} 全{all}種',
        expect.objectContaining({ all: 7 }),
      )
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    })

    it('pg 経路(GACHA_DB_DRIVER=pg): COUNT(*) 集計で実行され、同一データから同一プレースホルダになる(NoCache は不呼出)', async () => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
      mockAllCountGacha()
      const pg = setupPgDb([{ rows: [{ count: 7 }] }])

      const response = await POST(await createRedemptionRequest('allcount-pg'))

      expect(response.status).toBe(200)
      // head count 相当: cards を streamer_id + is_active で絞った COUNT クエリ
      expect(pg.calls).toHaveLength(1)
      expect(pg.calls[0].from).toBe(cardsTable)
      expect(pg.calls[0].where).toEqual(
        and(eq(cardsTable.streamer_id, 'streamer-1'), eq(cardsTable.is_active, true)),
      )
      // postgrest 経路と同一のプレースホルダ計算結果になる（経路間パリティ）
      expect(mocks.buildMessage).toHaveBeenCalledWith(
        '@{user} {card} 全{all}種',
        expect.objectContaining({ all: 7 }),
      )
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    })

    it('pg 経路の取得失敗: 既存挙動どおり warn + {all} 未定義のまま通知を送信する（postgrest へフォールスルーしない）', async () => {
      vi.stubEnv('GACHA_DB_DRIVER', 'pg')
      mockAllCountGacha()
      const pgErrorObj = Object.assign(new Error('relation does not exist'), { code: '42P01' })
      setupPgDb([{ reject: pgErrorObj }])

      const response = await POST(await createRedemptionRequest('allcount-pg-error'))

      expect(response.status).toBe(200)
      // postgrest 経路の allCountResult.error 分岐と同じ warn ログ
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to fetch {all} card count for chat announcement',
        expect.objectContaining({
          streamerId: 'streamer-1',
          error: 'relation does not exist',
        }),
      )
      // {all} は未定義のまま（buildMessage 側で空文字化される既存仕様）で通知は必ず送信
      expect(mocks.buildMessage).toHaveBeenCalledWith(
        '@{user} {card} 全{all}種',
        expect.objectContaining({ all: undefined }),
      )
      expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    })

    it('緊急ロールバック(DB_DRIVER=pg + GACHA_DB_DRIVER=postgrest): count クエリもガチャ経路と揃って postgrest で実行される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
      mockAllCountGacha()
      const noCache = createNoCacheCardsCountClient({ count: 7 })
      mockGetSupabaseAdminNoCache.mockReturnValue(
        noCache as unknown as ReturnType<typeof getSupabaseAdminNoCache>,
      )

      const response = await POST(await createRedemptionRequest('allcount-rollback'))

      expect(response.status).toBe(200)
      expect(noCache.from).toHaveBeenCalledWith('cards')
      expect(getDb).not.toHaveBeenCalled()
      expect(mocks.buildMessage).toHaveBeenCalledWith(
        '@{user} {card} 全{all}種',
        expect.objectContaining({ all: 7 }),
      )
    })
  })
})
