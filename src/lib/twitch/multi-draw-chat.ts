import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from '@/lib/constants'
import { countCharacters, truncateCharacters } from '@/lib/text-utils'
import type { GachaCard } from '@/lib/services/gacha'

export const MULTI_DRAW_CHAT_DELIVERY_MODES = ['summary', 'individual', 'chunked'] as const
export type MultiDrawChatDeliveryMode = (typeof MULTI_DRAW_CHAT_DELIVERY_MODES)[number]

export const DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE: MultiDrawChatDeliveryMode = 'summary'
export const DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE = 3
export const MIN_MULTI_DRAW_CHAT_CHUNK_SIZE = 2
export const MAX_MULTI_DRAW_CHAT_CHUNK_SIZE = 5

// Keep enough headroom above Twitch's one-message-per-second channel boundary.
// An individual 15-draw sequence takes 14 * 1.6s = 22.4s between first/last sends.
export const MULTI_DRAW_CHAT_INTERVAL_MS = 1_600

export interface MultiDrawChatSegment {
  index: number
  startDraw: number
  endDraw: number
  message: string
}

export function normalizeMultiDrawChatDeliveryMode(value: unknown): MultiDrawChatDeliveryMode {
  return typeof value === 'string'
    && (MULTI_DRAW_CHAT_DELIVERY_MODES as readonly string[]).includes(value)
    ? value as MultiDrawChatDeliveryMode
    : DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE
}

export function normalizeMultiDrawChatChunkSize(value: unknown): number {
  if (!Number.isInteger(value)) return DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE
  return Math.max(
    MIN_MULTI_DRAW_CHAT_CHUNK_SIZE,
    Math.min(MAX_MULTI_DRAW_CHAT_CHUNK_SIZE, Number(value)),
  )
}

function rarityLabel(rarity: string): string {
  const labels: Record<string, string> = {
    common: 'C',
    rare: 'R',
    epic: 'E',
    legendary: 'L',
  }
  return labels[rarity] ?? rarity
}

function formatRarityCounts(cards: GachaCard[]): string {
  const counts = new Map<string, number>()
  for (const card of cards) {
    counts.set(card.rarity, (counts.get(card.rarity) ?? 0) + 1)
  }

  const order = ['legendary', 'epic', 'rare', 'common']
  return [...counts.entries()]
    .sort(([a], [b]) => {
      const ai = order.indexOf(a)
      const bi = order.indexOf(b)
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
    })
    .map(([rarity, count]) => `${rarityLabel(rarity)}x${count}`)
    .join(', ')
}

/**
 * Fit a list of card names without cutting the structural part of the segment message.
 *
 * The legacy multi-draw formatter shortens the card-name list itself and keeps an explicit
 * omitted-card count. Do the same here instead of truncating the fully rendered segment,
 * otherwise a long card name can remove the draw range / rarity context or end mid-name.
 */
function fitCardNamesForSegment(cardNames: string[], maxCharacters: number): string {
  if (maxCharacters <= 0 || cardNames.length === 0) return ''

  const fullList = cardNames.join(', ')
  if (countCharacters(fullList) <= maxCharacters) return fullList

  const displayed: string[] = []
  for (const cardName of cardNames) {
    const nextDisplayed = [...displayed, cardName]
    const remaining = cardNames.length - nextDisplayed.length
    const suffix = remaining > 0 ? ` …(+${remaining})` : ''
    const candidate = `${nextDisplayed.join(', ')}${suffix}`
    if (countCharacters(candidate) > maxCharacters) break
    displayed.push(cardName)
  }

  if (displayed.length === 0) {
    return truncateCharacters(`…(+${cardNames.length})`, maxCharacters)
  }

  const remaining = cardNames.length - displayed.length
  return remaining > 0
    ? `${displayed.join(', ')} …(+${remaining})`
    : displayed.join(', ')
}

function fitSegmentWithTail(prefix: string, tail: string): string {
  const remainingCharacters = TWITCH_CHAT_MESSAGE_MAX_CHARACTERS - countCharacters(prefix)
  if (remainingCharacters <= 0) {
    return truncateCharacters(prefix, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS)
  }
  return `${prefix}${truncateCharacters(tail, remainingCharacters)}`
}

/**
 * Summary stays on the legacy sendChatAnnouncement path. Individual/chunked messages
 * are deterministic from card order so delivery_cursor can resume the exact segment
 * without depending on time, randomness, or mutable external state.
 */
export function buildMultiDrawChatSegments(
  cards: GachaCard[],
  userName: string,
  mode: MultiDrawChatDeliveryMode,
  chunkSize: number = DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE,
): MultiDrawChatSegment[] {
  if (mode === 'summary' || cards.length <= 1) return []

  const total = cards.length
  if (mode === 'individual') {
    return cards.map((card, index) => {
      const prefix = `@${userName} ${total}x ${index + 1}/${total}: [${rarityLabel(card.rarity)}] `
      return {
        index,
        startDraw: index + 1,
        endDraw: index + 1,
        message: fitSegmentWithTail(prefix, card.name),
      }
    })
  }

  const safeChunkSize = normalizeMultiDrawChatChunkSize(chunkSize)
  const segments: MultiDrawChatSegment[] = []
  for (let offset = 0; offset < total; offset += safeChunkSize) {
    const chunk = cards.slice(offset, offset + safeChunkSize)
    const startDraw = offset + 1
    const endDraw = offset + chunk.length
    const range = startDraw === endDraw ? `${startDraw}/${total}` : `${startDraw}-${endDraw}/${total}`
    const rarityCounts = formatRarityCounts(chunk)
    const prefix = `@${userName} ${total}x ${range}: ${rarityCounts} / `
    const names = fitCardNamesForSegment(
      chunk.map((card) => card.name),
      TWITCH_CHAT_MESSAGE_MAX_CHARACTERS - countCharacters(prefix),
    )
    segments.push({
      index: segments.length,
      startDraw,
      endDraw,
      message: fitSegmentWithTail(prefix, names),
    })
  }
  return segments
}