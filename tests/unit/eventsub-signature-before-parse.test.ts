import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * EventSub webhook (`src/app/api/twitch/eventsub/route.ts`) は、署名・タイムスタンプを
 * 検証してから JSON.parse する（Twitch 公式の EventSub 検証手順）。
 *
 * 回帰テストの対象: 以前は署名検証の前に JSON.parse しており、未認証の第三者が不正な
 * JSON を送るだけで handleApiError（errors テーブル記録 → error-reporter 経由で公開
 * GitHub Issue 化）を発火できた。
 *
 * 既存の challenge 応答・重複排除・revocation の挙動は eventsub-maintenance-park.test.ts
 * 等が引き続き検証するので、ここでは「パースと署名の順序」と、順序変更で壊れていないこと
 * （challenge / revocation / notification の基本経路）に絞る。
 */
const mocks = vi.hoisted(() => ({
  handleApiError: vi.fn(),
  checkRateLimit: vi.fn(),
  handleRedemption: vi.fn(),
  reportError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}))

vi.mock('@/lib/error-handler', () => ({
  handleApiError: mocks.handleApiError,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { eventsub: {} },
}))

vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: mocks.reportError,
}))

vi.mock('@/lib/eventsub-dedup', () => ({
  isDuplicateEventSubMessage: vi.fn().mockResolvedValue(false),
  markEventSubMessageSeen: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/maintenance/eventsub-park', () => ({
  parkEventSubNotification: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/services/eventsub-redemption', () => ({
  handleRedemption: mocks.handleRedemption,
  handleRaidNotification: vi.fn().mockResolvedValue({ retryable: false }),
  postRedemptionNotify: vi.fn(),
  runInBackground: vi.fn(),
}))

const SECRET = 'eventsub-test-secret'

async function sign(messageId: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(messageId + timestamp + body))
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`
}

/** 生ボディ文字列をそのまま送る（JSON として壊れていても署名できるよう文字列で受ける）。 */
async function makeRequest(
  rawBody: string,
  messageType: string,
  options: { signature?: 'valid' | 'invalid' | 'missing'; timestamp?: string } = {}
): Promise<NextRequest> {
  const messageId = 'msg-1'
  const timestamp = options.timestamp ?? new Date().toISOString()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'twitch-eventsub-message-id': messageId,
    'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-type': messageType,
  }
  if (options.signature !== 'missing') {
    headers['twitch-eventsub-message-signature'] =
      options.signature === 'invalid' ? 'sha256=' + '0'.repeat(64) : await sign(messageId, timestamp, rawBody)
  }
  return new NextRequest('http://localhost:3000/api/twitch/eventsub', {
    method: 'POST',
    headers,
    body: rawBody,
  })
}

describe('EventSub route: 署名検証 → JSON パースの順序', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.TWITCH_EVENTSUB_SECRET = SECRET
    mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 1000, remaining: 999, reset: Date.now() + 1000 })
    mocks.handleRedemption.mockResolvedValue({ retryable: false })
    mocks.handleApiError.mockImplementation(() => new Response('handled', { status: 500 }))
  })

  afterEach(() => {
    delete process.env.TWITCH_EVENTSUB_SECRET
  })

  it('署名が無い/不正で JSON も壊れているリクエストは 403 で、handleApiError(errors 記録)を呼ばない', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')

    for (const signature of ['invalid', 'missing'] as const) {
      const response = await POST(await makeRequest('{"not json', 'notification', { signature }))
      expect(response.status).toBe(403)
    }
    expect(mocks.handleApiError).not.toHaveBeenCalled()
    expect(mocks.reportError).not.toHaveBeenCalled()
  })

  it('署名が正しくてもタイムスタンプが古ければ、JSON が壊れていても 403 で handleApiError を呼ばない', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString()

    const response = await POST(await makeRequest('{"not json', 'notification', { timestamp: stale }))

    expect(response.status).toBe(403)
    expect(mocks.handleApiError).not.toHaveBeenCalled()
  })

  it('署名検証済みでも JSON が壊れていれば 400 を返し、handleApiError に渡さず、ボディ断片をログに残さない', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const secretFragment = 'SENSITIVE-FRAGMENT-12345'

    const response = await POST(await makeRequest(`{"broken": "${secretFragment}`, 'notification'))

    expect(response.status).toBe(400)
    expect(mocks.handleApiError).not.toHaveBeenCalled()
    expect(mocks.reportError).not.toHaveBeenCalled()
    expect(mocks.handleRedemption).not.toHaveBeenCalled()
    // ログには長さ等のメタデータのみ。受信ボディの断片は含めない。
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(secretFragment)
  })

  it('署名検証済みで JSON として正しくてもオブジェクトでなければ 400（500 にしない）', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')

    for (const raw of ['null', '[]', '123']) {
      const response = await POST(await makeRequest(raw, 'notification'))
      expect(response.status).toBe(400)
    }
    expect(mocks.handleApiError).not.toHaveBeenCalled()
  })

  it('既存挙動: verification は challenge を text/plain で返す', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const raw = JSON.stringify({ challenge: 'abc-challenge', subscription: { type: 'x', condition: {} } })

    const response = await POST(await makeRequest(raw, 'webhook_callback_verification'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    await expect(response.text()).resolves.toBe('abc-challenge')
    // 非 notification はレート制限を通る（順序・挙動は従来どおり）
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
  })

  it('既存挙動: 非 notification のレート制限超過は 429（パース後・処理前）', async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: Date.now() + 1000 })
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const raw = JSON.stringify({ challenge: 'c', subscription: {} })

    const response = await POST(await makeRequest(raw, 'webhook_callback_verification'))

    expect(response.status).toBe(429)
  })

  it('既存挙動: 想定外の revocation は reportError し 200、ユーザー起因はしない', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')

    const unexpected = JSON.stringify({ subscription: { id: 's1', type: 't', status: 'notification_failures_exceeded', condition: {} } })
    expect((await POST(await makeRequest(unexpected, 'revocation'))).status).toBe(200)
    expect(mocks.reportError).toHaveBeenCalledTimes(1)

    const expected = JSON.stringify({ subscription: { id: 's2', type: 't', status: 'user_removed', condition: {} } })
    expect((await POST(await makeRequest(expected, 'revocation'))).status).toBe(200)
    expect(mocks.reportError).toHaveBeenCalledTimes(1)
  })

  it('既存挙動: 署名検証済みの notification は処理され 200', async () => {
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const raw = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: { broadcaster_user_id: 'b1' },
    })

    const response = await POST(await makeRequest(raw, 'notification'))

    expect(response.status).toBe(200)
    expect(mocks.handleRedemption).toHaveBeenCalledTimes(1)
  })
})
