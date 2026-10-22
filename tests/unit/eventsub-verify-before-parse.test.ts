import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { handleApiError } from '@/lib/error-handler'
import { reportError } from '@/lib/sentry/error-handler'

/**
 * Issue #1895: EventSub webhook の「署名検証前にJSON解析・恒久エラー記録を
 * 行わない」ことの回帰テスト。
 *
 * 旧実装は request.text → JSON.parse → handleApiError（errorsテーブルINSERT →
 * Error Reporter による自動Issue化）という順序であったため、署名を持たない
 * 不正入力がサーバー障害用の恒久エラー経路へ到達し、DB書き込み・監視ノイズを
 * 増幅させていた。本テストは以下を受入条件として固定する:
 *
 * 1. 未署名 / 偽署名 / 期限外の入力は4xxで応答され、JSON解析結果に依存する
 *    処理（handleRedemption 等のDB・通知）と handleApiError・reportError
 *    （恒久エラー記録・自動Issue）のいずれにも到達しない。
 * 2. 本文サイズ上限は Content-Length の宣言ではなく実際の読取バイト数で
 *    強制され、上限超過の stream は読取途中で中断される（413）。
 * 3. 正常な通知・challenge・再送防御（重複排除）・maintenance 退避という
 *    正当な Twitch 配信の経路は従来どおり維持される。
 *
 * モックは route.ts が import する境界（services/eventsub-redemption 等）で
 * 差し替え、「未認証入力がどこにも到達していない」ことをスパイで検証する。
 */

const mocks = vi.hoisted(() => ({
  handleRedemption: vi.fn(),
  handleRaidNotification: vi.fn(),
  postRedemptionNotify: vi.fn(),
  runInBackground: vi.fn(),
  isDuplicateEventSubMessage: vi.fn(),
  markEventSubMessageSeen: vi.fn(),
  parkEventSubNotification: vi.fn(),
  getMaintenanceState: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/services/eventsub-redemption', () => ({
  handleRedemption: mocks.handleRedemption,
  handleRaidNotification: mocks.handleRaidNotification,
  postRedemptionNotify: mocks.postRedemptionNotify,
  runInBackground: mocks.runInBackground,
}))

vi.mock('@/lib/eventsub-dedup', () => ({
  isDuplicateEventSubMessage: mocks.isDuplicateEventSubMessage,
  markEventSubMessageSeen: mocks.markEventSubMessageSeen,
}))

vi.mock('@/lib/maintenance/eventsub-park', () => ({
  parkEventSubNotification: mocks.parkEventSubNotification,
}))

vi.mock('@/lib/maintenance/state', () => ({
  getMaintenanceState: mocks.getMaintenanceState,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { eventsub: {} },
}))

// route.ts は logger.server を import しているため、console 出力と
// logErrorFromLogger（DB永続化）をまとめて無害化する。
vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

// 未署名入力が本routeでhandleApiError（errorsテーブルINSERT → 自動Issue化）を
// 呼ばないことの回帰ピン。Issue #1895 の修正後、route はこのmoduleをimport
// しないため実呼び出しは起こり得ないが、誤って再利用された場合にこの spy が
// 「恒久エラー経路へ流した」ことを即座に検出する。
vi.mock('@/lib/error-handler', () => ({
  handleApiError: vi.fn(),
  recordApiError: vi.fn(),
  handleDatabaseError: vi.fn(),
  handleBlobError: vi.fn(),
}))

const SECRET = 'eventsub-test-secret'
const EVENTSUB_URL = 'http://localhost:3000/api/twitch/eventsub'

async function signEventSubBody(
  messageId: string,
  timestamp: string,
  body: string,
  secret: string = SECRET
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

interface HeaderOverrides {
  messageId?: string
  timestamp?: string
  messageType?: string
  signature?: string
  omit?: string[]
  extra?: Record<string, string>
}

function buildEventSubHeaders(overrides: HeaderOverrides = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'twitch-eventsub-message-id': overrides.messageId ?? 'eventsub-message-1',
    'twitch-eventsub-message-timestamp': overrides.timestamp ?? new Date().toISOString(),
    'twitch-eventsub-message-type': overrides.messageType ?? 'notification',
    'twitch-eventsub-message-signature':
      overrides.signature ?? `sha256=${'0'.repeat(64)}`,
  }
  for (const name of overrides.omit ?? []) {
    delete headers[name]
  }
  return { ...headers, ...overrides.extra }
}

function createEventSubRequest(body: BodyInit, overrides: HeaderOverrides = {}): NextRequest {
  process.env.TWITCH_EVENTSUB_SECRET = SECRET
  return new NextRequest(EVENTSUB_URL, {
    method: 'POST',
    headers: buildEventSubHeaders(overrides),
    body,
  })
}

async function createSignedRequest(
  body: string,
  overrides: HeaderOverrides = {}
): Promise<NextRequest> {
  const messageId = overrides.messageId ?? 'eventsub-message-1'
  const timestamp = overrides.timestamp ?? new Date().toISOString()
  const signature = await signEventSubBody(messageId, timestamp, body)
  return createEventSubRequest(body, { ...overrides, messageId, timestamp, signature })
}

/**
 * 「不正入力が恒久エラー経路・業務処理へ到達しない」ことの共通アサーション。
 * 4xx（400系）であることと、handleApiError / reportError / 業務処理（ガチャ・
 * 通知・KV退避・重複排除記録）のいずれも呼ばれていないことを検証する。
 */
function expectRejectedWithoutSideEffects(response: Response): void {
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(response.status).toBeLessThan(500)
  expect(vi.mocked(handleApiError)).not.toHaveBeenCalled()
  expect(vi.mocked(reportError)).not.toHaveBeenCalled()
  expect(mocks.handleRedemption).not.toHaveBeenCalled()
  expect(mocks.handleRaidNotification).not.toHaveBeenCalled()
  expect(mocks.postRedemptionNotify).not.toHaveBeenCalled()
  expect(mocks.parkEventSubNotification).not.toHaveBeenCalled()
  expect(mocks.markEventSubMessageSeen).not.toHaveBeenCalled()
}

const redemptionNotificationPayload = {
  subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
  event: {
    broadcaster_user_id: 'broadcaster-1',
    user_id: 'viewer-1',
    user_login: 'viewer',
    user_name: 'Viewer',
    reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
  },
}

describe('EventSub 未署名・不正入力の防御（issue #1895）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TWITCH_EVENTSUB_SECRET = SECRET
    mocks.getMaintenanceState.mockReturnValue({ mode: 'off' })
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 1000,
      remaining: 999,
      reset: Date.now() + 1000,
    })
    mocks.isDuplicateEventSubMessage.mockResolvedValue(false)
    mocks.markEventSubMessageSeen.mockResolvedValue(undefined)
    mocks.handleRedemption.mockResolvedValue({ retryable: false })
    mocks.handleRaidNotification.mockResolvedValue({ retryable: false })
    mocks.parkEventSubNotification.mockResolvedValue(true)
  })

  describe('本文読取前のヘッダー・形式・時刻検査', () => {
    it('未署名（署名ヘッダー欠落）+ 不正JSON本文は400で応答し、恒久エラー経路へ流れない', async () => {
      const request = createEventSubRequest('this is not json', {
        omit: ['twitch-eventsub-message-signature'],
      })

      const response = await POST(request)

      // 旧実装では JSON.parse が先に走り handleApiError → 500 になっていた入力。
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'Invalid request' })
      expectRejectedWithoutSideEffects(response)
    })

    it.each([
      'twitch-eventsub-message-id',
      'twitch-eventsub-message-timestamp',
      'twitch-eventsub-message-type',
      'twitch-eventsub-message-signature',
    ])('必須ヘッダー %s の欠落は400（本文を読む前の事前検査）', async (headerName) => {
      const request = createEventSubRequest('{"subscription":{"type":"x"}}', {
        omit: [headerName],
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      expectRejectedWithoutSideEffects(response)
    })

    it('空の署名ヘッダー値は400として扱われる', async () => {
      const request = createEventSubRequest('{}', { signature: '' })

      const response = await POST(request)

      expect(response.status).toBe(400)
      expectRejectedWithoutSideEffects(response)
    })

    it.each([
      'sha256=short',
      `sha256=${'a'.repeat(63)}`,
      `sha256=${'a'.repeat(65)}`,
      `sha256=${'A'.repeat(64)}`,
      `sha256=${'g'.repeat(64)}`,
      `md5=${'a'.repeat(64)}`,
    ])('形式不正な署名値（%s）は403（本文読取前の形式検査）', async (signature) => {
      const request = createEventSubRequest('not json', { signature })

      const response = await POST(request)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: 'Invalid signature' })
      expectRejectedWithoutSideEffects(response)
    })

    it('偽署名（形式は正当だが値が不正）+ 不正JSON本文は403でJSON解析前に拒否される', async () => {
      const request = createEventSubRequest('this is not json', {
        signature: `sha256=${'1'.repeat(64)}`,
      })

      const response = await POST(request)

      // 旧実装では JSON.parse が先に走り handleApiError → 500 になっていた入力。
      expect(response.status).toBe(403)
      expectRejectedWithoutSideEffects(response)
    })

    it('期限外タイムスタンプ（正しい署名）は403で再送防御により処理へ進まない', async () => {
      const oldTimestamp = new Date(Date.now() - 11 * 60 * 1000).toISOString()
      const body = JSON.stringify(redemptionNotificationPayload)
      const messageId = 'eventsub-stale-1895'
      const signature = await signEventSubBody(messageId, oldTimestamp, body)

      const request = createEventSubRequest(body, {
        messageId,
        timestamp: oldTimestamp,
        signature,
      })

      const response = await POST(request)

      expect(response.status).toBe(403)
      expectRejectedWithoutSideEffects(response)
    })
  })

  describe('本文サイズ上限（Content-Length 非依存の stream 強制）', () => {
    // 16KiB 単位で chunk を供給し続ける追跡付き ReadableStream。
    // pull 回数と cancel の呼び出しを記録し、「上限超過時点で読取が中断された
    // こと（全量を読み切っていないこと）」を検証できるようにする。
    const CHUNK_SIZE = 16 * 1024

    function createTrackedOversizedStream(maxChunks = 40) {
      let pulled = 0
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1
          if (pulled > maxChunks) {
            controller.close()
            return
          }
          controller.enqueue(new Uint8Array(CHUNK_SIZE))
        },
        cancel() {
          cancelled = true
        },
      })
      return {
        stream,
        getPulled: () => pulled,
        isCancelled: () => cancelled,
        maxChunks,
      }
    }

    it('Content-Length 宣言なしの上限超過 stream は413で中断される', async () => {
      const tracked = createTrackedOversizedStream()

      const request = new NextRequest(EVENTSUB_URL, {
        method: 'POST',
        headers: buildEventSubHeaders(),
        body: tracked.stream,
        // Node/undici は stream body に duplex: 'half' を要求するが、Next の
        // RequestInit 型定義にこのフィールドが無いためアサーションで渡す
        // （型の signal 非互換も同時に回避される）。
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1])
      process.env.TWITCH_EVENTSUB_SECRET = SECRET

      const response = await POST(request)

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual({ error: 'Payload too large' })
      // 実際の読取バイト数で強制されているため、ごく一部を読んだ時点で中断される
      // （64KiB 上限に対し全量 640KiB の stream を読み切っていないことの証明）。
      expect(tracked.isCancelled()).toBe(true)
      expect(tracked.getPulled()).toBeLessThan(tracked.maxChunks)
      expectRejectedWithoutSideEffects(response)
    })

    it('Content-Length を過小宣言した上限超過 stream も413で中断される', async () => {
      const tracked = createTrackedOversizedStream()

      // 実際には 640KiB 流すが、Content-Length は 10 バイトと偽装する。
      // 上限強制が Content-Length に依存していないことの回帰ピン。
      const request = new NextRequest(EVENTSUB_URL, {
        method: 'POST',
        headers: buildEventSubHeaders({ extra: { 'content-length': '10' } }),
        body: tracked.stream,
        // duplex については上記テストと同じ理由でアサーションを使用。
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1])
      process.env.TWITCH_EVENTSUB_SECRET = SECRET

      const response = await POST(request)

      expect(response.status).toBe(413)
      expect(tracked.isCancelled()).toBe(true)
      expect(tracked.getPulled()).toBeLessThan(tracked.maxChunks)
      expectRejectedWithoutSideEffects(response)
    })

    it('上限ちょうど（64KiB）の署名済み本文は拒否されない（境界値）', async () => {
      // challenge の1文字を除いた余白を ASCII パディングで埋め、本文を
      // ちょうど 64KiB（= MAX_EVENTSUB_BODY_BYTES）にする。`>` 比較である
      // こと（上限ちょうどは許可されること）の回帰ピン。
      const overhead = JSON.stringify({ challenge: '' }).length
      const challenge = 'a'.repeat(64 * 1024 - overhead)
      const body = JSON.stringify({ challenge })
      expect(new TextEncoder().encode(body).length).toBe(64 * 1024)

      const messageId = 'eventsub-boundary-1895'
      const timestamp = new Date().toISOString()
      const signature = await signEventSubBody(messageId, timestamp, body)
      const request = createEventSubRequest(body, {
        messageId,
        timestamp,
        messageType: 'webhook_callback_verification',
        signature,
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe(challenge)
    })
  })

  describe('HMAC 検証成功後の JSON 解析', () => {
    it('正しい署名 + 不正JSON は400であり、500・handleApiError（恒久エラー）にならない', async () => {
      const body = 'this is not json'
      const request = await createSignedRequest(body)

      const response = await POST(request)

      // 旧実装では署名検証前に JSON.parse が失敗し handleApiError → 500 +
      // errorsテーブルINSERT（自動Issue化）となっていた。修正後は署名検証が
      // 先なので、この入力（署名は正しい＝Twitch由来のみ可能）は400に分類される。
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'Invalid request' })
      expect(vi.mocked(handleApiError)).not.toHaveBeenCalled()
      expect(vi.mocked(reportError)).not.toHaveBeenCalled()
      expect(mocks.handleRedemption).not.toHaveBeenCalled()
    })
  })

  describe('正当な Twitch 配信経路の維持', () => {
    it('署名済み notification は従来どおり handleRedemption で処理される', async () => {
      const body = JSON.stringify(redemptionNotificationPayload)
      const messageId = 'eventsub-normal-1895'
      const request = await createSignedRequest(body, { messageId })

      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.handleRedemption).toHaveBeenCalledTimes(1)
      expect(mocks.handleRedemption).toHaveBeenCalledWith(
        messageId,
        expect.objectContaining({ broadcaster_user_id: 'broadcaster-1' })
      )
      expect(mocks.markEventSubMessageSeen).toHaveBeenCalledWith(messageId)
    })

    it('署名済み challenge は challenge 文字列を 200 で返す', async () => {
      const challenge = 'challenge-token-1895'
      const body = JSON.stringify({ challenge })
      const request = await createSignedRequest(body, {
        messageType: 'webhook_callback_verification',
      })

      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/plain')
      await expect(response.text()).resolves.toBe(challenge)
    })

    it('重複 message-id の再送は 2xx で受領のみ行い業務処理をスキップする（再送防御）', async () => {
      mocks.isDuplicateEventSubMessage.mockResolvedValue(true)
      const body = JSON.stringify(redemptionNotificationPayload)
      const messageId = 'eventsub-dup-1895'
      const request = await createSignedRequest(body, { messageId })

      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.markEventSubMessageSeen).not.toHaveBeenCalled()
    })

    it('maintenance 中は KV へ退避して 2xx を返す（maintenance 退避の維持）', async () => {
      mocks.getMaintenanceState.mockReturnValue({ mode: 'read-only' })
      const body = JSON.stringify(redemptionNotificationPayload)
      const messageId = 'eventsub-maintenance-1895'
      const request = await createSignedRequest(body, { messageId })

      const response = await POST(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ received: true })
      expect(mocks.parkEventSubNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId,
          subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
          payload: redemptionNotificationPayload,
        })
      )
      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.markEventSubMessageSeen).toHaveBeenCalledWith(messageId)
    })
  })
})
