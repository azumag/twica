import type { GachaCard } from '@/lib/services/gacha'
import {
  TwitchChatService,
  type ChatSendDegradation,
  type ChatSendTerminalCode,
} from '@/lib/twitch/chat-service'
import {
  buildMultiDrawChatSegments,
  MULTI_DRAW_CHAT_INTERVAL_MS,
  normalizeMultiDrawChatChunkSize,
  normalizeMultiDrawChatDeliveryMode,
} from '@/lib/twitch/multi-draw-chat'

export type PacedMultiDrawSendOutcome = (
  | { outcome: 'sent' }
  | { outcome: 'skipped' }
  | { outcome: 'terminal'; code: ChatSendTerminalCode; reason: string }
  | { outcome: 'retryable'; reason: string }
  | { outcome: 'aborted'; reason: string }
) & { degradation?: ChatSendDegradation }

export interface PacedMultiDrawSendOptions {
  deliveryMode: unknown
  chunkSize: unknown
  startCursor: number
  beforeExternalSend?: () => Promise<boolean>
  afterSegmentComplete: (nextCursor: number) => Promise<boolean>
  /** unit test用。productionは固定1.6秒を使用する。 */
  delay?: (milliseconds: number) => Promise<void>
  chatService?: Pick<TwitchChatService, 'sendChatMessageDetailed' | 'sendChatMessage'>
}

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds)
})

/**
 * N連のindividual/chunkedを安全な間隔で送る。
 *
 * 各segmentのTwitch確定後、次を送る前にdelivery_cursorをowner-fencedで永続化する。
 * cursor保存に失敗した場合は即停止し、既送信segmentの後へ進まない。429/5xx等の
 * retryable outcomeはcursorを進めず呼び出し元outbox backoffへ返すため、次claimは
 * 最後に確定保存できたsegmentから再開できる。
 */
export async function sendPacedMultiDrawChatAnnouncement(
  broadcasterTwitchUserId: string,
  cards: GachaCard[],
  userName: string,
  options: PacedMultiDrawSendOptions,
): Promise<PacedMultiDrawSendOutcome> {
  const mode = normalizeMultiDrawChatDeliveryMode(options.deliveryMode)
  const chunkSize = normalizeMultiDrawChatChunkSize(options.chunkSize)
  const segments = buildMultiDrawChatSegments(cards, userName, mode, chunkSize)
  if (segments.length === 0) {
    return { outcome: 'skipped' }
  }

  const startCursor = Number.isInteger(options.startCursor)
    ? Math.max(0, Math.min(options.startCursor, segments.length))
    : 0
  if (startCursor >= segments.length) {
    // 全segment送信済みでackだけ失敗したケース。Twitchへ再送せずoutbox全体をackできる。
    return { outcome: 'sent' }
  }

  const chatService = options.chatService ?? new TwitchChatService()
  const delay = options.delay ?? defaultDelay
  let degradation: ChatSendDegradation | undefined

  for (let index = startCursor; index < segments.length; index += 1) {
    if (index > startCursor) {
      await delay(MULTI_DRAW_CHAT_INTERVAL_MS)
    }

    const segment = segments[index]
    if (!segment) {
      return { outcome: 'retryable', reason: `missing multi-draw segment ${index}` }
    }

    const rawOutcome = typeof chatService.sendChatMessageDetailed === 'function'
      ? options.beforeExternalSend
        ? await chatService.sendChatMessageDetailed(
            broadcasterTwitchUserId,
            segment.message,
            { beforeExternalSend: options.beforeExternalSend },
          )
        : await chatService.sendChatMessageDetailed(broadcasterTwitchUserId, segment.message)
      : (await chatService.sendChatMessage(broadcasterTwitchUserId, segment.message))
        ? { outcome: 'sent' as const }
        : { outcome: 'retryable' as const, reason: 'chat send failed' }

    if ('degradation' in rawOutcome && rawOutcome.degradation) {
      degradation = rawOutcome.degradation
    }

    if (rawOutcome.outcome === 'sent' || rawOutcome.outcome === 'duplicate') {
      const persisted = await options.afterSegmentComplete(index + 1)
      if (!persisted) {
        return degradation
          ? {
              outcome: 'aborted',
              reason: `multi-draw segment ${index + 1}/${segments.length} sent but cursor update lost its lease`,
              degradation,
            }
          : {
              outcome: 'aborted',
              reason: `multi-draw segment ${index + 1}/${segments.length} sent but cursor update lost its lease`,
            }
      }
      continue
    }

    if (rawOutcome.outcome === 'terminal') {
      return degradation
        ? { outcome: 'terminal', code: rawOutcome.code, reason: rawOutcome.reason, degradation }
        : { outcome: 'terminal', code: rawOutcome.code, reason: rawOutcome.reason }
    }
    if (rawOutcome.outcome === 'aborted') {
      return degradation
        ? { outcome: 'aborted', reason: rawOutcome.reason, degradation }
        : { outcome: 'aborted', reason: rawOutcome.reason }
    }
    return degradation
      ? { outcome: 'retryable', reason: rawOutcome.reason, degradation }
      : { outcome: 'retryable', reason: rawOutcome.reason }
  }

  return degradation ? { outcome: 'sent', degradation } : { outcome: 'sent' }
}
