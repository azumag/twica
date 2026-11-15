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
  readPackCountsEntry,
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

  describe('packCounts (Issue #2045)', () => {
    const inPack = (index: number, collectionName: string | null) => ({
      ...card(index),
      collection_name: collectionName,
    })

    it('carries final packCounts through the aggregate fallback (pre-cardCounts rows)', () => {
      const snapshot = {
        cardCount: 7,
        uniqueCount: 9,
        allCount: 12,
        newCardNames: [],
        packCounts: { Alpha: { unique: 3, all: 5 } },
      }

      expect(buildIndividualChatSnapshot([inPack(1, 'Alpha'), card(2)], 1, snapshot)).toEqual(snapshot)
    })

    it('restores per-draw packUnique from final pack counts; packAll stays final', () => {
      // A1 (already owned) / A2 (new, first at draw 1) / A2 / B1 (new, other pack) / A3 (new, draw 4)
      const a1 = inPack(1, 'Alpha')
      const a2 = inPack(2, 'Alpha')
      const a3 = inPack(3, 'Alpha')
      const b1 = inPack(4, null)
      const cards = [a1, a2, a2, b1, a3]
      const snapshot = {
        cardCount: 5,
        uniqueCount: 8,
        allCount: 20,
        newCardNames: [a2.name, b1.name, a3.name],
        newCardNamesResolved: true,
        cardCounts: { [a1.id]: 5, [a2.id]: 2, [b1.id]: 1, [a3.id]: 1 },
        packCounts: {
          Alpha: { unique: 4, all: 6 },
          __default__: { unique: 1, all: 3 },
        },
      }

      const packAt = (drawIndex: number) =>
        buildIndividualChatSnapshot(cards, drawIndex, snapshot)?.packCounts
      expect(packAt(0)?.Alpha).toEqual({ unique: 2, all: 6 })
      expect(packAt(1)?.Alpha).toEqual({ unique: 3, all: 6 })
      expect(packAt(2)?.Alpha).toEqual({ unique: 3, all: 6 })
      // The other pack's new card does not lower Alpha, and its own pack is final at draw 3.
      expect(packAt(3)?.__default__).toEqual({ unique: 1, all: 3 })
      expect(packAt(4)?.Alpha).toEqual({ unique: 4, all: 6 })
      // The shared snapshot object is never mutated by per-draw reconstruction.
      expect(snapshot.packCounts.Alpha).toEqual({ unique: 4, all: 6 })
    })

    it('keeps the final pack value when the newly acquired types exceed final unique', () => {
      const a1 = inPack(1, 'Alpha')
      const a2 = inPack(2, 'Alpha')
      const snapshot = {
        cardCount: 1,
        uniqueCount: 5,
        allCount: 10,
        newCardNames: [],
        cardCounts: { [a1.id]: 1, [a2.id]: 1 },
        packCounts: { Alpha: { unique: 1, all: 3 } },
      }

      expect(buildIndividualChatSnapshot([a1, a2], 0, snapshot)?.packCounts).toEqual({
        Alpha: { unique: 1, all: 3 },
      })
    })

    it('does not add a packCounts key when the snapshot has none', () => {
      const a1 = inPack(1, 'Alpha')
      const snapshot = {
        cardCount: 1,
        uniqueCount: 1,
        allCount: 3,
        newCardNames: [],
        cardCounts: { [a1.id]: 2 },
      }

      // cardCounts is consistent, so this exercises the reconstructed (non-fallback) return.
      const individual = buildIndividualChatSnapshot([a1, a1], 0, snapshot)
      expect(individual).toMatchObject({ cardCount: 1, uniqueCount: 1 })
      expect(individual).not.toHaveProperty('packCounts')
    })
  })

  describe('readPackCountsEntry (Issue #2045)', () => {
    it('returns a valid entry for the pack key', () => {
      expect(readPackCountsEntry({ Alpha: { unique: 2, all: 4 } }, 'Alpha')).toEqual({ unique: 2, all: 4 })
      expect(readPackCountsEntry({ __default__: { unique: 0, all: 1 } }, '__default__')).toEqual({ unique: 0, all: 1 })
    })

    it('reads only own properties, so pack names like constructor/toString are safe', () => {
      expect(readPackCountsEntry({}, 'constructor')).toBeUndefined()
      expect(readPackCountsEntry({}, 'toString')).toBeUndefined()
      expect(readPackCountsEntry(JSON.parse('{"constructor":{"unique":1,"all":2}}'), 'constructor'))
        .toEqual({ unique: 1, all: 2 })
    })

    it.each([
      ['missing container', undefined],
      ['null container', null],
      ['array container', [{ unique: 1, all: 2 }]],
      ['string container', 'Alpha'],
      ['null entry', { Alpha: null }],
      ['array entry', { Alpha: [1, 2] }],
      ['missing all', { Alpha: { unique: 1 } }],
      ['string counts', { Alpha: { unique: '1', all: '2' } }],
      ['fractional count', { Alpha: { unique: 1.5, all: 2 } }],
      ['negative count', { Alpha: { unique: -1, all: 2 } }],
      ['unique above all', { Alpha: { unique: 3, all: 2 } }],
      ['zero all', { Alpha: { unique: 0, all: 0 } }],
      ['other pack only', { Beta: { unique: 1, all: 2 } }],
    ])('rejects %s', (_label, packCounts) => {
      expect(readPackCountsEntry(packCounts, 'Alpha')).toBeUndefined()
    })
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
