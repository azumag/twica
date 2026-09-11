import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from '@/lib/constants'
import { truncateCharacters } from '@/lib/text-utils'
import type { GachaCard } from '@/lib/services/gacha'

export const MULTI_DRAW_CHAT_DELIVERY_MODES = ['summary', 'individual', 'chunked'] as const
export type MultiDrawChatDeliveryMode = (typeof MULTI_DRAW_CHAT_DELIVERY_MODES)[number]

export const DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE: MultiDrawChatDeliveryMode = 'summary'
export const DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE = 3
export const MIN_MULTI_DRAW_CHAT_CHUNK_SIZE = 2
export const MAX_MULTI_DRAW_CHAT_CHUNK_SIZE = 5

// Twitchの通常チャットは同一チャンネルで1秒に1件を超えないよう余裕を持たせる。
// 15連をindividualで送っても 14 * 1.6s = 22.4s で完了する。
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
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
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
    .join('、')
}

function fitSegmentMessage(message: string): string {
  if (message.length === 0) return message
  return truncateCharacters(message, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS)
}

/**
 * summaryは従来のsendChatAnnouncementに委ねるためsegmentを返さない。
 * individual/chunkedはカード順序から決定的にmessage列を構築する。retry時に
 * delivery_cursorだけで同じindexへ復帰できることが重要なので、時刻・乱数・外部状態を
 * 一切参照しない。
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
    return cards.map((card, index) => ({
      index,
      startDraw: index + 1,
      endDraw: index + 1,
      message: fitSegmentMessage(
        `@${userName} ${total}連 ${index + 1}/${total}: 【${rarityLabel(card.rarity)}】${card.name}`,
      ),
    }))
  }

  const safeChunkSize = normalizeMultiDrawChatChunkSize(chunkSize)
  const segments: MultiDrawChatSegment[] = []
  for (let offset = 0; offset < total; offset += safeChunkSize) {
    const chunk = cards.slice(offset, offset + safeChunkSize)
    const startDraw = offset + 1
    const endDraw = offset + chunk.length
    const range = startDraw === endDraw ? `${startDraw}/${total}` : `${startDraw}-${endDraw}/${total}`
    const rarityCounts = formatRarityCounts(chunk)
    const names = chunk.map((card) => card.name).join('、')
    segments.push({
      index: segments.length,
      startDraw,
      endDraw,
      message: fitSegmentMessage(`@${userName} ${total}連 ${range}: ${rarityCounts} / ${names}`),
    })
  }
  return segments
}
