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
  it('persists cursor after each segment and resumes from it', async () => {
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
