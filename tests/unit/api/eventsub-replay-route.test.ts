import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ERROR_MESSAGES, TWITCH_SUBSCRIPTION_TYPE } from '@/lib/constants'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import type { RedemptionNotifyData } from '@/lib/services/eventsub-redemption'
import type { ParkedEventSubRecord } from '@/lib/maintenance/eventsub-park'

const mocks = vi.hoisted(() => ({
  listParkedEventSubNotifications: vi.fn(),
  deleteParkedEventSubNotification: vi.fn(),
  claimChatNotificationBatch: vi.fn(),
  claimDueChatNotifications: vi.fn(),
  maintainChatNotificationOutbox: vi.fn(),
  advanceChatNotificationDeliveryCursor: vi.fn(),
  resolveChatNotificationDeliveryMode: vi.fn(),
  peekChatNotificationOutboxWork: vi.fn(),
  decodeChatNotificationPayload: vi.fn(),
  markChatNotificationSent: vi.fn(),
  renewChatNotificationLease: vi.fn(),
  deadLetterChatNotification: vi.fn(),
  retryChatNotification: vi.fn(),
  sendChatAnnouncement: vi.fn(),
  handleRedemption: vi.fn(),
  handleRaidNotification: vi.fn(),
  postRedemptionNotify: vi.fn(),
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  reportError: vi.fn(),
  logErrorFromLogger: vi.fn().mockResolvedValue(undefined),
  // Issue #1665: 新しいbounded配送経路は初期無効。postRedemptionNotifyは
  // enqueueChatNotificationWakeup単体の戻り値(outcome)だけでフラグを判定する。
  // 既定値('disabled')はbeforeEachで設定する（afterEachのvi.restoreAllMocks()が
  // 毎回実装を消すため）。未mockのままだと、vi.importActualで読み込む実
  // postRedemptionNotifyが@opennextjs/cloudflareの実import・
  // getCloudflareContext呼び出しへ到達し、vi.useFakeTimers()下で解決しない
  // Promiseを待ち続けてテストがtimeoutする。
  enqueueChatNotificationWakeup: vi.fn(),
  // Issue #1665 Step 3: 専用Queue経路が有効なあいだ、Cron relayはclaim→送信→
  // ackの旧ownerループへ入らず、dispatchDueChatNotifications（起床通知enqueue）
  // だけを行う。既定値(skippedDisabled=true=フラグ未設定)はbeforeEachで設定する。
  dispatchDueChatNotifications: vi.fn(),
}))

vi.mock('@/lib/maintenance/eventsub-park', () => ({
  listParkedEventSubNotifications: mocks.listParkedEventSubNotifications,
  deleteParkedEventSubNotification: mocks.deleteParkedEventSubNotification,
}))

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimChatNotificationBatch: mocks.claimChatNotificationBatch,
  claimDueChatNotifications: mocks.claimDueChatNotifications,
  maintainChatNotificationOutbox: mocks.maintainChatNotificationOutbox,
  advanceChatNotificationDeliveryCursor: mocks.advanceChatNotificationDeliveryCursor,
  peekChatNotificationOutboxWork: mocks.peekChatNotificationOutboxWork,
  decodeChatNotificationPayload: mocks.decodeChatNotificationPayload,
  markChatNotificationSent: mocks.markChatNotificationSent,
  renewChatNotificationLease: mocks.renewChatNotificationLease,
  deadLetterChatNotification: mocks.deadLetterChatNotification,
  retryChatNotification: mocks.retryChatNotification,
}))

vi.mock('@/lib/services/chat-notification-congestion', () => ({
  resolveChatNotificationDeliveryMode: mocks.resolveChatNotificationDeliveryMode,
}))

vi.mock('@/lib/services/chat-notification-dispatch', () => ({
  enqueueChatNotificationWakeup: mocks.enqueueChatNotificationWakeup,
  dispatchDueChatNotifications: mocks.dispatchDueChatNotifications,
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({ outcome: 'skipped', attempts: 0 }),
}))

vi.mock('@/lib/services/eventsub-redemption', () => ({
  handleRedemption: mocks.handleRedemption,
  handleRaidNotification: mocks.handleRaidNotification,
  postRedemptionNotify: mocks.postRedemptionNotify,
  sendChatAnnouncement: mocks.sendChatAnnouncement,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { eventsubReplay: {} },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: mocks.reportError,
  // logger.server のfire-and-forget永続化も同じhoisted fixtureで安全に完了させる。
  logErrorFromLogger: mocks.logErrorFromLogger,
}))

const TEST_SECRET = 'test-eventsub-replay-secret'

function createReplayRequest(
  body?: Record<string, unknown>,
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/eventsub-replay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-replay-secret': TEST_SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** テスト用: record.payload（unknown型）から event フィールドを取り出すヘルパー。 */
function payloadEventOf(record: ParkedEventSubRecord): unknown {
  return (record.payload as { event?: unknown } | null)?.event
}

function makeRecord(overrides: Partial<ParkedEventSubRecord> = {}): ParkedEventSubRecord {
  return {
    messageId: 'message-1',
    subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD,
    payload: {
      subscription: { type: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
      },
    },
    receivedAt: '2026-07-01T00:00:00.000Z',
    maintenanceMode: 'read-only',
    maintenanceOperationId: 'op-1',
    ...overrides,
  }
}

function makeChatOutboxClaim(payloadOverrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    batchId: 'chat-batch-1',
    leaseId: '22222222-2222-4222-8222-222222222222',
    attemptCount: 1,
    payloadVersion: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    payload: {
      batchId: 'chat-batch-1',
      broadcasterTwitchUserId: 'broadcaster-1',
      userId: 'viewer-1',
      streamer: {
        id: 'streamer-1',
        chat_announcement_enabled: true,
        chat_announcement_template: null,
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: false,
      },
      gachaResult: {
        type: 'gacha',
        userTwitchUsername: 'Viewer',
        card: {
          id: 'card-1', name: 'Alpha', description: null, image_url: null,
          rarity: 'rare', drop_rate: 1,
        },
        cards: [{
          id: 'card-1', name: 'Alpha', description: null, image_url: null,
          rarity: 'rare', drop_rate: 1,
        }],
        collectionName: 'Collection',
        ...payloadOverrides,
      },
      chatSnapshot: {
        cardCount: 1,
        uniqueCount: 1,
        allCount: 10,
        newCardNames: ['Alpha'],
      },
    }
  }
}

/** counts の完全一致比較用ヘルパー。新設カテゴリ(unknownType/invalidPayload/dispatched)は省略時0。 */
function expectedCounts(overrides: Partial<{
  succeeded: number
  skipped: number
  failed: number
  unknownType: number
  invalidPayload: number
  dispatched: number
  total: number
}>) {
  return {
    succeeded: 0,
    skipped: 0,
    failed: 0,
    unknownType: 0,
    invalidPayload: 0,
    dispatched: 0,
    total: 0,
    ...overrides,
  }
}

describe('POST /api/admin/eventsub-replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.EVENTSUB_REPLAY_SECRET = TEST_SECRET
    mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 })
    mocks.getRateLimitIdentifier.mockResolvedValue('ip:127.0.0.1')
    mocks.listParkedEventSubNotifications.mockResolvedValue({
      entries: [],
      cursor: undefined,
      listComplete: true,
    })
    mocks.deleteParkedEventSubNotification.mockResolvedValue(undefined)
    mocks.claimDueChatNotifications.mockReset()
    mocks.claimDueChatNotifications.mockResolvedValue([])
    // Issue #1665 Step 3 レビュー指摘(P2): 保持期限メンテナンスは配送ownerの分岐から
    // 分離され、relay（non-dry-run）が必ず1回呼ぶ。afterEachのrestoreAllMocksで
    // 実装が消えるため、claimと同じくbeforeEachで再設定する。
    mocks.maintainChatNotificationOutbox.mockReset()
    mocks.maintainChatNotificationOutbox.mockResolvedValue(undefined)
    mocks.peekChatNotificationOutboxWork.mockResolvedValue([])
    mocks.decodeChatNotificationPayload.mockImplementation((claim) => {
      const payload = claim?.payload
      return payload && typeof payload === 'object' && 'broadcasterTwitchUserId' in payload
        ? payload
        : null
    })
    mocks.markChatNotificationSent.mockResolvedValue(true)
    mocks.renewChatNotificationLease.mockReset()
    mocks.renewChatNotificationLease.mockResolvedValue(true)
    mocks.deadLetterChatNotification.mockResolvedValue(true)
    mocks.retryChatNotification.mockResolvedValue('pending')
    mocks.advanceChatNotificationDeliveryCursor.mockReset()
    mocks.advanceChatNotificationDeliveryCursor.mockResolvedValue(true)
    mocks.resolveChatNotificationDeliveryMode.mockReset()
    mocks.resolveChatNotificationDeliveryMode.mockImplementation(async (claim) => claim.deliveryMode)
    mocks.reportError.mockResolvedValue(undefined)
    // afterEachのvi.restoreAllMocks()が前testの実装を毎回消すため、
    // 他のmockと同じくbeforeEachで明示的に既定値を再設定する
    // （再設定を忘れるとdispatchResult.outcomeがundefinedになり、
    // 'disabled'との不一致でpostRedemptionNotifyが既存の同期経路へ
    // 一切進まなくなる）。
    mocks.enqueueChatNotificationWakeup.mockReset()
    mocks.enqueueChatNotificationWakeup.mockResolvedValue({ outcome: 'disabled' })
    // Issue #1665 Step 3: 既定はフラグ未設定（sweepは何も予約せず
    // skippedDisabled=true）。既存testはこの既定のまま旧claimループの
    // 挙動を検証する。
    mocks.dispatchDueChatNotifications.mockReset()
    mocks.dispatchDueChatNotifications.mockResolvedValue({
      reserved: 0,
      enqueued: 0,
      skippedDisabled: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    delete process.env.EVENTSUB_REPLAY_SECRET
  })

  describe('認証', () => {
    it('X-Replay-Secret ヘッダーが無い場合は403を返し、一覧取得を行わない', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const request = createReplayRequest({}, { 'x-replay-secret': '' })

      const response = await POST(request)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('X-Replay-Secret ヘッダーが一致しない場合は403を返す', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const request = createReplayRequest({}, { 'x-replay-secret': 'wrong-secret' })

      const response = await POST(request)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('EVENTSUB_REPLAY_SECRET が未設定の場合は500を返す（設定忘れによる不正アクセスを防ぐfail-closed）', async () => {
      delete process.env.EVENTSUB_REPLAY_SECRET
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const request = createReplayRequest({})

      const response = await POST(request)

      expect(response.status).toBe(500)
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })
  })

  describe('リクエストボディの型バリデーション（低-7）', () => {
    it('limit が数値以外（文字列）の場合は400 INVALID_REQUEST を返し、一覧取得を行わない', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      // JSON.parse を通すと limit は文字列型になり、TypeScript の ReplayRequestBody 型は
      // 実行時を保証しないため、意図的に不正な値をボディへ入れて実測する。
      const response = await POST(createReplayRequest({ limit: '20' as unknown as number }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.INVALID_REQUEST })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('limit が非整数（小数）の場合は400 INVALID_REQUEST を返す', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({ limit: 1.5 }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.INVALID_REQUEST })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('cursor が文字列以外（数値）の場合は400 INVALID_REQUEST を返す', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({ cursor: 123 as unknown as string }))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.INVALID_REQUEST })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('ボディが JSON の null の場合は400 INVALID_REQUEST を返す（nullはtypeofが"object"のため別途ガードが必要）', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const request = new NextRequest('http://localhost:3000/api/admin/eventsub-replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-replay-secret': TEST_SECRET },
        body: 'null',
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.INVALID_REQUEST })
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })
  })

  describe('dry-run モード', () => {
    it('実行せず、KV削除も行わない', async () => {
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-1', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({ dryRun: true }))
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.dryRun).toBe(true)
      expect(json.results).toEqual([
        expect.objectContaining({
          key: 'maintenance:eventsub:key-1',
          messageId: 'message-1',
          subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD,
          outcome: 'dry-run',
        }),
      ])
      expect(json.counts).toEqual(expectedCounts({ total: 1 }))
      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).not.toHaveBeenCalled()
    })
  })

  describe('transactional chat outbox の処理', () => {
    describe('paced delivery across live owner and relay', () => {
      function makePacedClaim(cursor = 0) {
        const cards = Array.from({ length: 10 }, (_, index) => ({
          id: `card-${index + 1}`, name: `Card ${index + 1}`, description: null,
          image_url: null, rarity: 'rare', drop_rate: 1,
        }))
        return {
          ...makeChatOutboxClaim({ card: cards[0], cards }),
          deliveryMode: 'individual' as const,
          deliveryChunkSize: 3,
          deliveryCursor: cursor,
        }
      }

      it('resumes at segment 7 in the relay after the live owner sends 6 then gets 429', async () => {
        vi.useFakeTimers()
        const claim = makePacedClaim()
        mocks.claimChatNotificationBatch.mockResolvedValue(claim)
        const successfulMessages: string[] = []
        let attempts = 0
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
          .mockImplementation(async (_broadcaster, message, options) => {
            expect(await options?.beforeExternalSend?.()).toBe(true)
            // Ack must not happen while any segment remains unsent or uncheckpointed.
            expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
            attempts += 1
            if (attempts === 7) return { outcome: 'retryable', reason: 'Twitch API 429' }
            successfulMessages.push(message)
            return { outcome: 'sent' }
          })
        const { postRedemptionNotify } = await vi.importActual<
          typeof import('@/lib/services/eventsub-redemption')
        >('@/lib/services/eventsub-redemption')
        const firstAttempt = postRedemptionNotify(claim.payload as RedemptionNotifyData)
        await vi.advanceTimersByTimeAsync(6 * 1600)
        await firstAttempt

        expect(claim.deliveryCursor).toBe(6)
        expect(mocks.retryChatNotification).toHaveBeenCalledExactlyOnceWith(claim, 'Twitch API 429')
        expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
        expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
        expect(mocks.reportError).not.toHaveBeenCalled()

        // A new owner receives the persisted checkpoint and the same snapshotted mode.
        const retryClaim = { ...claim, leaseId: 'relay-lease', attemptCount: 2 }
        mocks.claimDueChatNotifications.mockResolvedValueOnce([retryClaim]).mockResolvedValueOnce([])
        mocks.markChatNotificationSent.mockImplementationOnce(async (completedClaim) => {
          expect(completedClaim.deliveryCursor).toBe(10)
          expect(successfulMessages).toHaveLength(10)
          return true
        })
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const retry = POST(createReplayRequest({}))
        await vi.advanceTimersByTimeAsync(3 * 1600)
        const json = await (await retry).json()

        expect(send.mock.calls[7]?.[1]).toContain('7/10')
        expect(successfulMessages.map((message) => message.match(/ (\d+)\/10:/)?.[1]))
          .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
        expect(mocks.advanceChatNotificationDeliveryCursor.mock.calls.map(([, cursor]) => cursor))
          .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(mocks.renewChatNotificationLease).toHaveBeenCalledTimes(11)
        expect(mocks.markChatNotificationSent).toHaveBeenCalledExactlyOnceWith(retryClaim)
        expect(mocks.retryChatNotification).toHaveBeenCalledTimes(1)
        expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
        expect(json.results[0].outcome).toBe('succeeded')
      })

      it.each(['lost lease', 'storage exception'])('stops the relay on cursor %s before any later segment', async (failure) => {
        vi.useFakeTimers()
        const claim = makePacedClaim(6)
        mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
        if (failure === 'lost lease') {
          mocks.advanceChatNotificationDeliveryCursor.mockResolvedValueOnce(false)
        } else {
          mocks.advanceChatNotificationDeliveryCursor.mockRejectedValueOnce(new Error('cursor storage unavailable'))
        }
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
          .mockImplementation(async (_broadcaster, _message, options) => {
            expect(await options?.beforeExternalSend?.()).toBe(true)
            return { outcome: 'sent' }
          })
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const json = await (await POST(createReplayRequest({}))).json()

        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]?.[1]).toContain('7/10')
        expect(mocks.advanceChatNotificationDeliveryCursor).toHaveBeenCalledExactlyOnceWith(claim, 7)
        expect(claim.deliveryCursor).toBe(6)
        expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
        expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
        if (failure === 'lost lease') expect(mocks.retryChatNotification).not.toHaveBeenCalled()
        expect(json.results[0].outcome).toBe('failed')
      })

      it('does not send when resolving the initial delivery mode loses ownership', async () => {
        const claim = makePacedClaim()
        mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
        mocks.resolveChatNotificationDeliveryMode.mockResolvedValueOnce(null)
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const json = await (await POST(createReplayRequest({}))).json()

        expect(send).not.toHaveBeenCalled()
        expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
        expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
        expect(mocks.retryChatNotification).not.toHaveBeenCalled()
        expect(json.results[0]).toMatchObject({ outcome: 'failed', error: 'Chat delivery mode update lost its lease' })
      })

      it('checks the lease again before the next segment and aborts without ack or retry when lost', async () => {
        vi.useFakeTimers()
        const claim = makePacedClaim(6)
        mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
        mocks.renewChatNotificationLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
        const messages: string[] = []
        vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
          .mockImplementation(async (_broadcaster, message, options) => {
            if (!await options?.beforeExternalSend?.()) {
              return { outcome: 'aborted', reason: 'chat delivery ownership lost before send' }
            }
            messages.push(message)
            return { outcome: 'sent' }
          })
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const pending = POST(createReplayRequest({}))
        await vi.advanceTimersByTimeAsync(1600)
        const json = await (await pending).json()

        expect(messages).toHaveLength(1)
        expect(messages[0]).toContain('7/10')
        expect(claim.deliveryCursor).toBe(7)
        expect(mocks.renewChatNotificationLease).toHaveBeenCalledTimes(2)
        expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
        expect(mocks.retryChatNotification).not.toHaveBeenCalled()
        expect(json.results[0].outcome).toBe('failed')
      })

      it('only acknowledges a completed cursor and reports a lost final lease without resending', async () => {
        const claim = makePacedClaim(10)
        mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
        mocks.markChatNotificationSent.mockResolvedValueOnce(false)
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const json = await (await POST(createReplayRequest({}))).json()

        expect(send).not.toHaveBeenCalled()
        expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
        expect(mocks.advanceChatNotificationDeliveryCursor).not.toHaveBeenCalled()
        expect(mocks.markChatNotificationSent).toHaveBeenCalledExactlyOnceWith(claim)
        expect(json.results[0]).toMatchObject({ outcome: 'failed', error: 'sent, but outbox ack lost its lease' })
        expect(mocks.reportError).toHaveBeenCalledTimes(1)
      })
    })

    it('chat送信成功時はowner-fenced sentへ更新する', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent' })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.sendChatAnnouncement).toHaveBeenCalledTimes(1)
      expect(mocks.sendChatAnnouncement).toHaveBeenCalledWith(
        'broadcaster-1',
        expect.any(Object),
        expect.objectContaining({ id: 'card-1' }),
        'Viewer',
        'viewer-1',
        expect.any(Array),
        'Collection',
        {
          cardCount: 1,
          uniqueCount: 1,
          allCount: 10,
          newCardNames: ['Alpha'],
        },
        expect.any(Function),
      )
      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(claim)
      expect(json.results[0].outcome).toBe('succeeded')
    })

    // issue #842/#843: Twitchが同一本文を抑止した場合（msg_duplicate）は障害ではないため、
    // sendChatAnnouncement が 'skipped' を返す。DLQ送りにもエラー報告にもせずackすること。
    // ここが retryable へ落ちると、Twitchが必ず再拒否する本文を再試行し続ける。
    it('Twitchが重複として抑止した場合はDLQに送らずackする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'skipped' })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(claim)
      expect(mocks.deadLetterChatNotification).not.toHaveBeenCalled()
      expect(mocks.retryChatNotification).not.toHaveBeenCalled()
      expect(json.results[0].outcome).toBe('skipped')
    })

    it('fallback送信成功はackを維持し、credential degradationを1回だけreportする', async () => {
      const claim = makeChatOutboxClaim()
      const degradation = {
        code: 'credential_unavailable',
        reason: 'configured BOT credential requires reauthorization',
      }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent', degradation })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(claim)
      expect(mocks.deadLetterChatNotification).not.toHaveBeenCalled()
      expect(mocks.retryChatNotification).not.toHaveBeenCalled()
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('fallback sender') }),
        expect.objectContaining({ messageId: claim.batchId, degradation }),
      )
      expect(json.results[0].outcome).toBe('succeeded')
    })

    // BOT恒久失効(degradation)は成功縮退だけでなく失敗系outcomeにも付与される。
    // token-managerが永続報告を境界へ委ねる契約のため、失敗系でdegradationを
    // 読み落とすと「設定BOTが要再認証」の直接シグナルがどこにも残らない。
    it('terminal失敗に付随するcredential degradationをDLQ reasonとreportへ畳み込む', async () => {
      const claim = makeChatOutboxClaim()
      const degradation = {
        code: 'credential_unavailable',
        reason: 'configured BOT credential requires reauthorization',
      }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'terminal',
        code: 'credential_unavailable',
        reason: 'chat sender access token unavailable',
        degradation,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      const expectedReason =
        'chat sender access token unavailable; sender degraded: configured BOT credential requires reauthorization'
      expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(claim, expectedReason)
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('sender degraded') }),
        expect.objectContaining({ messageId: claim.batchId, degradation }),
      )
      expect(json.results[0]).toMatchObject({ outcome: 'failed', error: `DLQ: ${expectedReason}` })
    })

    it('retryable失敗のdead化にもcredential degradationを畳み込んでreportする', async () => {
      const claim = makeChatOutboxClaim()
      const degradation = {
        code: 'credential_unavailable',
        reason: 'configured BOT credential requires reauthorization',
      }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'retryable',
        reason: 'unable to verify user:write:chat scope',
        degradation,
      })
      mocks.retryChatNotification.mockResolvedValueOnce('dead')

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      const expectedReason =
        'unable to verify user:write:chat scope; sender degraded: configured BOT credential requires reauthorization'
      expect(mocks.retryChatNotification).toHaveBeenCalledWith(claim, expectedReason)
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('sender degraded') }),
        expect.objectContaining({ messageId: claim.batchId, state: 'dead', degradation }),
      )
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.results[0]).toMatchObject({ outcome: 'failed', error: `dead: ${expectedReason}` })
    })

    it('外部送信開始期限内に開始済みなら、遅延成功をroute deadlineまで待って1回だけackする', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])

      let resolveSend: (() => void) | undefined
      const sendFinished = new Promise<void>((resolve) => { resolveSend = resolve })
      let entered: (() => void) | undefined
      const enteredSend = new Promise<void>((resolve) => { entered = resolve })
      mocks.sendChatAnnouncement.mockImplementationOnce(async (...args) => {
        const beforeExternalSend = args.at(-1) as () => Promise<boolean>
        // 15秒reserve前に開始した送信は、後続のHelix応答をrouteが待つ。
        await expect(beforeExternalSend()).resolves.toBe(true)
        entered?.()
        await sendFinished
        return { outcome: 'sent' }
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const responsePromise = POST(createReplayRequest({}))
      await enteredSend
      // 開始後に時間が進んでも、開始済み送信の成功とackを捨てない。
      vi.setSystemTime(new Date(104_999))
      resolveSend?.()
      const json = await (await responsePromise).json()

      expect(mocks.renewChatNotificationLease).toHaveBeenCalledWith(claim)
      expect(mocks.markChatNotificationSent).toHaveBeenCalledTimes(1)
      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(claim)
      expect(json.counts).toEqual(expectedCounts({ succeeded: 1, total: 1 }))
    })

    it('15秒reserve後は外部送信を開始せず、lease更新・ackをせず次tickへ残す', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockImplementationOnce(async (...args) => {
        const beforeExternalSend = args.at(-1) as () => Promise<boolean>
        // route本体の105秒deadlineではなく、15秒reserveを引いた開始期限を越える。
        vi.setSystemTime(new Date(90_000))
        expect(await beforeExternalSend()).toBe(false)
        return { outcome: 'aborted', reason: 'chat delivery ownership lost before send' }
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.renewChatNotificationLease).not.toHaveBeenCalled()
      expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
      expect(json.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'chat delivery ownership lost before send',
      })
    })

    it('renew中に開始期限を越えた場合も、renew後の再確認で外部送信とackを止める', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
      mocks.renewChatNotificationLease.mockImplementationOnce(async () => {
        // 先行チェックは通過したが、DB lease更新中に15秒reserve境界を越えた。
        vi.setSystemTime(new Date(90_000))
        return true
      })
      mocks.sendChatAnnouncement.mockImplementationOnce(async (...args) => {
        const beforeExternalSend = args.at(-1) as () => Promise<boolean>
        expect(await beforeExternalSend()).toBe(false)
        return { outcome: 'aborted', reason: 'chat delivery ownership lost before send' }
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.renewChatNotificationLease).toHaveBeenCalledWith(claim)
      expect(mocks.markChatNotificationSent).not.toHaveBeenCalled()
      expect(json.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'chat delivery ownership lost before send',
      })
    })

    it('送信成功後にack leaseを失った場合は成功表示せずreportする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent' })
      mocks.markChatNotificationSent.mockResolvedValue(false)

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(json.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'sent, but outbox ack lost its lease',
      })
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['503', 'Twitch API 503'],
      ['network', 'ECONNRESET'],
    ])('%s一時失敗はbackoff付きpendingへ戻し、上位でもreportしない', async (_label, reason) => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'retryable', reason })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.retryChatNotification).toHaveBeenCalledWith(claim, reason)
      expect(json.results[0]).toMatchObject({ outcome: 'failed', error: `pending: ${reason}` })
      expect(mocks.reportError).not.toHaveBeenCalled()
    })

    it('本人token DB障害はreplayでpendingへ戻し、途中経過をreportしない', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'retryable',
        reason: 'chat sender credential is temporarily unavailable',
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.retryChatNotification).toHaveBeenCalledWith(
        claim,
        'chat sender credential is temporarily unavailable',
      )
      expect(json.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'pending: chat sender credential is temporarily unavailable',
      })
      expect(mocks.reportError).not.toHaveBeenCalled()
    })

    it('scope確認不能が再試行上限へ達した場合はdead化をreportする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'retryable',
        reason: 'unable to verify user:write:chat scope',
      })
      mocks.retryChatNotification.mockResolvedValueOnce('dead')

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.retryChatNotification).toHaveBeenCalledWith(
        claim,
        'unable to verify user:write:chat scope',
      )
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('exhausted retries') }),
        expect.objectContaining({ messageId: claim.batchId, state: 'dead' }),
      )
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'dead: unable to verify user:write:chat scope',
      })
    })

    it.each([
      'configured BOT credential is temporarily unavailable',
      'chat sender credential is temporarily unavailable',
      'Twitch API 503',
      'ECONNRESET',
    ])('%sが再試行上限へ達した場合はdead化をreportする', async (reason) => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'retryable', reason })
      mocks.retryChatNotification.mockResolvedValueOnce('dead')

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.retryChatNotification).toHaveBeenCalledWith(claim, reason)
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('exhausted retries') }),
        expect.objectContaining({ messageId: claim.batchId, state: 'dead' }),
      )
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.results[0]).toMatchObject({ outcome: 'failed', error: `dead: ${reason}` })
    })

    it('送信直前fence喪失のabortedはoutboxを上書きせずreportする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'aborted',
        reason: 'chat delivery ownership lost before send',
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      await POST(createReplayRequest({}))

      expect(mocks.deadLetterChatNotification).not.toHaveBeenCalled()
      expect(mocks.retryChatNotification).not.toHaveBeenCalled()
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('chat delivery aborted') }),
        expect.objectContaining({ messageId: claim.batchId }),
      )
    })

    it('恒久失敗は即DLQ化し、後続claimを塞がない', async () => {
      const terminal = makeChatOutboxClaim()
      const success = { ...makeChatOutboxClaim(), id: '33333333-3333-4333-8333-333333333333', batchId: 'chat-batch-2' }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([success])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement
        .mockResolvedValueOnce({ outcome: 'terminal', code: 'twitch_rejected', reason: 'AutoMod rejected' })
        .mockResolvedValueOnce({ outcome: 'sent' })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(terminal, 'AutoMod rejected')
      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(success)
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.results.map((result: { outcome: string }) => result.outcome)).toEqual(['failed', 'succeeded'])
    })

    it('content_rejectedはDLQ化するが自動Issue化しない (#1725)', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'terminal',
        code: 'content_rejected',
        reason: 'Twitch API 200: The message was held by AutoMod.',
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(
        claim,
        'Twitch API 200: The message was held by AutoMod.',
      )
      expect(mocks.reportError).not.toHaveBeenCalled()
      expect(json.results.map((result: { outcome: string }) => result.outcome)).toEqual(['failed'])
    })

    it('missing_scopeでもDLQ更新がleaseを失った場合は運用障害としてreportする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'terminal',
        code: 'missing_scope',
        reason: 'user:write:chat scope not granted',
      })
      mocks.deadLetterChatNotification.mockResolvedValueOnce(false)

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      await POST(createReplayRequest({}))

      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('DLQ update lost its lease') }),
        expect.objectContaining({ persisted: false }),
      )
    })

    it('DLQ更新自体がthrowした場合はpendingへ戻してreportする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'terminal',
        code: 'missing_scope',
        reason: 'user:write:chat scope not granted',
      })
      mocks.deadLetterChatNotification.mockRejectedValueOnce(new Error('database unavailable'))

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      await POST(createReplayRequest({}))

      expect(mocks.retryChatNotification).toHaveBeenCalledWith(claim, 'database unavailable')
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('transactional chat relay failed') }),
        expect.objectContaining({ messageId: claim.batchId, state: 'pending' }),
      )
    })

    it('恒久失敗20件を1 tickあたり5件ずつDLQ化し、後続tickで21件目を配送する', async () => {
      const terminalClaims = Array.from({ length: 20 }, (_, index) => {
        const claim = makeChatOutboxClaim()
        return {
          ...claim,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          batchId: `terminal-batch-${index + 1}`,
        }
      })
      const twentyFirst = {
        ...makeChatOutboxClaim(),
        id: '99999999-9999-4999-8999-999999999999',
        batchId: 'success-batch-21',
      }
      for (const terminal of terminalClaims) {
        mocks.claimDueChatNotifications.mockResolvedValueOnce([terminal])
      }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([twentyFirst])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({
        outcome: 'terminal',
        code: 'missing_scope',
        reason: 'user:write:chat scope not granted',
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      for (let tick = 0; tick < 4; tick += 1) {
        const result = await (await POST(createReplayRequest({ limit: 20 }))).json()
        // 1 requestは外部I/O timeoutとKV relayの公平性を守るため5件だけ処理する。
        expect(result.counts).toEqual(expectedCounts({ failed: 5, total: 5 }))
      }
      expect(mocks.deadLetterChatNotification).toHaveBeenCalledTimes(20)
      // 既知のユーザー再認証待ちはDLQ監査を残すが、自動Issue化しない。
      expect(mocks.reportError).not.toHaveBeenCalled()

      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent' })
      const second = await (await POST(createReplayRequest({ limit: 20 }))).json()

      // 保持期限メンテナンスはrelay本体の分離実行へ移ったため、claim側では行わない
      // （実行回数はmaintainChatNotificationOutbox側で検証する）。
      expect(mocks.claimDueChatNotifications).toHaveBeenNthCalledWith(
        21,
        1,
        { maintain: false },
      )
      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(twentyFirst)
      expect(second.counts).toEqual(expectedCounts({ succeeded: 1, total: 1 }))
    })

    it('maintenance KV一覧取得が失敗しても、その前にDB outboxを配送・ackする', async () => {
      const claim = makeChatOutboxClaim()
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])
      mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent' })
      mocks.listParkedEventSubNotifications.mockRejectedValue(new Error('KV unavailable'))

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')

      await expect(POST(createReplayRequest({}))).rejects.toThrow('KV unavailable')
      expect(mocks.sendChatAnnouncement).toHaveBeenCalledTimes(1)
      expect(mocks.markChatNotificationSent).toHaveBeenCalledWith(claim)
    })

    it('不正outbox payloadはinvalid-payloadとしてreportしDLQ化する', async () => {
      const claim = { ...makeChatOutboxClaim(), payload: { batchId: 'missing-required-fields' } }
      mocks.claimDueChatNotifications
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([])

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(json.results[0].outcome).toBe('invalid-payload')
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(mocks.deadLetterChatNotification).toHaveBeenCalledWith(
        claim,
        'transactional chat outbox payload v1 is invalid',
      )
      expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
    })

    it('dry-runはDB outboxをclaimしない', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      await POST(createReplayRequest({ dryRun: true }))
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
    })

    it('KVが空でもdry-run peekにDB-only pendingを返しCron実relayを起動できる', async () => {
      mocks.peekChatNotificationOutboxWork.mockResolvedValue([{
        id: '77777777-7777-4777-8777-777777777777',
        batchId: 'db-only-batch',
        createdAt: '2026-07-01T00:00:00.000Z',
      }])

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({ dryRun: true, limit: 1 }))).json()

      expect(json.results).toEqual([
        expect.objectContaining({
          key: 'chat-outbox:77777777-7777-4777-8777-777777777777',
          messageId: 'db-only-batch',
          outcome: 'dry-run',
        }),
      ])
      expect(mocks.peekChatNotificationOutboxWork).toHaveBeenCalledWith(1)
      expect(mocks.listParkedEventSubNotifications).toHaveBeenCalledTimes(1)
    })
  })

  describe('専用Queue経路有効時の配送owner一本化（Issue #1665 Step 3）', () => {
    it('sweepがdue行を予約・enqueueしたら、旧ownerのclaimループへ入らずdispatchedだけを記録する', async () => {
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 3,
        enqueued: 3,
        skippedDisabled: false,
      })
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-1', record }],
        cursor: undefined,
        listComplete: true,
      })
      mocks.handleRedemption.mockResolvedValue({ notify: null, retryable: false })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({ limit: 100 }))).json()

      // 25件の内部sweep上限を維持しつつ、request limitが十分な場合の値を確認する。
      expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(25, 120)
      // 旧owner（claim→送信→ack）は一切動かない。
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimChatNotificationBatch).not.toHaveBeenCalled()
      // handoff後もKV backlogの処理は同じrequestで続行する。
      expect(json.results).toEqual([
        expect.objectContaining({
          key: 'chat-outbox:dispatch-due',
          outcome: 'dispatched',
        }),
        expect.objectContaining({ key: 'maintenance:eventsub:key-1', outcome: 'skipped' }),
      ])
      expect(json.counts).toEqual(expectedCounts({ dispatched: 1, skipped: 1, total: 2 }))
    })

    it('request limitが2件ならsweepを2件に制限し、2行を予約した場合はKV一覧を呼ばない', async () => {
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 2,
        enqueued: 2,
        skippedDisabled: false,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({ limit: 2 }))).json()

      expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(2, 120)
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
      expect(json.results).toEqual([
        expect.objectContaining({ key: 'chat-outbox:dispatch-due', outcome: 'dispatched' }),
      ])
      expect(json.counts).toEqual(expectedCounts({ dispatched: 1, total: 1 }))
    })

    it('enqueue失敗分も予約行としてrequest limitを消費し、残り1件だけKV一覧を読む', async () => {
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 2,
        enqueued: 1,
        skippedDisabled: false,
      })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({ limit: 3 }))).json()

      expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(3, 120)
      expect(mocks.listParkedEventSubNotifications).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 1,
      })
      expect(json.results).toEqual([
        expect.objectContaining({
          key: 'chat-outbox:dispatch-due',
          outcome: 'dispatched',
          error: 'enqueued 1 of 2 reserved rows; remainder stays pending',
        }),
      ])
      expect(json.counts).toEqual(expectedCounts({ dispatched: 1, total: 1 }))
    })

    it('sweepが0件を予約したときはdispatchedエントリを出さない（Cronログのノイズ回避）', async () => {
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 0,
        enqueued: 0,
        skippedDisabled: false,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(json.results).toEqual([])
      expect(json.counts).toEqual(expectedCounts({}))
    })

    it('enqueueが一部失敗しても旧ループへフォールバックせず、件数をerrorに残してpendingのまま残す', async () => {
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 3,
        enqueued: 1,
        skippedDisabled: false,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(json.results).toEqual([
        expect.objectContaining({
          outcome: 'dispatched',
          error: 'enqueued 1 of 3 reserved rows; remainder stays pending',
        }),
      ])
    })

    it('sweep自体がthrowしても旧ownerへフォールバックせず、行はpendingのまま残す', async () => {
      mocks.dispatchDueChatNotifications.mockRejectedValueOnce(
        new Error('wake reservation storage unavailable'),
      )

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))

      expect(response.status).toBe(200)
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimChatNotificationBatch).not.toHaveBeenCalled()
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('chat dispatch sweep failed'),
        }),
        expect.objectContaining({ key: 'chat-outbox:dispatch-due' }),
      )
    })

    it('dispatch無効（既定）なら従来のclaimループがそのまま動く', async () => {
      const cards = Array.from({ length: 3 }, (_, index) => ({
        id: `card-${index + 1}`, name: `Card ${index + 1}`, description: null,
        image_url: null, rarity: 'rare', drop_rate: 1,
      }))
      const claim = {
        ...makeChatOutboxClaim({ card: cards[0], cards }),
        deliveryMode: 'individual' as const,
        deliveryChunkSize: 3,
        deliveryCursor: 0,
      }
      mocks.claimDueChatNotifications.mockResolvedValueOnce([claim]).mockResolvedValueOnce([])
      const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
        .mockImplementation(async (_broadcaster, _message, options) => {
          expect(await options?.beforeExternalSend?.()).toBe(true)
          return { outcome: 'sent' }
        })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.dispatchDueChatNotifications).toHaveBeenCalledWith(20, 120)
      expect(mocks.claimDueChatNotifications).toHaveBeenCalledWith(1, { maintain: false })
      expect(mocks.maintainChatNotificationOutbox).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledTimes(3)
      expect(mocks.markChatNotificationSent).toHaveBeenCalledTimes(1)
      expect(json.results.some((entry: { outcome: string }) => entry.outcome === 'dispatched')).toBe(false)
      expect(json.results[0].outcome).toBe('succeeded')
    })

    // Issue #1665 Step 3 レビュー指摘(P2)の回帰。Queue経路へ配送ownerを
    // 引き継いだ後も、保持期限メンテナンス（試行上限到達行のdead化 + sent/deadの
    // 保持期限削除）が止まらないことを固定する。旧claimループへは入らないまま
    // （二重owner防止）、メンテナンスだけは owner 分岐に関係なく実行される。
    it('Queue経路が配送ownerでも保持期限メンテナンスを1回実行し、旧claimとTwitch送信を行わない', async () => {
      const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
      mocks.dispatchDueChatNotifications.mockResolvedValueOnce({
        reserved: 2,
        enqueued: 2,
        skippedDisabled: false,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({}))).json()

      expect(mocks.maintainChatNotificationOutbox).toHaveBeenCalledTimes(1)
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimChatNotificationBatch).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect(json.results).toEqual([
        expect.objectContaining({ key: 'chat-outbox:dispatch-due', outcome: 'dispatched' }),
      ])
    })

    it('sweepがthrowして旧ownerへフォールバックしない場合でも保持期限メンテナンスは実行する', async () => {
      mocks.dispatchDueChatNotifications.mockRejectedValueOnce(
        new Error('wake reservation storage unavailable'),
      )

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))

      expect(response.status).toBe(200)
      expect(mocks.maintainChatNotificationOutbox).toHaveBeenCalledTimes(1)
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
    })

    it('dry-runでは保持期限メンテナンスも旧claimも実行しない', async () => {
      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const json = await (await POST(createReplayRequest({ dryRun: true }))).json()

      expect(mocks.maintainChatNotificationOutbox).not.toHaveBeenCalled()
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
      expect(json.results).toEqual([])
    })

    // Issue #1665 Step 3 の追加必須(P2): 切り出したmaintenance待ちにも共通deadline
    // （105秒 = EVENTSUB_REPLAY_BUDGET_MS）をかけ、時間切れなら sweep / 旧claim /
    // KV replay を新規に開始しない。dispatchDueChatNotifications(...) は引数評価の
    // 時点で開始されるため「deadline helperで包むだけ」では開始を防げず、明示gateが要る。
    // Queue有効（handoff成立）／無効（skippedDisabled）の両方で固定する。
    it.each(['handoff', 'disabled'] as const)(
      'maintenanceが共通deadlineを超えたらPOSTは返り、%sでも新規workを開始しない',
      async (mode) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(0))
        mocks.dispatchDueChatNotifications.mockResolvedValue(
          mode === 'handoff'
            ? { reserved: 2, enqueued: 2, skippedDisabled: false }
            : { reserved: 0, enqueued: 0, skippedDisabled: true },
        )
        mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])
        // KV replay が開始されたら検知できるよう、対象を返すようにしておく。
        mocks.listParkedEventSubNotifications.mockResolvedValue({
          entries: [{ key: 'maintenance:eventsub:deadline', record: makeRecord() }],
          cursor: undefined,
          listComplete: true,
        })
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')

        let enteredMaintenance: (() => void) | undefined
        const entered = new Promise<void>((resolve) => { enteredMaintenance = resolve })
        let resolveMaintenance: (() => void) | undefined
        mocks.maintainChatNotificationOutbox.mockImplementation(
          () => new Promise<void>((resolve) => {
            resolveMaintenance = resolve
            enteredMaintenance?.()
          }),
        )

        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const responsePromise = POST(createReplayRequest({}))
        await entered
        // 非協調的なDB待ちで共通deadlineを越える。
        await vi.advanceTimersByTimeAsync(105_000)
        const response = await responsePromise
        const json = await response.json()

        expect(response.status).toBe(200)
        expect(json.counts).toEqual(expectedCounts({}))
        expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()

        // 時間切れ後にmaintenanceが完了しても、このrequestで新規配送は始まらない。
        resolveMaintenance?.()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
      },
    )

    it.each([105_000, 105_001])(
      '入口で既に期限切れ（%dms）ならmaintenance自体を開始せず、後続workも開始しない',
      async (elapsedMs) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(0))
        // deadline は POST 冒頭（Date.now() + 105秒 = 105_000）で確定する。その後の
        // レート制限待ちで時計が 105_000（ちょうど）/ 105_001（1ms 後）へ進み、
        // maintenance地点では期限を過ぎている。境界の両側で、期限確認より先に
        // operation を開始しないことを固定する。
        mocks.checkRateLimit.mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(elapsedMs))
          return { success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 }
        })
        mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])
        mocks.listParkedEventSubNotifications.mockResolvedValue({
          entries: [{ key: 'maintenance:eventsub:expired', record: makeRecord() }],
          cursor: undefined,
          listComplete: true,
        })
        const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')

        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const response = await POST(createReplayRequest({}))
        const json = await response.json()

        expect(response.status).toBe(200)
        // 残り時間0でhelperが早期returnする経路へ未解決Promiseを渡さない（開始前チェック）。
        expect(mocks.maintainChatNotificationOutbox).not.toHaveBeenCalled()
        expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(json.counts).toEqual(expectedCounts({}))
      },
    )

    it('時間切れ後にmaintenanceがrejectしても未処理rejectionにならず、新規workも開始しない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])

      let enteredMaintenance: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredMaintenance = resolve })
      let rejectMaintenance: ((error: Error) => void) | undefined
      mocks.maintainChatNotificationOutbox.mockImplementation(
        () => new Promise<void>((_resolve, reject) => {
          rejectMaintenance = reject
          enteredMaintenance?.()
        }),
      )

      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      try {
        const { POST } = await import('@/app/api/admin/eventsub-replay/route')
        const responsePromise = POST(createReplayRequest({}))
        await entered
        await vi.advanceTimersByTimeAsync(105_000)
        const response = await responsePromise

        // 応答後にmaintenanceが失敗しても、未処理rejectionにせず（常時catch）、
        // 新規workを開始しない。行は次tickのmaintenanceが回収する。
        rejectMaintenance?.(new Error('late maintenance failure'))
        await vi.advanceTimersByTimeAsync(1_000)
        await Promise.resolve()

        expect(response.status).toBe(200)
        expect(unhandled).toEqual([])
        expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
        expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    // 切り出し前は claim ループの try/catch の内側にあり、メンテナンス失敗でも
    // 同じ tick の後続処理（回収sweep・旧claim・KVに退避された EventSub
    // notification の replay）は継続していた。切り出し後もその契約を維持する。
    it('maintenanceのDBエラーでrelay tick全体を500にせず、KV退避のdrainを継続する', async () => {
      mocks.maintainChatNotificationOutbox.mockRejectedValue(
        new Error('maintenance db unavailable'),
      )
      mocks.dispatchDueChatNotifications.mockResolvedValue({
        reserved: 0, enqueued: 0, skippedDisabled: true,
      })
      mocks.claimDueChatNotifications.mockResolvedValue([])
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:survives', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))

      expect(response.status).toBe(200)
      // DB非依存の KV drain は同じ tick で走り続ける。
      expect(mocks.listParkedEventSubNotifications).toHaveBeenCalled()
    })

    // レビュー指摘 P2: 二次報告（reportErrorSafely→reportError は errors への DB insert を
    // await する）も共通deadlineの内側に置く。報告先が詰まっても POST は期限で有界に返り、
    // 期限後に報告が完了しても dispatch/旧claim/KV replay を新規に開始しない。
    it('maintenanceがrejectし二次報告が応答しなくても、POSTは期限で有界に返り後続workを開始しない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      mocks.maintainChatNotificationOutbox.mockRejectedValue(
        new Error('maintenance db unavailable'),
      )
      mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:report-hang', record: makeRecord() }],
        cursor: undefined,
        listComplete: true,
      })
      const send = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')

      let enteredReport: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredReport = resolve })
      let resolveReport: (() => void) | undefined
      mocks.reportError.mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveReport = resolve
          enteredReport?.()
        }),
      )

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const responsePromise = POST(createReplayRequest({}))
      await entered
      // 報告が応答しないまま共通deadline（105秒）を越える。
      await vi.advanceTimersByTimeAsync(105_000)
      const response = await responsePromise
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.counts).toEqual(expectedCounts({}))
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()

      // 期限後に報告が完了しても、このrequestで新規workは始まらない。
      resolveReport?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    it('二次報告が期限後に完了した場合も、後続のdispatch・旧claimを開始しない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      mocks.maintainChatNotificationOutbox.mockRejectedValue(
        new Error('maintenance db unavailable'),
      )
      mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])

      // 期限内に報告を開始し、完了時に時計が期限を越えている経路。
      // （時計操作はマイクロタスクへ遅延させる: helper が remainingMs を計算した後に
      //   期限を越えることで、「期限後に完了」の実時間軸を再現する。）
      mocks.reportError.mockImplementation(async () => {
        await Promise.resolve()
        vi.setSystemTime(new Date(106_000))
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.counts).toEqual(expectedCounts({}))
      expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })

    // 正常経路（maintenance成功）でも、完了時点で期限を越えていれば後続を開始しない。
    // dispatchDueChatNotifications(...) は引数評価で開始されるため、sweep 側の時刻確認が要る。
    it('maintenanceは完了したが期限を越えていた場合、sweep・旧claimを開始しない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(0))
      mocks.maintainChatNotificationOutbox.mockImplementation(async () => {
        // 期限内に開始し、完了時に時計が期限を越えている経路（時計操作は helper の
        // remainingMs 計算後に走らせる）。
        await Promise.resolve()
        vi.setSystemTime(new Date(106_000))
      })
      mocks.dispatchDueChatNotifications.mockResolvedValue({
        reserved: 1, enqueued: 1, skippedDisabled: false,
      })
      mocks.claimDueChatNotifications.mockResolvedValue([makeChatOutboxClaim()])

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(mocks.maintainChatNotificationOutbox).toHaveBeenCalledTimes(1)
      expect(json.counts).toEqual(expectedCounts({}))
      expect(mocks.dispatchDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.claimDueChatNotifications).not.toHaveBeenCalled()
      expect(mocks.listParkedEventSubNotifications).not.toHaveBeenCalled()
    })
  })

  describe('CHANNEL_POINTS_REDEMPTION_ADD の処理', () => {
    it('成功時はpostRedemptionNotifyを呼び、KVエントリを削除する', async () => {
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-1', record }],
        cursor: undefined,
        listComplete: true,
      })
      const gachaResult = { gachaResult: { type: 'gacha' }, broadcasterTwitchUserId: 'broadcaster-1', streamer: { id: 's1' }, userId: 'viewer-1' }
      mocks.handleRedemption.mockResolvedValue({ notify: gachaResult, retryable: false })
      mocks.postRedemptionNotify.mockResolvedValue(undefined)

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRedemption).toHaveBeenCalledWith('message-1', payloadEventOf(record))
      expect(mocks.postRedemptionNotify).toHaveBeenCalledWith(
        gachaResult,
        expect.objectContaining({ externalSendDeadlineAt: expect.any(Number) }),
      )
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-1')
      expect(json.results[0].outcome).toBe('succeeded')
      expect(json.counts).toEqual(expectedCounts({ succeeded: 1, total: 1 }))
    })

    it('{notify: null, retryable: false}（重複/報酬不一致等の確定的な終端結果）の場合はskip扱いでKVエントリを削除する', async () => {
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-1', record }],
        cursor: undefined,
        listComplete: true,
      })
      mocks.handleRedemption.mockResolvedValue({ notify: null, retryable: false })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.postRedemptionNotify).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-1')
      expect(json.results[0].outcome).toBe('skipped')
      expect(json.counts).toEqual(expectedCounts({ skipped: 1, total: 1 }))
    })

    it('{notify: null, retryable: true}（DB一時障害等、既知理由のいずれにも一致しない予期しない失敗）の場合はfailed扱いでKVエントリを削除しない（Issue #787 2巡目レビューの回帰テスト）', async () => {
      // このテストは修正前のコード（`if (result) {...} else {...skipped}`）に対して
      // 実行すると、モックオブジェクト { notify: null, retryable: true } が truthy と
      // 判定されて誤って postRedemptionNotify(result) が呼ばれてしまうか、あるいは
      // 修正の中間段階で `result` を null チェックする実装のままだと skipped 扱いに
      // なり、いずれにせよ本テストが検証したい「retryableな失敗はKVに残す」という
      // 期待に反する。修正後は3分岐で正しく failed 扱いになり、KVエントリは
      // deleteParkedEventSubNotification が呼ばれず保持される。
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-retryable', record }],
        cursor: undefined,
        listComplete: true,
      })
      mocks.handleRedemption.mockResolvedValue({ notify: null, retryable: true })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.postRedemptionNotify).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).not.toHaveBeenCalled()
      expect(json.results[0].outcome).toBe('failed')
      expect(json.counts).toEqual(expectedCounts({ failed: 1, total: 1 }))
    })

    it('例外がthrowされた場合はKVエントリを削除せず、バッチ処理は次のエントリへ継続する', async () => {
      const failingRecord = makeRecord({ messageId: 'message-fail' })
      const succeedingRecord = makeRecord({ messageId: 'message-ok' })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [
          { key: 'maintenance:eventsub:key-fail', record: failingRecord },
          { key: 'maintenance:eventsub:key-ok', record: succeedingRecord },
        ],
        cursor: undefined,
        listComplete: true,
      })
      mocks.handleRedemption
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          notify: { gachaResult: { type: 'gacha' }, broadcasterTwitchUserId: 'b1', streamer: { id: 's1' }, userId: 'v1' },
          retryable: false,
        })
      mocks.postRedemptionNotify.mockResolvedValue(undefined)

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(json.results).toEqual([
        expect.objectContaining({ key: 'maintenance:eventsub:key-fail', outcome: 'failed', error: 'boom' }),
        expect.objectContaining({ key: 'maintenance:eventsub:key-ok', outcome: 'succeeded' }),
      ])
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledTimes(1)
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-ok')
      expect(mocks.deleteParkedEventSubNotification).not.toHaveBeenCalledWith('maintenance:eventsub:key-fail')
      expect(json.counts).toEqual(expectedCounts({ succeeded: 1, failed: 1, total: 2 }))
    })

    it('KV削除自体が例外をthrowしても、resultsは1エントリ1outcomeのままで二重計上されない（中-1の回帰テスト）', async () => {
      const record = makeRecord()
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-1', record }],
        cursor: undefined,
        listComplete: true,
      })
      const gachaResult = { gachaResult: { type: 'gacha' }, broadcasterTwitchUserId: 'broadcaster-1', streamer: { id: 's1' }, userId: 'viewer-1' }
      mocks.handleRedemption.mockResolvedValue({ notify: gachaResult, retryable: false })
      mocks.postRedemptionNotify.mockResolvedValue(undefined)
      // deleteParkedEventSubNotification はKV binding未取得時はwarnのみで例外を投げないが、
      // kv.delete() 自体が例外をthrowした場合は伝播しうる（eventsub-park.ts参照）。
      // その状況を再現する。
      mocks.deleteParkedEventSubNotification.mockRejectedValue(new Error('kv delete boom'))

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      // 修正前は catch 節に落ちて同一キーへ succeeded + failed の2エントリが
      // pushされ、countsが矛盾していた。修正後は最初にpushされた succeeded の
      // ままで、削除失敗はresultsに一切反映されないことを固定する。
      expect(json.results).toHaveLength(1)
      expect(json.results[0].outcome).toBe('succeeded')
      expect(json.counts).toEqual(expectedCounts({ succeeded: 1, total: 1 }))
    })

    it('payload.event が欠落している場合はinvalid-payload扱いでKVエントリを削除し、reportErrorを呼ぶ（低-6）', async () => {
      const record = makeRecord({ payload: { subscription: {} } })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-invalid', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-invalid')
      expect(mocks.reportError).toHaveBeenCalledTimes(1)
      expect(json.results[0].outcome).toBe('invalid-payload')
      expect(json.counts).toEqual(expectedCounts({ invalidPayload: 1, total: 1 }))
    })

    it('payload.event が非object（文字列）の場合もinvalid-payload扱いになる（低-6）', async () => {
      const record = makeRecord({ payload: { event: 'not-an-object' } })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-invalid2', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(json.results[0].outcome).toBe('invalid-payload')
    })
  })

  describe('CHANNEL_RAID の処理', () => {
    it('handleRaidNotification を呼び出し、成功時はKVエントリを削除する', async () => {
      const record = makeRecord({
        subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID,
        payload: {
          subscription: { type: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID },
          event: {
            from_broadcaster_user_id: 'from-1',
            to_broadcaster_user_id: 'to-1',
            viewers: 5,
          },
        },
      })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-raid', record }],
        cursor: undefined,
        listComplete: true,
      })
      const raidResult = { gachaResult: { type: 'gacha' }, broadcasterTwitchUserId: 'to-1', streamer: { id: 's1' }, userId: 'from-1' }
      mocks.handleRaidNotification.mockResolvedValue({ notify: raidResult, retryable: false })
      mocks.postRedemptionNotify.mockResolvedValue(undefined)

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRaidNotification).toHaveBeenCalledWith('message-1', payloadEventOf(record))
      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.postRedemptionNotify).toHaveBeenCalledWith(
        raidResult,
        expect.objectContaining({ externalSendDeadlineAt: expect.any(Number) }),
      )
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-raid')
      expect(json.results[0].outcome).toBe('succeeded')
    })

    it('{notify: null, retryable: true}の場合はfailed扱いでKVエントリを削除しない（RAID側、Issue #787 2巡目レビューの回帰テスト）', async () => {
      const record = makeRecord({
        subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID,
        payload: {
          subscription: { type: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID },
          event: { from_broadcaster_user_id: 'from-1', to_broadcaster_user_id: 'to-1', viewers: 5 },
        },
      })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-raid-retryable', record }],
        cursor: undefined,
        listComplete: true,
      })
      mocks.handleRaidNotification.mockResolvedValue({ notify: null, retryable: true })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.postRedemptionNotify).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).not.toHaveBeenCalled()
      expect(json.results[0].outcome).toBe('failed')
      expect(json.counts).toEqual(expectedCounts({ failed: 1, total: 1 }))
    })

    it('KV削除自体が例外をthrowしても、resultsは1エントリ1outcomeのままで二重計上されない（中-1の回帰テスト、RAID側）', async () => {
      const record = makeRecord({
        subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID,
        payload: {
          subscription: { type: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID },
          event: { from_broadcaster_user_id: 'from-1', to_broadcaster_user_id: 'to-1', viewers: 5 },
        },
      })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-raid', record }],
        cursor: undefined,
        listComplete: true,
      })
      const raidResult = { gachaResult: { type: 'gacha' }, broadcasterTwitchUserId: 'to-1', streamer: { id: 's1' }, userId: 'from-1' }
      mocks.handleRaidNotification.mockResolvedValue({ notify: raidResult, retryable: false })
      mocks.postRedemptionNotify.mockResolvedValue(undefined)
      mocks.deleteParkedEventSubNotification.mockRejectedValue(new Error('kv delete boom'))

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(json.results).toHaveLength(1)
      expect(json.results[0].outcome).toBe('succeeded')
      expect(json.counts).toEqual(expectedCounts({ succeeded: 1, total: 1 }))
    })

    it('payload.event が欠落している場合はinvalid-payload扱いになる（低-6、RAID側）', async () => {
      const record = makeRecord({
        subscriptionType: TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID,
        payload: { subscription: {} },
      })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-raid-invalid', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRaidNotification).not.toHaveBeenCalled()
      expect(mocks.deleteParkedEventSubNotification).toHaveBeenCalledWith('maintenance:eventsub:key-raid-invalid')
      expect(json.results[0].outcome).toBe('invalid-payload')
    })
  })

  describe('未知の subscriptionType（中-2）', () => {
    it('unknown-type扱いとし、KVエントリを削除せず、handleRedemption/handleRaidNotificationのいずれも呼ばない', async () => {
      const record = makeRecord({ subscriptionType: 'channel.unknown.event' })
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [{ key: 'maintenance:eventsub:key-unknown', record }],
        cursor: undefined,
        listComplete: true,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({}))
      const json = await response.json()

      expect(mocks.handleRedemption).not.toHaveBeenCalled()
      expect(mocks.handleRaidNotification).not.toHaveBeenCalled()
      // fail-safe: park側と同じ「将来subscriptionTypeが増えても退避漏れを防ぐ」設計に
      // 合わせ、replay側では即座にKV削除しない（TTL 7日に任せる）。
      expect(mocks.deleteParkedEventSubNotification).not.toHaveBeenCalled()
      expect(json.results[0].outcome).toBe('unknown-type')
      expect(json.counts).toEqual(expectedCounts({ unknownType: 1, total: 1 }))
    })
  })

  describe('cursor の pass-through', () => {
    it('リクエストボディのcursor/limitをlistParkedEventSubNotificationsへそのまま渡し、レスポンスのcursor/listCompleteを反映する', async () => {
      mocks.listParkedEventSubNotifications.mockResolvedValue({
        entries: [],
        cursor: 'next-cursor-value',
        listComplete: false,
      })

      const { POST } = await import('@/app/api/admin/eventsub-replay/route')
      const response = await POST(createReplayRequest({ cursor: 'incoming-cursor', limit: 5 }))
      const json = await response.json()

      expect(mocks.listParkedEventSubNotifications).toHaveBeenCalledWith({
        cursor: 'incoming-cursor',
        limit: 5,
      })
      expect(json.cursor).toBe('next-cursor-value')
      expect(json.listComplete).toBe(false)
    })
  })
})
