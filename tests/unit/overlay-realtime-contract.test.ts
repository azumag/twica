import { describe, expect, it } from 'vitest'
import {
  MAX_REALTIME_DRAWS,
  buildPollingRealtimeEvents,
  isOverlayRealtimeStreamerEnabled,
  serializedEventSize,
  validateGachaRealtimeEvent,
} from '@/lib/overlay-realtime/contract'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const CARD = {
  id: 'card-1',
  name: 'Card',
  description: null,
  image_url: null,
  rarity: 'rare',
}

describe('overlay realtime V1 contract', () => {
  it('keeps one redemption and its ordered draws in one sound batch', () => {
    const redeemedAt = '2026-07-24T00:00:00.000Z'
    const rows = Array.from({ length: MAX_REALTIME_DRAWS }, (_, index) => ({
      id: `history-${index + 1}`,
      eventId: index === 0 ? 'batch-1' : `batch-1:${index + 1}`,
      redeemedAt,
      userTwitchUsername: 'viewer',
      rewardId: 'reward-1',
      card: {
        ...CARD,
        id: `card-${index + 1}`,
        name: 'n'.repeat(500),
        description: 'd'.repeat(2_000),
        image_url: `https://example.com/${'i'.repeat(3_000)}`,
      },
    }))

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, rows)

    expect(event.batchId).toBe('batch-1')
    expect(event.soundGroupId).toBe('batch-1')
    expect(event.draws).toHaveLength(MAX_REALTIME_DRAWS)
    expect(event.draws.map((draw) => draw.drawIndex)).toEqual(
      Array.from({ length: MAX_REALTIME_DRAWS }, (_, index) => index)
    )
    expect(event.draws[0].card.name).toHaveLength(256)
    expect(event.draws[0].card.description).toHaveLength(1_024)
    expect(event.draws[0].card.image_url).toHaveLength(2_048)
    expect(validateGachaRealtimeEvent(event, STREAMER_ID)).toEqual({ ok: true })
    expect(serializedEventSize(event)).toBeLessThan(64 * 1024)
  })

  it('restores draw order when stable UUID cursor order interleaves a batch', () => {
    const redeemedAt = '2026-07-24T00:00:00.000Z'
    const rows = [
      {
        id: 'history-sort-3',
        eventId: 'batch-sort:3',
        redeemedAt,
        userTwitchUsername: 'viewer',
        card: { ...CARD, id: 'card-3' },
      },
      {
        id: 'history-sort-1',
        eventId: 'batch-sort',
        redeemedAt,
        userTwitchUsername: 'viewer',
        card: { ...CARD, id: 'card-1' },
      },
      {
        id: 'history-sort-2',
        eventId: 'batch-sort:2',
        redeemedAt,
        userTwitchUsername: 'viewer',
        card: { ...CARD, id: 'card-2' },
      },
    ]

    const [event] = buildPollingRealtimeEvents(STREAMER_ID, rows)

    expect(event.draws.map((draw) => draw.card.id)).toEqual([
      'card-1',
      'card-2',
      'card-3',
    ])
    expect(event.draws.map((draw) => draw.drawIndex)).toEqual([0, 1, 2])
    expect(validateGachaRealtimeEvent(event).ok).toBe(true)
  })

  it('rejects cross-room delivery and non-contiguous draw identity', () => {
    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'history-1',
      eventId: 'batch-1',
      redeemedAt: '2026-07-24T00:00:00.000Z',
      userTwitchUsername: 'viewer',
      rewardId: null,
      card: CARD,
    }])

    expect(
      validateGachaRealtimeEvent(
        event,
        '123e4567-e89b-42d3-a456-426614174001'
      ).error
    ).toBe('streamer mismatch')
    expect(
      validateGachaRealtimeEvent({
        ...event,
        draws: [{ ...event.draws[0], drawIndex: 1 }],
      }).error
    ).toBe('drawIndex must be contiguous')
  })

  it('rejects oversized attacker-controlled public fields before fanout', () => {
    const [event] = buildPollingRealtimeEvents(STREAMER_ID, [{
      id: 'history-1',
      eventId: 'batch-1',
      redeemedAt: '2026-07-24T00:00:00.000Z',
      userTwitchUsername: 'viewer',
      card: CARD,
    }])

    expect(validateGachaRealtimeEvent({
      ...event,
      draws: [{
        ...event.draws[0],
        card: {
          ...event.draws[0].card,
          description: 'x'.repeat(1_025),
        },
      }],
    }).error).toBe(
      'invalid card description'
    )
  })

  it('rejects JSON escaping that exceeds the 64 KiB wire limit', () => {
    const rows = Array.from({ length: MAX_REALTIME_DRAWS }, (_, index) => ({
      id: `history-${index + 1}`,
      eventId: index === 0 ? 'escaped-batch' : `escaped-batch:${index + 1}`,
      redeemedAt: '2026-07-24T00:00:00.000Z',
      userTwitchUsername: 'viewer',
      card: { ...CARD, id: `card-${index + 1}` },
    }))
    const [event] = buildPollingRealtimeEvents(STREAMER_ID, rows)
    const escaped = {
      ...event,
      draws: event.draws.map((draw) => ({
        ...draw,
        card: {
          ...draw.card,
          description: '\u0000'.repeat(1_024),
          image_url: '\u0000'.repeat(2_048),
        },
      })),
    }

    expect(validateGachaRealtimeEvent(escaped).error).toBe(
      'event exceeds byte limit'
    )
  })

  it('uses one rollout parser for mode, wildcard, and explicit allowlists', () => {
    expect(
      isOverlayRealtimeStreamerEnabled('polling-only', '*', STREAMER_ID)
    ).toBe(false)
    expect(
      isOverlayRealtimeStreamerEnabled('do-primary', '*', STREAMER_ID)
    ).toBe(true)
    expect(
      isOverlayRealtimeStreamerEnabled(
        'do-primary',
        `other, ${STREAMER_ID}`,
        STREAMER_ID
      )
    ).toBe(true)
    expect(
      isOverlayRealtimeStreamerEnabled('do-primary', 'other', STREAMER_ID)
    ).toBe(false)
  })
})
