/**
 * #573/#708: EventSubチャット通知用 get_user_card_counts のPlanetScaleテスト。
 *
 * 名前付きSQL引数、{num}/{unique} プレースホルダー、DB関数失敗時の
 * warn + 通知継続を、現行 getDb()/postgres.js 境界で検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger.server'

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

vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

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

describe('EventSub get_user_card_counts PlanetScale経路 (#573/#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // reject を使う失敗系ケースの one-shot 実装が次の通知ケースへ漏れると、
    // 「reporterも落ちた」境界を検証できないため、呼び出し履歴だけでなく実装も戻す。
    mockReportError.mockReset()
    mockReportError.mockResolvedValue(undefined)
    mocks.buildMessage.mockReturnValue('built message')
    mocks.sendChatMessage.mockResolvedValue(true)
  })

  it('名前付き引数のSQLを実行し、所持数とアクティブ種類数を組み立てる', async () => {
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

    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
  })

  it('{all} はPlanetScaleのアクティブカード総数だけをbindし、通知本文へ渡す', async () => {
    // {all} はユーザー所持数ではなく配信者カタログの総数である。RPC を同時に
    // 呼ばないことまで固定し、将来この通知経路へ旧PostgREST読み取りを戻さない。
    const sqlMock = setupPgSql([{ rows: [{ count: 17 }] }])
    mocks.executeGachaForEventSub.mockResolvedValueOnce({
      success: true,
      data: {
        card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: '@{user} 現在{all}種類',
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: false,
        },
      },
    })

    const response = await POST(await createRedemptionRequest('eventsub-all-count-pg'))

    expect(response.status).toBe(200)
    expect(sqlMock).toHaveBeenCalledTimes(1)
    const { text, values } = renderSqlCall(sqlMock, 0)
    expect(text).toContain('select count(*)::integer as count')
    expect(text).toContain('from cards')
    expect(text).toContain('streamer_id = $::uuid')
    expect(text).toContain('and is_active = true')
    expect(text).not.toContain('get_user_card_counts')
    expect(values).toEqual(['streamer-1'])
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} 現在{all}種類',
      expect.objectContaining({ all: 17 }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
  })

  it('RPCエラー(42883含む)を報告し、reporter障害時もカウント無し通知を継続する', async () => {
    mockReportError.mockRejectedValueOnce(new Error('error reporter unavailable'))
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
    // schema不整合は監視へ報告するが、ガチャ確定後の通知境界なので
    // reporter自体がrejectしてもEventSub応答とチャット送信を巻き戻さない。
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
      {
        context: 'eventsub:sendChatAnnouncement:userCardCounts',
        streamerId: 'streamer-1',
      },
    )
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[EventSub] Failed to persist notification error',
      {
        context: 'eventsub:sendChatAnnouncement:userCardCounts',
        error: 'error reporter unavailable',
      },
    )
  })

  it('チャット送信とreporterが共にrejectしても、確定済み交換のEventSub応答は成功する', async () => {
    // EventSub の 5xx はTwitch側のsubscription revoke判断に使われうる。通知は
    // カード付与後のbest-effort処理なので、二次障害がWebhook成功応答を壊さない。
    mocks.sendChatMessage.mockRejectedValueOnce(new Error('chat transport unavailable'))
    mockReportError.mockRejectedValueOnce(new Error('error reporter unavailable'))
    const request = await createRedemptionRequest('eventsub-chat-and-reporter-reject')
    // このケースは通知のreject境界だけを検証する。{num}/{unique} のDB失敗が
    // reporter の one-shot rejectを先に消費しないよう、DB不要テンプレートへ替える。
    mocks.executeGachaForEventSub.mockResolvedValueOnce({
      success: true,
      data: {
        card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: '@{user} {card}',
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: false,
        },
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mocks.executeGachaForEventSub).toHaveBeenCalledWith(
      expect.objectContaining({ broadcaster_user_id: 'broadcaster-1', user_id: 'viewer-1' }),
      'eventsub-chat-and-reporter-reject',
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('broadcaster-1', 'built message')
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chat transport unavailable' }),
      expect.objectContaining({ context: 'eventsub:postRedemptionNotify:chatAnnouncement' }),
    )
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[EventSub] Failed to persist notification error',
      expect.objectContaining({
        context: 'eventsub:postRedemptionNotify:chatAnnouncement',
        error: 'error reporter unavailable',
      }),
    )
  })
})
