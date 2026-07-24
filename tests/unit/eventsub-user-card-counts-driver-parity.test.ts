/**
 * #573/#803: EventSubチャット通知のPlanetScale固定回帰テスト。
 *
 * 旧driver secretの有無・値に関係なく、`{num}/{unique}/{newCards}/{all}`を
 * PlanetScaleから取得し、退役済みNoCache clientを呼ばないことを固定する。
 * DB/RPC障害時は空placeholderでチャット通知を継続しつつ、deployment errorを
 * best-effortで永続監視へ送り、reporter障害もEventSub 2xxへ影響させない。
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

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({
    outcome: 'accepted',
    attempts: 1,
  }),
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
async function createRedemptionRequest(
  messageId: string,
  template = '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
): Promise<NextRequest> {
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
        chat_announcement_template: template,
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

  it('フラグ未設定でもPlanetScale RPCを使い、退役済みNoCache clientを呼ばない', async () => {
    const rpc = vi.fn()
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    const sqlMock = setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])

    const response = await POST(await createRedemptionRequest('eventsub-counts-default'))

    expect(response.status).toBe(200)
    expect(sqlMock).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
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
    // 通知は継続するが、RPC未デプロイは運用監視へ永続化する。
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Failed to fetch user card counts for chat announcement',
      expect.objectContaining({
        streamerId: 'streamer-1',
        userTwitchId: 'viewer-1',
      }),
    )
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('get_user_card_counts'),
      }),
      expect.objectContaining({
        context: 'eventsub:sendChatAnnouncement:userCardCounts',
        streamerId: 'streamer-1',
      }),
    )
    // postgrest RPC へのフォールスルーはしない
    expect(rpc).not.toHaveBeenCalled()
  })

  it('旧driver secretがpostgrestでも通知はPlanetScaleに固定する', async () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
    const rpc = vi.fn()
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    const sqlMock = setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])

    const response = await POST(await createRedemptionRequest('eventsub-counts-rollback'))

    expect(response.status).toBe(200)
    expect(sqlMock).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
  })

  it('{all}テンプレートはPlanetScaleのactive card countを使いSupabase stubを呼ばない', async () => {
    const rpc = vi.fn()
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    const sqlMock = setupPgSql([{ rows: [{ count: 42 }] }])

    const response = await POST(
      await createRedemptionRequest('eventsub-counts-all', '@{user} 全{all}枚'),
    )

    expect(response.status).toBe(200)
    expect(sqlMock).toHaveBeenCalledTimes(1)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('from cards')
    expect(text).toContain('is_active = true')
    expect(values).toEqual(['streamer-1'])
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} 全{all}枚',
      expect.objectContaining({ all: 42 }),
    )
    expect(rpc).not.toHaveBeenCalled()
  })

  it('{all}取得失敗は空placeholderで通知を継続しdeployment errorを記録する', async () => {
    setupPgSql([{ reject: pgError('42501', 'permission denied for table cards') }])
    mockReportError.mockRejectedValue(new Error('reporter unavailable'))

    const response = await POST(
      await createRedemptionRequest('eventsub-counts-all-error', '@{user} 全{all}枚'),
    )

    expect(response.status).toBe(200)
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} 全{all}枚',
      expect.objectContaining({ all: undefined }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'permission denied for table cards',
      }),
      expect.objectContaining({
        context: 'eventsub:sendChatAnnouncement:activeCardCount',
        streamerId: 'streamer-1',
      }),
    )
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[EventSub] Failed to persist notification error',
      expect.objectContaining({
        context: 'eventsub:sendChatAnnouncement:activeCardCount',
      }),
    )
  })
})
