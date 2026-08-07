import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * #694 Stage 4: EventSub webhook (`src/app/api/twitch/eventsub/route.ts`) の
 * maintenance mode 連携（notification の KV 退避）のテスト。
 *
 * 最重要の不変条件: MAINTENANCE_MODE 未設定（=off）のとき、既存の EventSub 処理
 * （DB書き込み・通知）が一切変わらないこと。
 *
 * Cloudflare コンテキストは環境依存のためモックで制御する（tests/unit/db-client.test.ts
 * / tests/unit/eventsub-park.test.ts と同じパターン）。
 */
const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  executeGachaForRaidEvent: vi.fn(),
  getCloudflareContext: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/services/gacha', () => ({
  GachaService: vi.fn().mockImplementation(() => ({
    executeGachaForEventSub: mocks.executeGachaForEventSub,
    executeGachaForRaidEvent: mocks.executeGachaForRaidEvent,
  })),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { eventsub: {} },
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({
    outcome: 'accepted',
    attempts: 1,
  }),
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  DEFAULT_CHAT_TEMPLATE: '{user} got {card}',
  TwitchChatService: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

// Issue #836: EventSub リプレイ防止（message-id 重複排除）は KV を参照する。
// このテストは maintenance park の挙動検証が目的のため、dedup は「重複なし」で
// モックし、KV の put/get 回数に影響を与えないようにする（dedup 自体の動作は
// 専用テストで検証する）。
vi.mock('@/lib/eventsub-dedup', () => ({
  isDuplicateEventSubMessage: vi.fn().mockResolvedValue(false),
  markEventSubMessageSeen: vi.fn().mockResolvedValue(undefined),
}))

const ALL_MAINTENANCE_ENV_KEYS = [
  'MAINTENANCE_MODE',
  'MAINTENANCE_STARTED_AT',
  'MAINTENANCE_EXPECTED_END_AT',
  'MAINTENANCE_MESSAGE_KEY',
  'MAINTENANCE_OPERATION_ID',
] as const

function stubMaintenanceEnv(
  overrides: Partial<Record<(typeof ALL_MAINTENANCE_ENV_KEYS)[number], string>> = {}
) {
  for (const key of ALL_MAINTENANCE_ENV_KEYS) {
    vi.stubEnv(key, overrides[key])
  }
}

async function signEventSubBody(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(messageId + timestamp + body))
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

async function createEventSubRequest(
  messageType: 'notification' | 'webhook_callback_verification' | 'revocation',
  payload: unknown,
  messageId = 'eventsub-message-1',
  // P2-1: 署名検証後不変条件のテスト用に、正しく計算した署名を意図的に壊せるようにする。
  // 未指定時は従来どおり正しい署名を使う（既存テストへの影響なし）。
  options: { corruptSignature?: boolean } = {}
): Promise<NextRequest> {
  const secret = 'eventsub-test-secret'
  process.env.TWITCH_EVENTSUB_SECRET = secret
  const timestamp = new Date().toISOString()
  const body = JSON.stringify(payload)
  const validSignature = await signEventSubBody(secret, messageId, timestamp, body)
  // 正しい署名の末尾1文字だけを変えることで「署名検証は必ず失敗するが、それ以外
  // （長さ等）は本物と見分けがつかない」状態を作る。
  const signature = options.corruptSignature
    ? `${validSignature.slice(0, -1)}${validSignature.endsWith('0') ? '1' : '0'}`
    : validSignature

  return new NextRequest('http://localhost:3000/api/twitch/eventsub', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-type': messageType,
      'twitch-eventsub-message-signature': signature,
    },
    body,
  })
}

const notificationPayload = {
  subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
  event: {
    broadcaster_user_id: 'broadcaster-1',
    user_id: 'viewer-1',
    user_login: 'viewer',
    user_name: 'Viewer',
    reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
  },
}

describe('EventSub route x maintenance mode (#694 Stage 4)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getCloudflareContext.mockReset()
    mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 1000, remaining: 999, reset: Date.now() + 1000 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('mode=off 不変条件', () => {
    it('MAINTENANCE_MODE未設定なら従来どおりDB書き込み（handleRedemption相当）が実行される', async () => {
      stubMaintenanceEnv()
      mocks.executeGachaForEventSub.mockResolvedValue({ success: false, error: 'Streamer not found' })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload)
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.executeGachaForEventSub).toHaveBeenCalledTimes(1)
      // maintenance park はCloudflareコンテキストを一切参照しないはず
      expect(mocks.getCloudflareContext).not.toHaveBeenCalled()
    })

    it("MAINTENANCE_MODE='off'を明示しても従来どおりDB書き込みが実行される", async () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
      mocks.executeGachaForEventSub.mockResolvedValue({ success: false, error: 'Streamer not found' })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload)
      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(mocks.executeGachaForEventSub).toHaveBeenCalledTimes(1)
    })

    it('N連途中などretryableな失敗は2xx前にdurable inboxへ保存する', async () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })
      mocks.executeGachaForEventSub.mockResolvedValue({
        success: false,
        error: 'Partial gacha completion: 2/3 draws succeeded before error: connection closed',
      })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest(
        'notification',
        notificationPayload,
        'msg-partial-retry',
      )
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(put).toHaveBeenCalledTimes(1)
      const [, value] = put.mock.calls[0]
      const parked = JSON.parse(value)
      expect(parked.messageId).toBe('msg-partial-retry')
      expect(parked.maintenanceMode).toBe('off')
      expect(parked.payload).toEqual(notificationPayload)
    })

    it('retryable通知を永続化できなければ503でTwitch再送を要求する', async () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
      const put = vi.fn().mockRejectedValue(new Error('KV unavailable'))
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })
      mocks.executeGachaForEventSub.mockResolvedValue({
        success: false,
        error: 'Partial gacha completion: 2/3 draws succeeded before error: connection closed',
      })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest(
        'notification',
        notificationPayload,
        'msg-partial-park-failed',
      )
      const response = await POST(request)

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({ received: false, retryable: true })
      expect(put).toHaveBeenCalledTimes(1)
    })
  })

  describe('mode=read-only での notification 退避', () => {
    beforeEach(() => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only', MAINTENANCE_OPERATION_ID: 'op-42' })
    })

    it('KVへ退避しhandleRedemption（DB書き込み）を呼ばず2xxを返す', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload, 'msg-parked-1')
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()

      expect(put).toHaveBeenCalledTimes(1)
      const [key, value] = put.mock.calls[0]
      expect(key).toContain('maintenance:eventsub:')
      expect(key).toContain('msg-parked-1')
      const parsed = JSON.parse(value)
      expect(parsed.messageId).toBe('msg-parked-1')
      expect(parsed.subscriptionType).toBe('channel.channel_points_custom_reward_redemption.add')
      expect(parsed.maintenanceOperationId).toBe('op-42')
      expect(parsed.payload).toEqual(notificationPayload)
    })

    it('P2-1: 署名検証に失敗したnotificationはKVへ退避されずガチャ処理も呼ばれず403を返す（maintenance ON中でも）', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest(
        'notification',
        notificationPayload,
        'msg-bad-signature',
        { corruptSignature: true }
      )
      const response = await POST(request)

      // 署名検証はmaintenance判定より前に行われるため、maintenance ON中でも
      // 従来どおり403を返す。「偽payloadがKVに入らない」という退避設計の
      // 最重要性質（route.tsの実装コメント参照）をここで直接検証する。
      expect(response.status).toBe(403)
      expect(put).not.toHaveBeenCalled()
      expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
    })

    it('raid notificationもKVへ退避しexecuteGachaForRaidEventを呼ばない', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const raidPayload = {
        subscription: { type: 'channel.raid' },
        event: {
          from_broadcaster_user_id: 'raider-1',
          from_broadcaster_user_login: 'raider',
          from_broadcaster_user_name: 'Raider',
          to_broadcaster_user_id: 'broadcaster-1',
          viewers: 5,
        },
      }

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', raidPayload, 'msg-raid-1')
      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(mocks.executeGachaForRaidEvent).not.toHaveBeenCalled()
      expect(put).toHaveBeenCalledTimes(1)
    })

    it('KV書き込み失敗時もDB書き込みを行わず2xxを返す（データロスは許容しTwitchへの5xxを避ける）', async () => {
      const put = vi.fn().mockRejectedValue(new Error('KV down'))
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload, 'msg-kv-fail')
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()

      const { logger } = await import('@/lib/logger')
      // データロスのためwarnではなくerror（errorsテーブル→GitHub Issue自動起票経路）で記録する
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[maintenance:eventsub] failed to park message id=msg-kv-fail'),
        expect.anything()
      )
    })

    it('KVバインディング未取得（Workers外)でもDB書き込みを行わず2xxを返す', async () => {
      mocks.getCloudflareContext.mockRejectedValue(new Error('not in workers'))

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload, 'msg-no-kv')
      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
    })

    it('webhook_callback_verification（challenge）は退避されず通常どおりchallengeを返す', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('webhook_callback_verification', {
        subscription: { type: 'channel.channel_points_custom_reward_redemption.add', condition: {} },
        challenge: 'challenge-token-123',
      })
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('challenge-token-123')
      // challengeはKV退避の対象外
      expect(put).not.toHaveBeenCalled()
    })

    it('revocationは退避されず通常どおり処理される（ユーザー起因）', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('revocation', {
        subscription: {
          type: 'channel.channel_points_custom_reward_redemption.add',
          status: 'authorization_revoked',
          condition: { broadcaster_user_id: 'broadcaster-1' },
        },
      })
      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(put).not.toHaveBeenCalled()

      const { reportError } = await import('@/lib/sentry/error-handler')
      // ユーザー起因のrevocationはreportErrorを呼ばない（既存挙動と同じ）
      expect(reportError).not.toHaveBeenCalled()
    })

    it('予期しないrevocationはmaintenance中でも従来どおりreportErrorを呼ぶ（診断ログは意図的に抑制対象外）', async () => {
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('revocation', {
        subscription: {
          type: 'channel.channel_points_custom_reward_redemption.add',
          status: 'notification_failures_exceeded',
          condition: { broadcaster_user_id: 'broadcaster-1' },
        },
      })
      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(put).not.toHaveBeenCalled()

      const { reportError } = await import('@/lib/sentry/error-handler')
      expect(reportError).toHaveBeenCalledTimes(1)
    })
  })

  describe('mode=cutover-validating / incident-read-only でも同様にnotificationが退避される', () => {
    it.each(['cutover-validating', 'incident-read-only'] as const)('mode=%s', async (mode) => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: mode })
      const put = vi.fn().mockResolvedValue(undefined)
      mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { put } } })

      const { POST } = await import('@/app/api/twitch/eventsub/route')
      const request = await createEventSubRequest('notification', notificationPayload, `msg-${mode}`)
      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
      expect(put).toHaveBeenCalledTimes(1)
    })
  })
})
