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

  it.each([5, 10, 15])('individual keeps one ordered fallback segment per draw (%i draws)', (count) => {
    const cards = Array.from({ length: count }, (_, index) => card(index + 1))
    const segments = buildMultiDrawChatSegments(cards, 'user', 'individual')

    expect(segments).toHaveLength(count)
    expect(segments[0]?.message).toContain(`1/${count}:`)
    expect(segments[count - 1]?.message).toContain(`${count}/${count}:`)
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

  it('truncates only an oversized fallback card-name tail and keeps draw context', () => {
    const cards = [
      { ...card(1), name: 'x'.repeat(700) },
      card(2),
    ]
    const [segment] = buildMultiDrawChatSegments(cards, 'user', 'individual')

    expect(segment?.message).toMatch(/^@user 2x 1\/2: \[C\] /)
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

  it('reconstructs per-draw packUnique within the drawn card\'s own pack (#2045)', () => {
    const packACard = { ...card(1), collection_name: 'パックA' }
    const packANewCard = { ...card(2), collection_name: 'パックA' }
    const packBCard = { ...card(3), collection_name: 'パックB' }
    const cards = [packACard, packANewCard, packBCard]
    const snapshot = {
      cardCount: 4,
      uniqueCount: 5,
      allCount: 12,
      newCardNames: [packANewCard.name, packBCard.name],
      newCardNamesResolved: true,
      cardCounts: {
        [packACard.id]: 4, // 既所持（final 4 - drawn 1 > 0）
        [packANewCard.id]: 1, // このバッチで初入手
        [packBCard.id]: 1, // このバッチで初入手
      },
      packCounts: {
        'パックA': { unique: 3, all: 5 },
        'パックB': { unique: 1, all: 4 },
      },
    }

    // draw0（既所持のパックAカード）: パックAの初入手カードはまだ出ていない → 2
    expect(buildIndividualChatSnapshot(cards, 0, snapshot)).toMatchObject({
      cardCount: 4,
      uniqueCount: 5 - 2,
      packCounts: {
        'パックA': { unique: 2, all: 5 },
        'パックB': { unique: 1, all: 4 },
      },
    })
    // draw1（パックA初入手カード）: パックAだけが最終値3へ進む
    expect(buildIndividualChatSnapshot(cards, 1, snapshot)).toMatchObject({
      packCounts: {
        'パックA': { unique: 3, all: 5 },
        'パックB': { unique: 1, all: 4 },
      },
    })
    // draw2（パックB初入手カード）: パックBは0→1
    expect(buildIndividualChatSnapshot(cards, 2, snapshot)).toMatchObject({
      packCounts: {
        'パックA': { unique: 3, all: 5 },
        'パックB': { unique: 1, all: 4 },
      },
    })
  })

  it('keeps packCounts unchanged for draws whose card was already owned (#2045)', () => {
    const packACard = { ...card(1), collection_name: 'パックA' }
    const cards = [packACard, packACard]
    const snapshot = {
      cardCount: 4,
      uniqueCount: 5,
      allCount: 12,
      newCardNames: [],
      newCardNamesResolved: true,
      cardCounts: { [packACard.id]: 4 },
      packCounts: { 'パックA': { unique: 3, all: 5 } },
    }

    // 既所持カードの連続drawではパック内所持種類数は動かない
    expect(buildIndividualChatSnapshot(cards, 0, snapshot)?.packCounts?.['パックA'])
      .toEqual({ unique: 3, all: 5 })
    expect(buildIndividualChatSnapshot(cards, 1, snapshot)?.packCounts?.['パックA'])
      .toEqual({ unique: 3, all: 5 })
  })

  it('resolves unclassified drawn cards to the __default__ pack key (#2045)', () => {
    const freeCard = { ...card(1), collection_name: null }
    const snapshot = {
      cardCount: 1,
      uniqueCount: 1,
      allCount: 12,
      newCardNames: [freeCard.name],
      newCardNamesResolved: true,
      cardCounts: { [freeCard.id]: 1 },
      packCounts: { '__default__': { unique: 1, all: 2 } },
    }

    expect(buildIndividualChatSnapshot([freeCard], 0, snapshot)?.packCounts?.['__default__'])
      .toEqual({ unique: 1, all: 2 })
  })

  it('leaves packCounts untouched when the stored value contradicts the batch (#2045)', () => {
    const packACard = { ...card(1), collection_name: 'パックA' }
    const cards = [packACard]
    const snapshot = {
      cardCount: 1,
      uniqueCount: 1,
      allCount: 12,
      newCardNames: [packACard.name],
      newCardNamesResolved: true,
      cardCounts: { [packACard.id]: 1 },
      // final=1枚初入手なのにパック内unique=0は矛盾。壊れた中間値を出さず最終値を残す
      packCounts: { 'パックA': { unique: 0, all: 5 } },
    }

    expect(buildIndividualChatSnapshot(cards, 0, snapshot)?.packCounts?.['パックA'])
      .toEqual({ unique: 0, all: 5 })
  })

  it('pre-packCounts outbox rows keep no packCounts key (#2045)', () => {
    const snapshot = {
      cardCount: 4,
      uniqueCount: 5,
      allCount: 12,
      newCardNames: [],
      newCardNamesResolved: true,
      cardCounts: { [card(1).id]: 4, [card(2).id]: 1 },
    }

    const rebuilt = buildIndividualChatSnapshot([card(1), card(2)], 1, snapshot)
    expect(rebuilt?.packCounts).toBeUndefined()
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
