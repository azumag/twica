import type { GachaCard } from '@/lib/services/gacha'
import {
  TwitchChatService,
  type ChatSendDegradation,
  type ChatSendOutcome,
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
  /**
   * Issue #1665: deadlineAt/maxSegmentsの予算内に完走できなかった、正常な
   * 途中終了。terminal/retryable/abortedのいずれでもない、失敗ではない停止。
   * 呼び出し元（chat-notification-delivery.ts）はこれをcontinuationとして
   * 永続化し、通常の試行回数を消費しない。
   */
  | { outcome: 'deferred'; reason: 'budget' }
) & { degradation?: ChatSendDegradation }

export type ChatChannelGateResult =
  | { outcome: 'reserved' }
  | { outcome: 'budget-exhausted' }

export interface PacedMultiDrawSendOptions {
  deliveryMode: unknown
  chunkSize: unknown
  startCursor: number
  beforeExternalSend?: () => Promise<boolean>
  afterSegmentComplete: (nextCursor: number) => Promise<boolean>
  /**
   * individual時だけ使う1枚送信hook。productionでは通常の単発通知経路を渡し、
   * 配信者の単発テンプレートとplaceholder解決をそのまま再利用する。
   */
  sendIndividualCard?: (card: GachaCard, drawIndex: number) => Promise<PacedMultiDrawSendOutcome>
  /** unit test用。productionは固定1.6秒を使用する。 */
  delay?: (milliseconds: number) => Promise<void>
  chatService?: Pick<TwitchChatService, 'sendChatMessageDetailed' | 'sendChatMessage'>
  /**
   * Issue #1665: この時刻を過ぎたら新しいsegmentの送信を開始せずdeferredで
   * 返す。未指定時は無制限（既存の同期呼び出し元と完全に同じ挙動を維持する）。
   */
  deadlineAt?: number
  /**
   * Issue #1665: この呼び出しで送信するsegment数の上限。未指定時は無制限。
   */
  maxSegments?: number
  /**
   * Issue #1665: 指定時、各segment送信の直前にDBバックエンドのチャネル送信gate
   * （chat-channel-gate.ts）で予約してから送る。同じ配信者チャンネルへ向かう
   * 別のoutbox行・別の配送経路（summary/individual/chunked、別のN連バッチ）
   * との間隔も守れるようになる。
   *
   * 未指定時は従来通りプロセス内delay()のみで間隔を制御する（既存の同期経路
   * ＝postRedemptionNotify/eventsub-replayの現行動作を変えないため、新しい
   * bounded配送経路だけがこれを渡す）。
   */
  channelGate?: (deadlineAt: number) => Promise<ChatChannelGateResult>
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
 *
 * individualはproductionからsendIndividualCardを注入し、N連専用の固定文面ではなく
 * 通常の1枚ガチャと同じsendChatAnnouncement経路を使う。segment自体はcursor数と
 * fallback本文を決めるため残し、古い/独立callerでも決定的に再開できるようにする。
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
  let segmentsSentThisCall = 0

  const deferredOutcome = (): PacedMultiDrawSendOutcome => (
    degradation
      ? { outcome: 'deferred', reason: 'budget', degradation }
      : { outcome: 'deferred', reason: 'budget' }
  )

  for (let index = startCursor; index < segments.length; index += 1) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      return deferredOutcome()
    }
    if (options.maxSegments !== undefined && segmentsSentThisCall >= options.maxSegments) {
      return deferredOutcome()
    }

    if (options.channelGate) {
      // gate自身がチャネル全体の間隔を管理するため、プロセス内delay()は使わない
      // （二重に待つと間隔が不必要に伸びる）。最初のsegmentも含め毎回予約する:
      // continuation再開後は他のoutbox行が同じチャネルへ送信済みの可能性がある。
      const gateDeadline = options.deadlineAt ?? Number.POSITIVE_INFINITY
      const gateResult = await options.channelGate(gateDeadline)
      if (gateResult.outcome === 'budget-exhausted') {
        return deferredOutcome()
      }
    } else if (index > startCursor) {
      await delay(MULTI_DRAW_CHAT_INTERVAL_MS)
    }

    const segment = segments[index]
    if (!segment) {
      return { outcome: 'retryable', reason: `missing multi-draw segment ${index}` }
    }

    let rawOutcome: ChatSendOutcome | PacedMultiDrawSendOutcome
    if (mode === 'individual' && options.sendIndividualCard) {
      const card = cards[segment.startDraw - 1]
      if (!card) {
        return { outcome: 'retryable', reason: `missing multi-draw card ${segment.startDraw}` }
      }
      rawOutcome = await options.sendIndividualCard(card, segment.startDraw - 1)
    } else {
      rawOutcome = typeof chatService.sendChatMessageDetailed === 'function'
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
    }

    if ('degradation' in rawOutcome && rawOutcome.degradation) {
      degradation = rawOutcome.degradation
    }

    if (
      rawOutcome.outcome === 'sent'
      || rawOutcome.outcome === 'duplicate'
      || rawOutcome.outcome === 'skipped'
    ) {
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
      segmentsSentThisCall += 1
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
