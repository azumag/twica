import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { GachaService } from '@/lib/services/gacha'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  getCloudflareContext: vi.fn(),
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
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

const mockReportError = vi.mocked(reportError)
const MockedGachaService = vi.mocked(GachaService)

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

async function createNotificationRequest(payload: unknown): Promise<NextRequest> {
  const secret = 'eventsub-test-secret'
  process.env.TWITCH_EVENTSUB_SECRET = secret
  const messageId = 'eventsub-message-1'
  // Issue #836: タイムスタンプ窓（10分）検証の導入により、固定日時は 403 になる。
  // 現在時刻を使う（再送防止の窓検証に引っかからないようにするため）。
  const timestamp = new Date().toISOString()
  const body = JSON.stringify(payload)
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

describe('EventSub redemption handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 前テストの dedup 用モック（重複/未受信テスト）が次テストへ漏れないよう
    // 初期化する（getCloudflareContext の戻り値はこの fixture が上書きする）。
    mocks.getCloudflareContext.mockReset()
    // unexpected/retryable の失敗は元のWebhookをKVに永続退避できた場合だけ200。
    // このfixtureはreportErrorの回帰テストを、実運用と同じdurable park成功経路で行う。
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put: vi.fn().mockResolvedValue(undefined) } },
    })
  })

  it('does not report stale EventSub notifications for missing streamers', async () => {
    mocks.executeGachaForEventSub.mockResolvedValue({
      success: false,
      error: 'Streamer not found',
    })

    const request = await createNotificationRequest({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'missing-broadcaster',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(MockedGachaService).toHaveBeenCalledTimes(1)
    expect(mockReportError).not.toHaveBeenCalled()
  })

  it('still reports unexpected gacha failures', async () => {
    mocks.executeGachaForEventSub.mockResolvedValue({
      success: false,
      error: 'Database error fetching streamer: permission denied',
    })

    const request = await createNotificationRequest({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: 'eventsub:handleRedemption',
        broadcasterUserId: 'broadcaster-1',
        gachaError: 'Database error fetching streamer: permission denied',
      }),
    )
  })
})

describe('EventSub replay protection (issue #836)', () => {
  it('NaN タイムスタンプは 403 を返す', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-nan-1'
    const body = JSON.stringify({ subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { broadcaster_user_id: '1' } })
    const signature = await signEventSubBody(secret, messageId, 'not-a-date', body)

    const request = new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': 'not-a-date',
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    })

    const response = await POST(request)
    expect(response.status).toBe(403)
    expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    mocks.executeGachaForEventSub.mockReset()
    mocks.executeGachaForEventSub.mockResolvedValue({ success: false, error: 'Streamer not found' })
  })

  it('11分以上前のタイムスタンプは 403 を返す', async () => {
    const oldTimestamp = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-stale-1'
    const body = JSON.stringify({ subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { broadcaster_user_id: '1' } })
    const signature = await signEventSubBody(secret, messageId, oldTimestamp, body)

    const request = new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': oldTimestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    })

    const response = await POST(request)
    expect(response.status).toBe(403)
    expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
  })

  it('重複 message-id は 2xx を返し、処理をスキップする', async () => {
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { get: vi.fn().mockResolvedValue('1'), put: vi.fn().mockResolvedValue(undefined) } },
    })
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-dup-1'
    const timestamp = new Date().toISOString()
    const body = JSON.stringify({ subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { broadcaster_user_id: '1' } })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const request = new NextRequest('http://localhost:3000/api/twitch/eventsub', {
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

    const response = await POST(request)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
  })

  it('未受信 message-id は KV に記録して処理を続行する', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { get: vi.fn().mockResolvedValue(null), put } },
    })
    const request = await createNotificationRequest({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: '1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
      },
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('eventsub:dedup:'),
      '1',
      expect.objectContaining({ expirationTtl: 600 })
    )
    expect(mocks.executeGachaForEventSub).toHaveBeenCalledTimes(1)
  })
})
