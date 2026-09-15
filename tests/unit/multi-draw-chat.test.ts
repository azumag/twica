import { describe, expect, it } from 'vitest'
import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from '@/lib/constants'
import { countCharacters } from '@/lib/text-utils'
import {
  buildIndividualChatSnapshot,
  buildMultiDrawChatSegments,
  DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE,
  MULTI_DRAW_CHAT_INTERVAL_MS,
  normalizeMultiDrawChatChunkSize,
  normalizeMultiDrawChatDeliveryMode,
} from '@/lib/twitch/multi-draw-chat'
import type { GachaCard } from '@/lib/services/gacha'

function card(index: number, rarity = 'common'): GachaCard {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `カード${index}`,
    description: null,
    image_url: null,
    rarity,
    drop_rate: 1,
  }
}

describe('multi-draw chat segmentation', () => {
  it('summary keeps the legacy one-message path', () => {
    expect(buildMultiDrawChatSegments([card(1), card(2)], 'user', 'summary')).toEqual([])
  })

  it.each([5, 10, 15])('individual builds one single-draw-style segment per draw (%i draws)', (count) => {
    const cards = Array.from({ length: count }, (_, index) => card(index + 1))
    const segments = buildMultiDrawChatSegments(cards, 'user', 'individual')

    expect(segments).toHaveLength(count)
    expect(segments[0]?.message).toBe('@user が【コモン】カード1 を獲得しました！')
    expect(segments[count - 1]?.message).toBe(`@user が【コモン】カード${count} を獲得しました！`)
    expect(segments.map((segment) => segment.index)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    )
  })

  it('chunked splits 15 draws into deterministic 3-card messages', () => {
    const cards = Array.from({ length: 15 }, (_, index) =>
      card(index + 1, index === 0 ? 'rare' : 'common'),
    )
    const segments = buildMultiDrawChatSegments(cards, 'user', 'chunked', 3)

    expect(segments).toHaveLength(5)
    expect(segments[0]?.message).toContain('1-3/15')
    expect(segments[0]?.message).toContain('Rx1, Cx2')
    expect(segments[4]?.message).toContain('13-15/15')
  })

  it('chunked preserves the final remainder', () => {
    const cards = Array.from({ length: 10 }, (_, index) => card(index + 1))
    const segments = buildMultiDrawChatSegments(cards, 'user', 'chunked', 3)

    expect(segments).toHaveLength(4)
    expect(segments[3]?.startDraw).toBe(10)
    expect(segments[3]?.endDraw).toBe(10)
    expect(segments[3]?.message).toContain('10/10')
  })

  it('preserves segment context and reports omitted chunk names within the Twitch limit', () => {
    const cards = [1, 2, 3].map((index) => ({
      ...card(index),
      name: `${index}-${'x'.repeat(300)}`,
    }))
    const [segment] = buildMultiDrawChatSegments(cards, 'user', 'chunked', 3)

    expect(segment?.message).toContain('1-3/3: Cx3 / ')
    expect(segment?.message).toContain('…(+2)')
    expect(countCharacters(segment?.message ?? '')).toBeLessThanOrEqual(
      TWITCH_CHAT_MESSAGE_MAX_CHARACTERS,
    )
  })

  it('truncates an oversized individual message the same way as normal chat delivery', () => {
    const cards = [
      { ...card(1), name: 'x'.repeat(700) },
      card(2),
    ]
    const [segment] = buildMultiDrawChatSegments(cards, 'user', 'individual')

    expect(segment?.message).toMatch(/^@user が【コモン】/)
    expect(segment?.message.endsWith('...')).toBe(true)
    expect(countCharacters(segment?.message ?? '')).toBe(TWITCH_CHAT_MESSAGE_MAX_CHARACTERS)
  })

  it('reconstructs per-draw num and unique placeholders from final card counts', () => {
    const first = card(1)
    const second = card(2)
    const cards = [first, first, second]
    const snapshot = {
      cardCount: 4,
      uniqueCount: 5,
      allCount: 12,
      newCardNames: [second.name],
      newCardNamesResolved: true,
      cardCounts: {
        [first.id]: 4,
        [second.id]: 1,
      },
    }

    expect(buildIndividualChatSnapshot(cards, 0, snapshot)).toMatchObject({
      cardCount: 3,
      uniqueCount: 4,
      allCount: 12,
    })
    expect(buildIndividualChatSnapshot(cards, 1, snapshot)).toMatchObject({
      cardCount: 4,
      uniqueCount: 4,
      allCount: 12,
    })
    expect(buildIndividualChatSnapshot(cards, 2, snapshot)).toMatchObject({
      cardCount: 1,
      uniqueCount: 5,
      allCount: 12,
    })
  })

  it('keeps a deterministic aggregate fallback for pre-cardCounts outbox rows', () => {
    const snapshot = {
      cardCount: 7,
      uniqueCount: 9,
      allCount: 12,
      newCardNames: [],
    }

    expect(buildIndividualChatSnapshot([card(1), card(2)], 1, snapshot)).toEqual(snapshot)
  })

  it('normalizes invalid persisted settings fail-safe to summary / chunk size 3', () => {
    expect(normalizeMultiDrawChatDeliveryMode('unexpected')).toBe('summary')
    expect(normalizeMultiDrawChatDeliveryMode(undefined)).toBe('summary')
    expect(normalizeMultiDrawChatChunkSize(1)).toBe(2)
    expect(normalizeMultiDrawChatChunkSize(99)).toBe(5)
    expect(normalizeMultiDrawChatChunkSize('3')).toBe(DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE)
  })

  it('uses a pacing interval above the one-message-per-second boundary', () => {
    expect(MULTI_DRAW_CHAT_INTERVAL_MS).toBeGreaterThanOrEqual(1_500)
  })
})
