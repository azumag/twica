import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimChatNotificationForBoundedDelivery: vi.fn(),
  decodeChatNotificationPayload: vi.fn(),
  deadLetterChatNotification: vi.fn(),
  estimateChatOutboxRetryDelayMs: vi.fn().mockReturnValue(60_000),
  markChatNotificationSent: vi.fn(),
  releaseChatNotificationForContinuation: vi.fn(),
  renewChatNotificationLease: vi.fn(),
  retryChatNotificationForBoundedDelivery: vi.fn(),
}))
vi.mock('@/lib/services/chat-channel-gate', () => ({
  reserveChatChannelSendSlot: vi.fn().mockResolvedValue({ outcome: 'reserved' }),
}))
vi.mock('@/lib/services/eventsub-redemption-delivery', () => ({
  sendClaimedChatAnnouncement: vi.fn(),
}))

import { deliverChatNotificationSlice } from '@/lib/services/chat-notification-delivery'
import {
  claimChatNotificationForBoundedDelivery,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  markChatNotificationSent,
  releaseChatNotificationForContinuation,
  renewChatNotificationLease,
  retryChatNotificationForBoundedDelivery,
} from '@/lib/services/chat-notification-outbox'
import { reserveChatChannelSendSlot } from '@/lib/services/chat-channel-gate'
import { sendClaimedChatAnnouncement } from '@/lib/services/eventsub-redemption-delivery'
import type { RedemptionNotifyData } from '@/lib/services/eventsub-redemption'

const mockClaim = vi.mocked(claimChatNotificationForBoundedDelivery)
const mockDecode = vi.mocked(decodeChatNotificationPayload)
const mockDeadLetter = vi.mocked(deadLetterChatNotification)
const mockMarkSent = vi.mocked(markChatNotificationSent)
const mockRelease = vi.mocked(releaseChatNotificationForContinuation)
const mockRenew = vi.mocked(renewChatNotificationLease)
const mockRetry = vi.mocked(retryChatNotificationForBoundedDelivery)
const mockSend = vi.mocked(sendClaimedChatAnnouncement)
const mockGate = vi.mocked(reserveChatChannelSendSlot)

const claim = {
  id: 'outbox-1',
  batchId: 'batch-1',
  payloadVersion: 1,
  payload: { any: 'thing' },
  leaseId: 'lease-1',
  attemptCount: 1,
  claimAttemptIncrement: 1 as const,
  createdAt: '2026-09-22T00:00:00.000Z',
}

const decodedData = {
  batchId: 'batch-1',
  broadcasterTwitchUserId: 'broadcaster-1',
  userId: 'viewer-1',
  streamer: { id: 'streamer-1', chat_announcement_enabled: true },
  gachaResult: { type: 'gacha' as const, card: { id: 'c1' }, cards: [{ id: 'c1' }], userTwitchUsername: 'Viewer' },
} as unknown as RedemptionNotifyData

describe('deliverChatNotificationSlice (Issue #1665)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGate.mockResolvedValue({ outcome: 'reserved' })
    mockRenew.mockResolvedValue(true)
  })

  it('returns not_claimable without any state change when claim fails', async () => {
    mockClaim.mockResolvedValue(null)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'not_claimable' })

    expect(mockDecode).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('dead-letters and reports an invalid payload as terminal', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(null)
    mockDeadLetter.mockResolvedValue(true)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({
      kind: 'terminal',
      code: 'invalid_payload',
    })

    expect(mockDeadLetter).toHaveBeenCalledWith(claim, expect.stringContaining('payload v1 is invalid'))
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('marks sent and returns complete on a full send', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'sent' })
    mockMarkSent.mockResolvedValue(true)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'complete' })

    expect(mockMarkSent).toHaveBeenCalledWith(claim)
    // budget/channelGate/deadlineAt must reach the paced sender through sendClaimedChatAnnouncement.
    const budget = mockSend.mock.calls[0]?.[3]
    expect(budget).toMatchObject({ deadlineAt: expect.any(Number), maxSegments: expect.any(Number) })
    expect(typeof budget?.channelGate).toBe('function')
  })

  it('reports lease_lost when the sent-ack loses its lease (send/ack are not atomic)', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'sent' })
    mockMarkSent.mockResolvedValue(false)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'lease_lost' })
  })

  it('releases a sender budget deferral before any external send with the claim refund enabled', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'deferred', reason: 'budget' })
    mockRelease.mockResolvedValue(true)

    const result = await deliverChatNotificationSlice('batch-1')

    expect(result.kind).toBe('deferred')
    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(mockRelease.mock.calls[0]?.[0]).toBe(claim)
    expect(mockRelease.mock.calls[0]?.[1]).toBeInstanceOf(Date)
    expect(mockRelease.mock.calls[0]?.[2]).toEqual({ beforeSend: true })
    expect(mockRenew).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockDeadLetter).not.toHaveBeenCalled()
  })

  it.each([
    ['initial', { ...claim, attemptCount: 1, claimAttemptIncrement: 1 as const }],
    ['retry', { ...claim, attemptCount: 3, claimAttemptIncrement: 1 as const }],
    ['continuation', { ...claim, attemptCount: 3, claimAttemptIncrement: 0 as const }],
  ])('counts the %s DB claim against the slice budget and releases before any send', async (_kind, claimed) => {
    let currentTime = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    mockClaim.mockImplementation(async () => {
      currentTime += 1_000
      return claimed
    })
    mockDecode.mockReturnValue(decodedData)
    mockRelease.mockResolvedValue(true)

    try {
      await expect(deliverChatNotificationSlice('batch-1', { timeBudgetMs: 1_000 })).resolves.toMatchObject({
        kind: 'deferred',
        nextAttemptAt: expect.any(String),
      })

      expect(mockSend).not.toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledWith(claimed, expect.any(Date), { beforeSend: true })
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('returns a normal continuation when only 3.5s remain, below the send+checkpoint reserve', async () => {
    const startedAt = Date.now()
    let currentTime = startedAt
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockRelease.mockResolvedValue(true)
    mockSend.mockImplementation(async (_claim, _data, beforeExternalSend) => {
      currentTime = startedAt + 1_500 // 5s budget - 1.5s elapsed = 3.5s remaining
      await expect(beforeExternalSend()).resolves.toBe('budget-exhausted')
      return { outcome: 'deferred', reason: 'budget' }
    })

    try {
      await expect(deliverChatNotificationSlice('batch-1', { timeBudgetMs: 5_000 })).resolves.toMatchObject({
        kind: 'deferred',
      })

      expect(mockRenew).not.toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledWith(claim, expect.any(Date), { beforeSend: true })
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('refunds a claim when lease renewal consumes the send reserve before granting any send permission', async () => {
    const startedAt = Date.now()
    let currentTime = startedAt
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockRelease.mockResolvedValue(true)
    mockRenew.mockImplementation(async () => {
      currentTime = startedAt + 1_500 // 3.5s remaining after a successful renewal is still too little to send.
      return true
    })
    mockSend.mockImplementation(async (_claim, _data, beforeExternalSend) => {
      await expect(beforeExternalSend()).resolves.toBe('budget-exhausted')
      return { outcome: 'deferred', reason: 'budget' }
    })

    try {
      await expect(deliverChatNotificationSlice('batch-1', { timeBudgetMs: 5_000 })).resolves.toMatchObject({
        kind: 'deferred',
      })

      expect(mockRenew).toHaveBeenCalledTimes(1)
      expect(mockRelease).toHaveBeenCalledWith(claim, expect.any(Date), { beforeSend: true })
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('keeps the claim counted when a partial send defers after a successful external-send fence', async () => {
    const startedAt = Date.now()
    let currentTime = startedAt
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockRelease.mockResolvedValue(true)
    mockSend.mockImplementation(async (_claim, _data, beforeExternalSend) => {
      await expect(beforeExternalSend()).resolves.toBe(true)
      // A sent segment consumes the slice; a later segment cannot start. The earlier
      // permission must remain recorded even though the last fence returns budget-exhausted.
      currentTime = startedAt + 1_500
      await expect(beforeExternalSend()).resolves.toBe('budget-exhausted')
      return { outcome: 'deferred', reason: 'budget' }
    })

    try {
      await expect(deliverChatNotificationSlice('batch-1', { timeBudgetMs: 5_000 })).resolves.toMatchObject({
        kind: 'deferred',
      })

      expect(mockRenew).toHaveBeenCalledTimes(1)
      expect(mockRelease).toHaveBeenCalledWith(claim, expect.any(Date), { beforeSend: false })
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it.each(['retryable', 'throw'] as const)(
    'keeps the claim counted for a %s failure after granting external-send permission',
    async (failure) => {
      mockClaim.mockResolvedValue(claim)
      mockDecode.mockReturnValue(decodedData)
      mockRetry.mockResolvedValue('pending')
      mockSend.mockImplementation(async (_claim, _data, beforeExternalSend) => {
        await expect(beforeExternalSend()).resolves.toBe(true)
        if (failure === 'throw') throw new Error('send failed')
        return { outcome: 'retryable', reason: 'send failed' }
      })

      const result = deliverChatNotificationSlice('batch-1')
      if (failure === 'throw') {
        await expect(result).rejects.toThrow('send failed')
      } else {
        await expect(result).resolves.toMatchObject({ kind: 'retryable' })
      }

      expect(mockRenew).toHaveBeenCalledWith(claim)
      expect(mockRetry).toHaveBeenCalledWith(claim, 'send failed')
      expect(mockRelease).not.toHaveBeenCalled()
    },
  )

  it('does not refund or retry when the external-send fence loses ownership', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockRenew.mockResolvedValue(false)
    mockSend.mockImplementation(async (_claim, _data, beforeExternalSend) => {
      await expect(beforeExternalSend()).resolves.toBe(false)
      return { outcome: 'aborted', reason: 'lease lost before send' }
    })

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'lease_lost' })

    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockDeadLetter).not.toHaveBeenCalled()
  })

  it('returns lease_lost when the continuation release loses its lease', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'deferred', reason: 'budget' })
    mockRelease.mockResolvedValue(false)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'lease_lost' })
  })

  it('dead-letters a terminal chat-service outcome and surfaces its code', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'terminal', code: 'twitch_rejected', reason: 'blocked' })
    mockDeadLetter.mockResolvedValue(true)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({
      kind: 'terminal',
      code: 'twitch_rejected',
    })
  })

  it('does not report to GitHub Issues for a missing_scope terminal (user reauth, not a bug)', async () => {
    const { reportError } = await import('@/lib/sentry/error-handler')
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'terminal', code: 'missing_scope', reason: 'no scope' })
    mockDeadLetter.mockResolvedValue(true)

    await deliverChatNotificationSlice('batch-1')

    expect(reportError).not.toHaveBeenCalled()
  })

  // Issue #1725: AutoMod等の本文拒否はコード不具合ではないため、missing_scopeと
  // 同様に自動Issue化しない。
  it('does not report to GitHub Issues for a content_rejected terminal (AutoMod, not a bug)', async () => {
    const { reportError } = await import('@/lib/sentry/error-handler')
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({
      outcome: 'terminal',
      code: 'content_rejected',
      reason: 'Twitch API 200: The message was held by AutoMod.',
    })
    mockDeadLetter.mockResolvedValue(true)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({
      kind: 'terminal',
      code: 'content_rejected',
    })

    expect(reportError).not.toHaveBeenCalled()
  })

  it('treats aborted (lost fence) as lease_lost without overwriting a new owner state, but still reports it', async () => {
    const { reportError } = await import('@/lib/sentry/error-handler')
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'aborted', reason: 'lease lost mid-send' })

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual({ kind: 'lease_lost' })

    expect(mockDeadLetter).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    // Issue #1665: abortedはstate遷移を伴わない(no DB write)ため唯一の
    // 診断手段がログ/reportError。他のsent/deferred/terminal/retryable分岐と
    // 同様に、無音のままにしない。
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['pending', { kind: 'retryable', nextAttemptAt: expect.any(String) }],
    ['dead', { kind: 'terminal', code: 'retries_exhausted' }],
    ['lost-lease', { kind: 'lease_lost' }],
  ] as const)('maps retryChatNotificationForBoundedDelivery state %s to outcome', async (state, expected) => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockResolvedValue({ outcome: 'retryable', reason: '429' })
    mockRetry.mockResolvedValue(state)

    await expect(deliverChatNotificationSlice('batch-1')).resolves.toEqual(expected)
  })

  it('retries on an unexpected throw and rethrows for the caller boundary to observe', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockRejectedValue(new Error('unexpected'))
    mockRetry.mockResolvedValue('pending')

    await expect(deliverChatNotificationSlice('batch-1')).rejects.toThrow('unexpected')

    expect(mockRetry).toHaveBeenCalledWith(claim, 'unexpected')
  })

  it("does not double-persist state when the sender's own throw happens after it already persisted", async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    // sendClaimedChatAnnouncement内で例外を投げる想定はここでは起きないが、
    // deferred経路がreleaseに成功した"後"に予期しないエラーになるケースは
    // 起きない(returnで抜けるため)。ここではmarkChatNotificationSent自体が
    // 例外を投げた場合、既にoutcome分岐内でcatchされずthrowされることだけ確認する。
    mockSend.mockResolvedValue({ outcome: 'sent' })
    mockMarkSent.mockRejectedValue(new Error('db unavailable'))

    await expect(deliverChatNotificationSlice('batch-1')).rejects.toThrow('db unavailable')
    // deliveryStatePersistedはまだtrueになっていない(markChatNotificationSent自体が
    // 失敗した)ため、catchブロックがretryChatNotificationForBoundedDeliveryを呼ぶ。
    expect(mockRetry).toHaveBeenCalledWith(claim, 'db unavailable')
  })

  it('wires the channel gate through to reserveChatChannelSendSlot with the broadcaster id', async () => {
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue(decodedData)
    mockSend.mockImplementation(async (_claim, _data, _before, budget) => {
      await budget!.channelGate!(Date.now() + 1_000)
      return { outcome: 'sent' }
    })
    mockMarkSent.mockResolvedValue(true)

    await deliverChatNotificationSlice('batch-1')

    expect(mockGate).toHaveBeenCalledWith('broadcaster-1', expect.objectContaining({ intervalMs: 1_600 }))
  })
})
