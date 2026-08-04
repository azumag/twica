import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ERROR_MESSAGES, TWITCH_SUBSCRIPTION_TYPE } from '@/lib/constants'
import type { ParkedEventSubRecord } from '@/lib/maintenance/eventsub-park'

const mocks = vi.hoisted(() => ({
  listParkedEventSubNotifications: vi.fn(),
  deleteParkedEventSubNotification: vi.fn(),
  claimDueChatNotifications: vi.fn(),
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
}))

vi.mock('@/lib/maintenance/eventsub-park', () => ({
  listParkedEventSubNotifications: mocks.listParkedEventSubNotifications,
  deleteParkedEventSubNotification: mocks.deleteParkedEventSubNotification,
}))

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimDueChatNotifications: mocks.claimDueChatNotifications,
  peekChatNotificationOutboxWork: mocks.peekChatNotificationOutboxWork,
  decodeChatNotificationPayload: mocks.decodeChatNotificationPayload,
  markChatNotificationSent: mocks.markChatNotificationSent,
  renewChatNotificationLease: mocks.renewChatNotificationLease,
  deadLetterChatNotification: mocks.deadLetterChatNotification,
  retryChatNotification: mocks.retryChatNotification,
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

/** counts の完全一致比較用ヘルパー。新設カテゴリ(unknownType/invalidPayload)は省略時0。 */
function expectedCounts(overrides: Partial<{
  succeeded: number
  skipped: number
  failed: number
  unknownType: number
  invalidPayload: number
  total: number
}>) {
  return {
    succeeded: 0,
    skipped: 0,
    failed: 0,
    unknownType: 0,
    invalidPayload: 0,
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
    mocks.reportError.mockResolvedValue(undefined)
  })

  afterEach(() => {
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

      expect(mocks.claimDueChatNotifications).toHaveBeenNthCalledWith(
        21,
        1,
        { maintain: true },
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
