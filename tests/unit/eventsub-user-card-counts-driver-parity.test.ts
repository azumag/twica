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
  sendChatMessageDetailed: vi.fn().mockResolvedValue({ outcome: 'sent' }),
  claimChatNotificationBatch: vi.fn(),
  decodeChatNotificationPayload: vi.fn(),
  markChatNotificationSent: vi.fn(),
  deadLetterChatNotification: vi.fn(),
  retryChatNotification: vi.fn(),
}))

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimChatNotificationBatch: mocks.claimChatNotificationBatch,
  decodeChatNotificationPayload: mocks.decodeChatNotificationPayload,
  markChatNotificationSent: mocks.markChatNotificationSent,
  deadLetterChatNotification: mocks.deadLetterChatNotification,
  retryChatNotification: mocks.retryChatNotification,
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
  CHAT_SEND_TERMINAL_CODES: {
    MISSING_SCOPE: 'missing_scope',
    CREDENTIAL_UNAVAILABLE: 'credential_unavailable',
    TWITCH_REJECTED: 'twitch_rejected',
  },
  TwitchChatService: vi.fn().mockImplementation(() => ({
    buildMessage: mocks.buildMessage,
    sendChatMessage: mocks.sendChatMessage,
    sendChatMessageDetailed: mocks.sendChatMessageDetailed,
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
    mocks.sendChatMessageDetailed.mockReset()
    mocks.sendChatMessageDetailed.mockResolvedValue({ outcome: 'sent' })
    mocks.claimChatNotificationBatch.mockImplementation(async (batchId: string) => {
      const latestResult = mocks.executeGachaForEventSub.mock.results.at(-1)?.value
      const outcome = latestResult ? await latestResult : null
      const gachaResult = outcome?.success ? outcome.data : null
      return {
        id: '11111111-1111-4111-8111-111111111111',
        batchId,
        payloadVersion: 1,
        leaseId: '22222222-2222-4222-8222-222222222222',
        attemptCount: 1,
        createdAt: '2026-07-01T00:00:00.000Z',
        payload: gachaResult
          ? {
              batchId,
              broadcasterTwitchUserId: 'broadcaster-1',
              userId: 'viewer-1',
              streamer: gachaResult.streamer,
              gachaResult: { type: 'gacha', ...gachaResult },
            }
          : {},
      }
    })
    mocks.decodeChatNotificationPayload.mockImplementation((claim) => claim.payload)
    mocks.markChatNotificationSent.mockResolvedValue(true)
    mocks.deadLetterChatNotification.mockResolvedValue(true)
    mocks.retryChatNotification.mockResolvedValue('pending')
  })

  it('outbox snapshotがあればrelay時のDB現在値を読まず同じplaceholder本文を使う', async () => {
    const sqlMock = setupPgSql([
      { reject: new Error('relay must not query mutable card counts') },
    ])
    const request = await createRedemptionRequest('eventsub-snapshot-counts')
    const persistedClaim = {
      id: '11111111-1111-4111-8111-111111111111',
      batchId: 'eventsub-snapshot-counts',
      payloadVersion: 1,
      leaseId: '22222222-2222-4222-8222-222222222222',
      attemptCount: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      payload: {
        batchId: 'eventsub-snapshot-counts',
        broadcasterTwitchUserId: 'broadcaster-1',
        userId: 'viewer-1',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: '@{user} {card} {num}/{unique}/{all}',
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: false,
        },
        gachaResult: {
          type: 'gacha',
          card: {
            id: 'card-1', name: 'Alpha', description: null, image_url: null,
            rarity: 'rare', drop_rate: 1,
          },
          cards: [{
            id: 'card-1', name: 'Alpha', description: null, image_url: null,
            rarity: 'rare', drop_rate: 1,
          }],
          userTwitchUsername: 'Viewer',
        },
        chatSnapshot: {
          cardCount: 2,
          uniqueCount: 3,
          allCount: 4,
          newCardNames: ['Alpha'],
        },
      },
    }
    mocks.claimChatNotificationBatch.mockResolvedValueOnce(persistedClaim)
    mocks.decodeChatNotificationPayload.mockReturnValueOnce(persistedClaim.payload)

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(sqlMock).not.toHaveBeenCalled()
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user} {card} {num}/{unique}/{all}',
      expect.objectContaining({ num: 2, unique: 3, all: 4 }),
    )
    expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(persistedClaim)
  })

  it('live配送のfallback成功はackし、credential degradationだけを1回reportする', async () => {
    setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])
    const degradation = {
      code: 'credential_unavailable',
      reason: 'configured BOT credential requires reauthorization',
    }
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({ outcome: 'sent', degradation })

    const response = await POST(await createRedemptionRequest('eventsub-degraded-chat'))

    expect(response.status).toBe(200)
    expect(mocks.markChatNotificationSent).toHaveBeenCalledTimes(1)
    expect(mocks.deadLetterChatNotification).not.toHaveBeenCalled()
    expect(mocks.retryChatNotification).not.toHaveBeenCalled()
    expect(mockReportError).toHaveBeenCalledTimes(1)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('fallback sender') }),
      expect.objectContaining({
        context: 'eventsub:postRedemptionNotify:chatDegradation',
        degradation,
      }),
    )
  })

  // BOT恒久失効(degradation)は失敗系outcomeにも付与される。token-managerが永続報告を
  // 所有境界へ委ねる契約のため、本人credential障害と同時発生した場合でも
  // 「設定BOTが要再認証」の直接シグナルをDLQ reasonとreportへ残すことを検証する。
  it('live配送のterminal失敗でもcredential degradationをDLQ reasonとreportへ畳み込む', async () => {
    setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])
    const degradation = {
      code: 'credential_unavailable',
      reason: 'configured BOT credential requires reauthorization',
    }
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({
      outcome: 'terminal',
      code: 'credential_unavailable',
      reason: 'chat sender access token unavailable',
      degradation,
    })

    const response = await POST(await createRedemptionRequest('eventsub-degraded-terminal'))

    expect(response.status).toBe(200)
    const expectedReason =
      'chat sender access token unavailable; sender degraded: configured BOT credential requires reauthorization'
    expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(expect.anything(), expectedReason)
    expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('sender degraded') }),
      expect.anything(),
    )
  })

  it('名前付き引数のSQLを実行し、所持数とアクティブ種類数を組み立てる', async () => {
    const sqlMock = setupPgSql([{ rows: [{ result: USER_CARD_COUNT_ROWS }] }])
    // HTTPハンドラ内の一時オブジェクトではなく、ガチャ確定と同じtransactionで
    // 保存済みのpayloadだけが通知本文の入力になることを明示する。テンプレートを
    // EventSub実行結果と意図的に変え、将来メモリ上の結果を再利用しても通らない。
    const persistedClaim = {
      id: '11111111-1111-4111-8111-111111111111',
      batchId: 'eventsub-counts-pg',
      payloadVersion: 1,
      leaseId: '22222222-2222-4222-8222-222222222222',
      attemptCount: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      payload: {
        batchId: 'eventsub-counts-pg',
        broadcasterTwitchUserId: 'broadcaster-1',
        userId: 'viewer-1',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: '@{user} persisted {card} 所持{num}枚目 コンプ進捗{unique}',
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: false,
        },
        gachaResult: {
          type: 'gacha',
          card: { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
          userTwitchUsername: 'Viewer',
        },
      },
    }
    mocks.claimChatNotificationBatch.mockResolvedValueOnce(persistedClaim)
    mocks.decodeChatNotificationPayload.mockReturnValueOnce(persistedClaim.payload)

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
      '@{user} persisted {card} 所持{num}枚目 コンプ進捗{unique}',
      expect.objectContaining({ num: 3, unique: 1 }),
    )
    expect(mocks.sendChatMessageDetailed).toHaveBeenCalledWith(
      'broadcaster-1',
      'built message',
      expect.objectContaining({ beforeExternalSend: expect.any(Function) }),
    )
    // outboxはガチャtransaction内で既に作成済み。ライブ配送はclaim後の
    // Twitch成功時だけowner-fenced sentへ更新する。
    expect(mocks.claimChatNotificationBatch).toHaveBeenCalledWith('eventsub-counts-pg')
    expect(mocks.decodeChatNotificationPayload).toHaveBeenCalledWith(persistedClaim)
    // outbox schema version 1を復号しているため、メモリ上の通知値ではなく
    // 将来のversioned payload移行にも追従する経路をこのdriver parityで固定する。
    expect(persistedClaim.payloadVersion).toBe(1)
    expect(mocks.markChatNotificationSent).toHaveBeenCalledTimes(1)
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
    expect(mocks.sendChatMessageDetailed).toHaveBeenCalledWith(
      'broadcaster-1',
      'built message',
      expect.objectContaining({ beforeExternalSend: expect.any(Function) }),
    )
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
    expect(mocks.sendChatMessageDetailed).toHaveBeenCalledWith(
      'broadcaster-1',
      'built message',
      expect.objectContaining({ beforeExternalSend: expect.any(Function) }),
    )
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
    mocks.sendChatMessageDetailed.mockRejectedValueOnce(new Error('chat transport unavailable'))
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
    expect(mocks.sendChatMessageDetailed).toHaveBeenCalledWith(
      'broadcaster-1',
      'built message',
      expect.objectContaining({ beforeExternalSend: expect.any(Function) }),
    )
    // 予期しない送信throwは上限付きbackoffへ戻し、Cron relayが回収する。
    expect(mocks.retryChatNotification).toHaveBeenCalledTimes(1)
    expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
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

  it('missing_scopeはoutboxをDLQ化するがreportErrorしない', async () => {
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({
      outcome: 'terminal',
      code: 'missing_scope',
      reason: 'user:write:chat scope not granted',
    })
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

    const response = await POST(await createRedemptionRequest('eventsub-chat-missing-scope'))

    expect(response.status).toBe(200)
    expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'eventsub-chat-missing-scope' }),
      'user:write:chat scope not granted',
    )
    expect(mockReportError).not.toHaveBeenCalled()
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      '[postRedemptionNotify] chat announcement moved to DLQ pending Twitch reauthorization',
      expect.objectContaining({ code: 'missing_scope', streamerId: 'streamer-1' }),
    )
  })

  it.each([
    ['scope確認不能', 'eventsub-chat-scope-unavailable', 'unable to verify user:write:chat scope'],
    ['BOT一時解決不能', 'eventsub-chat-bot-unavailable', 'configured BOT credential is temporarily unavailable'],
    ['本人token DB障害', 'eventsub-chat-token-unavailable', 'chat sender credential is temporarily unavailable'],
    ['Twitch 503', 'eventsub-chat-503', 'Twitch API 503'],
    ['network障害', 'eventsub-chat-network', 'ECONNRESET'],
  ])('%sはlive outboxを再試行へ戻し、DLQ化せずreportErrorする', async (_label, batchId, reason) => {
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({
      outcome: 'retryable',
      reason,
    })
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

    const response = await POST(await createRedemptionRequest(batchId))

    expect(response.status).toBe(200)
    expect(mocks.retryChatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ batchId }),
      reason,
    )
    expect(mocks.deadLetterChatNotification).not.toHaveBeenCalled()
    expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Chat announcement pending: ${reason}`,
      }),
      expect.objectContaining({ context: 'eventsub:postRedemptionNotify:chatAnnouncement' }),
    )
    expect(mockReportError).toHaveBeenCalledTimes(1)
  })

  it('missing_scopeでもlive DLQ更新がleaseを失った場合はreportErrorする', async () => {
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({
      outcome: 'terminal',
      code: 'missing_scope',
      reason: 'user:write:chat scope not granted',
    })
    mocks.deadLetterChatNotification.mockResolvedValueOnce(false)
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

    const response = await POST(await createRedemptionRequest('eventsub-chat-missing-scope-lost-lease'))

    expect(response.status).toBe(200)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Chat announcement DLQ update lost its lease: user:write:chat scope not granted',
      }),
      expect.objectContaining({ context: 'eventsub:postRedemptionNotify:chatAnnouncement' }),
    )
  })

  it('missing_scope以外のterminalはDLQ化して従来どおりreportErrorする', async () => {
    mocks.sendChatMessageDetailed.mockResolvedValueOnce({
      outcome: 'terminal',
      code: 'twitch_rejected',
      reason: 'Twitch API 403: forbidden',
    })
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

    const response = await POST(await createRedemptionRequest('eventsub-chat-other-terminal'))

    expect(response.status).toBe(200)
    expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'eventsub-chat-other-terminal' }),
      'Twitch API 403: forbidden',
    )
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Chat announcement moved to DLQ: Twitch API 403: forbidden' }),
      expect.objectContaining({ context: 'eventsub:postRedemptionNotify:chatAnnouncement' }),
    )
    expect(mockReportError).toHaveBeenCalledTimes(1)
  })
})
