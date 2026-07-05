/**
 * #573: eventsub チャット通知プレースホルダ用 get_user_card_counts RPC の
 * postgrest / pg 直結ドライバ切替パリティテスト
 *
 * sendChatAnnouncement の {num}/{unique} は getSupabaseAdminNoCache 経由の RPC で
 * 取得される。この呼び出しはガチャ EventSub フロー内のため、全体フラグではなく
 * ガチャ経路専用の getGachaDbDriver() === 'pg' のときのみ RPC 実行が pg 直結
 * (fetchUserCardCountsRpcPg) に切り替わることを固定する:
 *   1. フラグ未設定時(既定 'postgrest')は getDb が一切呼ばれず既存挙動が不変
 *   2. pg 経路(GACHA_DB_DRIVER=pg)では NoCache クライアントの rpc へ流れず、
 *      同一 RPC データから同一のプレースホルダ({num}=当選カード所持数 /
 *      {unique}=アクティブ種類数)が組み立てられる（名前付き引数 + ::uuid 明示キャスト）
 *   3. 既存 postgrest 経路のこの呼び出しには 42883 フォールバックが無いため、
 *      pg 経路でも特別扱いせず「warn ログ + プレースホルダ未定義のまま通知送信」
 *      の同じ外部挙動になる（postgrest へのフォールスルーもしない）
 *   4. GACHA_DB_DRIVER=postgrest による緊急ロールバックはガチャ実行(execute_gacha_
 *      transaction)と通知経路を一括で旧経路へ戻す(経路の食い違いを作らない)
 *
 * モックの流儀は tests/unit/eventsub-reward-mismatch.test.ts（EventSub 署名付き
 * POST + GachaService / chat-service モック）と
 * tests/unit/gacha-rpc-driver-parity.test.ts（getDb 上書き + vi.stubEnv）を踏襲。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin, getSupabaseAdminNoCache } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  buildMessage: vi.fn(() => 'built message'),
  sendChatMessage: vi.fn().mockResolvedValue(true),
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

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockGetSupabaseAdminNoCache = vi.mocked(getSupabaseAdminNoCache)
const mockReportError = vi.mocked(reportError)

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

/**
 * {num}/{unique} を含むテンプレートを持つ配信者への単発ガチャ成功を再現する
 * 署名付き EventSub 通知リクエストを作る。
 */
async function createRedemptionRequest(messageId: string): Promise<NextRequest> {
  const secret = 'eventsub-test-secret'
  process.env.TWITCH_EVENTSUB_SECRET = secret
  const timestamp = '2026-07-01T10:00:00Z'
  const body = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'viewer-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
    },
  })
  const signature = await signEventSubBody(secret, messageId, timestamp, body)

  mocks.executeGachaForEventSub.mockResolvedValue({
    success: true,
    data: {
      card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      userTwitchUsername: 'Viewer',
      streamer: {
        id: 'streamer-1',
        chat_announcement_enabled: true,
        chat_announcement_template: '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: false,
      },
    },
  })

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

/**
 * get_user_card_counts (00031, RETURNS JSONB) の行配列 fixture。
 * card-1（当選カード）は count 3 → {num}=3、is_active は card-1 のみ true →
 * {unique}=1（アクティブカードだけ数える既存仕様）。
 */
const USER_CARD_COUNT_ROWS = [
  { count: 3, card: { id: 'card-1', is_active: true } },
  { count: 1, card: { id: 'card-2', is_active: false } },
]

/** postgres.js の sql タグ呼び出しモック（gacha-rpc-driver-parity.test.ts と同じ流儀） */
function createSqlMock(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  let callIndex = 0
  return vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings
    void values
    const response = responses[Math.min(callIndex, responses.length - 1)]
    callIndex += 1
    return response.reject !== undefined
      ? Promise.reject(response.reject)
      : Promise.resolve(response.rows ?? [])
  })
}

function pgError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function renderSqlCall(sqlMock: ReturnType<typeof vi.fn>, index: number) {
  const [strings, ...values] = sqlMock.mock.calls[index] as [readonly string[], ...unknown[]]
  return { text: strings.join('$'), values }
}

function setupPgSql(responses: Array<{ rows?: unknown[]; reject?: unknown }>) {
  const sqlMock = createSqlMock(responses)
  vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })
  return sqlMock
}

describe('EventSub get_user_card_counts ドライバパリティ (#573)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildMessage.mockReturnValue('built message')
    mocks.sendChatMessage.mockResolvedValue(true)
    // 成功経路では getSupabaseAdmin のクエリは使われない（postSoldOutNotify 専用）。
    // 万一呼ばれた場合に握り潰されないよう throw するスタブにする。
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('postgrest 経路(フラグ未設定): NoCache クライアントの rpc で実行され getDb は呼ばれない', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: USER_CARD_COUNT_ROWS, error: null })
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)

    const response = await POST(await createRedemptionRequest('eventsub-counts-postgrest'))

    expect(response.status).toBe(200)
    // 既存経路の呼び出し形状(名前付きパラメータのオブジェクト)が不変であること
    expect(rpc).toHaveBeenCalledWith('get_user_card_counts', {
      p_twitch_user_id: 'viewer-1',
      p_streamer_id: 'streamer-1',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
  })

  it('pg 経路(GACHA_DB_DRIVER=pg): 名前付き引数の SQL で実行され、同一データから同一プレースホルダになる(NoCache rpc は不呼出)', async () => {
    // DB_DRIVER 未設定のまま GACHA_DB_DRIVER=pg だけでガチャ経路(通知含む)が
    // 切り替わる(gacha-rpc-driver-parity.test.ts と同じフラグの流儀)
    vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    const rpc = vi.fn()
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    const sqlMock = setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])

    const response = await POST(await createRedemptionRequest('eventsub-counts-pg'))

    expect(response.status).toBe(200)
    expect(sqlMock).toHaveBeenCalledTimes(1)

    // 名前付き引数・明示キャスト・bind 値の並びを固定する(位置ズレ事故防止)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('get_user_card_counts')
    expect(text).toContain('p_twitch_user_id => $')
    expect(text).toContain('p_streamer_id => $::uuid')
    expect(values).toEqual(['viewer-1', 'streamer-1'])

    // postgrest 経路と同一のプレースホルダ計算結果になる（経路間パリティ）
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    // 読み取り RPC が postgrest 経路へ流れていないこと
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pg 経路の RPC エラー(42883 含む): 既存挙動どおり warn + プレースホルダ未定義のまま通知を送信し、postgrest へフォールスルーしない', async () => {
    // 既存 postgrest 経路のこの呼び出しには 42883 フォールバックが無い
    // （エラー種別を問わず warn + プレースホルダ空文字化）ため、pg 経路でも
    // 42883 を特別扱いしないこと＝「既存にない保護を勝手に増やさない」を固定する。
    vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    const rpc = vi.fn()
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    setupPgSql([
      { reject: pgError('42883', 'function get_user_card_counts(p_twitch_user_id => text) does not exist') },
    ])

    const response = await POST(await createRedemptionRequest('eventsub-counts-pg-error'))

    expect(response.status).toBe(200)
    // プレースホルダは未定義のまま（buildMessage 側で空文字化される既存仕様）
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: undefined, unique: undefined }),
    )
    // 通知自体はカウント無しでも必ず送信される
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    // 既存と同じ warn ログ経路（reportError はしない）
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Failed to fetch user card counts for chat announcement',
      expect.objectContaining({
        streamerId: 'streamer-1',
        userTwitchId: 'viewer-1',
      }),
    )
    expect(mockReportError).not.toHaveBeenCalled()
    // postgrest RPC へのフォールスルーはしない
    expect(rpc).not.toHaveBeenCalled()
  })

  it('緊急ロールバック(DB_DRIVER=pg + GACHA_DB_DRIVER=postgrest): 通知経路もガチャ経路と揃って postgrest で実行される', async () => {
    // GACHA_DB_DRIVER=postgrest はガチャ実行フロー全体(execute_gacha_transaction と
    // このチャット通知用 RPC)を1つのレバーで旧経路へ戻す。通知経路が全体フラグ
    // (DB_DRIVER)で分岐していると、ロールバック時に通知だけ pg 直結に残る
    // 「経路の食い違い」が起きるため、それが無いこと(getDb 不呼出 + NoCache rpc
    // 呼出)を固定する。
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
    const rpc = vi.fn().mockResolvedValue({ data: USER_CARD_COUNT_ROWS, error: null })
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)

    const response = await POST(await createRedemptionRequest('eventsub-counts-rollback'))

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('get_user_card_counts', {
      p_twitch_user_id: 'viewer-1',
      p_streamer_id: 'streamer-1',
    })
    expect(getDb).not.toHaveBeenCalled()
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
  })
})
