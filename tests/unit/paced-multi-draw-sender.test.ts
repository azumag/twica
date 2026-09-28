import { describe, expect, it, vi } from 'vitest'
import { sendPacedMultiDrawChatAnnouncement } from '@/lib/twitch/paced-multi-draw-sender'
import type { GachaCard } from '@/lib/services/gacha'

function card(index: number): GachaCard {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `カード${index}`,
    description: null,
    image_url: null,
    rarity: 'common',
    drop_rate: 1,
  }
}

describe('sendPacedMultiDrawChatAnnouncement', () => {
  it('persists cursor after each fallback segment and resumes from it', async () => {
    const sendChatMessageDetailed = vi.fn()
      .mockResolvedValueOnce({ outcome: 'sent' })
      .mockResolvedValueOnce({ outcome: 'sent' })
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2), card(3)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 1,
        afterSegmentComplete,
        delay,
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )).resolves.toEqual({ outcome: 'sent' })

    expect(sendChatMessageDetailed).toHaveBeenCalledTimes(2)
    expect(sendChatMessageDetailed.mock.calls[0]?.[1]).toContain('2/3')
    expect(sendChatMessageDetailed.mock.calls[1]?.[1]).toContain('3/3')
    expect(afterSegmentComplete.mock.calls.map(([cursor]) => cursor)).toEqual([2, 3])
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(1600)
  })

  it('uses the injected single-draw sender for individual delivery', async () => {
    const sendChatMessageDetailed = vi.fn()
    const sendIndividualCard = vi.fn()
      .mockResolvedValueOnce({ outcome: 'sent' })
      .mockResolvedValueOnce({ outcome: 'skipped' })
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)

    await expect(sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        sendIndividualCard,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )).resolves.toEqual({ outcome: 'sent' })

    expect(sendIndividualCard).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'カード1' }), 0)
    expect(sendIndividualCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'カード2' }), 1)
    expect(sendChatMessageDetailed).not.toHaveBeenCalled()
    expect(afterSegmentComplete.mock.calls.map(([cursor]) => cursor)).toEqual([1, 2])
  })

  it('stops before the next segment if cursor persistence loses the lease', async () => {
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2), card(3)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        afterSegmentComplete: vi.fn().mockResolvedValue(false),
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )

    expect(outcome.outcome).toBe('aborted')
    expect(sendChatMessageDetailed).toHaveBeenCalledTimes(1)
  })

  it('keeps cursor on 429 so retry can restart at the unsent segment', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn()
      .mockResolvedValueOnce({ outcome: 'sent' })
      .mockResolvedValueOnce({ outcome: 'retryable', reason: '429 rate limited' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2), card(3)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )

    expect(outcome).toEqual({ outcome: 'retryable', reason: '429 rate limited' })
    expect(afterSegmentComplete).toHaveBeenCalledTimes(1)
    expect(afterSegmentComplete).toHaveBeenLastCalledWith(1)
  })

  it('treats Twitch duplicate as completed and advances the cursor', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn()
      .mockResolvedValueOnce({ outcome: 'duplicate', reason: 'msg_duplicate' })
      .mockResolvedValueOnce({ outcome: 'sent' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )

    expect(outcome).toEqual({ outcome: 'sent' })
    expect(afterSegmentComplete.mock.calls.map(([cursor]) => cursor)).toEqual([1, 2])
  })

  it('does not re-send when every segment is already cursor-acked', async () => {
    const sendChatMessageDetailed = vi.fn()

    await expect(sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 2,
        afterSegmentComplete: vi.fn().mockResolvedValue(true),
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: {
          sendChatMessageDetailed,
          sendChatMessage: vi.fn(),
        },
      },
    )).resolves.toEqual({ outcome: 'sent' })

    expect(sendChatMessageDetailed).not.toHaveBeenCalled()
  })
})

// Issue #1665: bounded配送（予算内に完走できない場合の正常な途中終了）。
describe('sendPacedMultiDrawChatAnnouncement bounded delivery (Issue #1665)', () => {
  it('yields with deferred once maxSegments is reached, without sending further segments', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2), card(3), card(4)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        maxSegments: 2,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({ outcome: 'deferred', reason: 'budget' })
    expect(sendChatMessageDetailed).toHaveBeenCalledTimes(2)
    expect(afterSegmentComplete.mock.calls.map(([cursor]) => cursor)).toEqual([1, 2])
  })

  it('yields with deferred without starting a new segment once deadlineAt has passed', async () => {
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        deadlineAt: Date.now() - 1,
        afterSegmentComplete: vi.fn().mockResolvedValue(true),
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({ outcome: 'deferred', reason: 'budget' })
    expect(sendChatMessageDetailed).not.toHaveBeenCalled()
  })

  it('a slice resumed from a non-zero startCursor also respects deadlineAt/maxSegments', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2), card(3), card(4), card(5)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 3,
        maxSegments: 1,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({ outcome: 'deferred', reason: 'budget' })
    expect(sendChatMessageDetailed).toHaveBeenCalledTimes(1)
    expect(afterSegmentComplete).toHaveBeenCalledWith(4)
  })

  it('propagates degradation through a deferred outcome', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({
      outcome: 'sent',
      degradation: { code: 'credential_unavailable', reason: 'bot token expired' },
    })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        maxSegments: 1,
        afterSegmentComplete,
        delay: vi.fn().mockResolvedValue(undefined),
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({
      outcome: 'deferred',
      reason: 'budget',
      degradation: { code: 'credential_unavailable', reason: 'bot token expired' },
    })
  })

  it('calls channelGate once per segment instead of the in-process delay, including the first segment', async () => {
    const afterSegmentComplete = vi.fn().mockResolvedValue(true)
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })
    const delay = vi.fn().mockResolvedValue(undefined)
    const channelGate = vi.fn().mockResolvedValue({ outcome: 'reserved' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        afterSegmentComplete,
        delay,
        channelGate,
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({ outcome: 'sent' })
    expect(channelGate).toHaveBeenCalledTimes(2)
    expect(delay).not.toHaveBeenCalled()
  })

  it('stops as deferred when channelGate reports budget-exhausted', async () => {
    const sendChatMessageDetailed = vi.fn().mockResolvedValue({ outcome: 'sent' })
    const channelGate = vi.fn().mockResolvedValue({ outcome: 'budget-exhausted' })

    const outcome = await sendPacedMultiDrawChatAnnouncement(
      'broadcaster',
      [card(1), card(2)],
      'user',
      {
        deliveryMode: 'individual',
        chunkSize: 3,
        startCursor: 0,
        afterSegmentComplete: vi.fn().mockResolvedValue(true),
        delay: vi.fn().mockResolvedValue(undefined),
        channelGate,
        chatService: { sendChatMessageDetailed, sendChatMessage: vi.fn() },
      },
    )

    expect(outcome).toEqual({ outcome: 'deferred', reason: 'budget' })
    expect(sendChatMessageDetailed).not.toHaveBeenCalled()
  })
})
