/**
 * Issue #1665: bounded chat delivery（専用Queue + 送信位置からの再開）。
 *
 * postRedemptionNotify()のchatTaskは、claim→decode→送信→ack/retry/deadを
 * 1回のHTTPレスポンス寿命（EventSub webhookのwaitUntil、実質30秒）の中で
 * 完走させる前提だった。N連の枚数が多いと `(N-1) * 1.6秒` の待機だけで
 * 30秒を超え得るため、この前提が本番のチャット通知欠落の原因になっていた
 * （Issue #1665参照）。
 *
 * このモジュールはそのclaim→送信→ackの一連の処理を「1回の呼び出しで
 * 送れるだけ送って、予算が尽きたら正常に途中終了する」bounded sliceへ
 * 分割する。呼び出し元（内部HTTPエンドポイント・専用Queue Worker）は、
 * 'deferred'/'retryable'を受け取ったら次のnextAttemptAt以降に新しい
 * wake-upをenqueueして続きを呼び出す。
 *
 * postRedemptionNotify()自体は変更しない（既存の同期経路は現状維持）。
 * このモジュールは新しいfeature-flagged経路（chat-notification-dispatch.ts）
 * からのみ呼ばれ、pending_kind/wake_reserved_until等の加法的列を参照する
 * chat-notification-outbox.tsの新関数群（claimChatNotificationForBoundedDelivery
 * 等）を使う。
 */
import { logger } from '@/lib/logger.server'
import { reportError } from '@/lib/sentry/error-handler'
import { CHAT_SEND_TERMINAL_CODES } from '@/lib/twitch/chat-service'
import { formatChatFailureReason } from '@/lib/twitch/chat-failure-reason'
import { MULTI_DRAW_CHAT_INTERVAL_MS } from '@/lib/twitch/multi-draw-chat'
import { reserveChatChannelSendSlot } from '@/lib/services/chat-channel-gate'
import {
  claimChatNotificationForBoundedDelivery,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  estimateChatOutboxRetryDelayMs,
  markChatNotificationSent,
  releaseChatNotificationForContinuation,
  renewChatNotificationLease,
  retryChatNotificationForBoundedDelivery,
} from '@/lib/services/chat-notification-outbox'
import { sendClaimedChatAnnouncement } from '@/lib/services/eventsub-redemption-delivery'

/** アプリ内時間予算の既定値（Issue #1665設計案）。API待ち・token処理・DB checkpointを含む。 */
export const DEFAULT_CHAT_DELIVERY_TIME_BUDGET_MS = 20_000
/** 1回のsliceで送信するsegment数の上限の既定値。 */
export const DEFAULT_CHAT_DELIVERY_MAX_SEGMENTS = 4
/**
 * continuationの次回試行までの最小間隔。0にすると、DB commitの可視性が
 * 追いつく前に次のwake-upがclaimを試みてnext_attempt_at<=nowの判定に
 * ぎりぎり失敗する（無害だが無駄な1往復）ケースを避けるための小さな余裕。
 */
const CONTINUATION_MIN_DELAY_MS = 250

export type ChatDeliverySliceOutcome =
  | { kind: 'complete' }
  | { kind: 'terminal'; code: string }
  /** 予算内に完走できなかった正常な途中終了。試行回数は消費していない。 */
  | { kind: 'deferred'; nextAttemptAt: string }
  /** 一時障害（429/5xx/timeout等）。試行回数を消費済み。 */
  | { kind: 'retryable'; nextAttemptAt: string }
  /** DB ack/retry/dead更新がleaseを失った。所有権は別ownerかsweep回収へ委ねる。 */
  | { kind: 'lease_lost' }
  /**
   * claimできなかった（既にsent/dead、まだdueでない、別ownerが処理中、
   * batchIdが存在しない等）。呼び出し元はこれを一律成功と解釈しない
   * （Issue #1665の必須契約）が、追加のアクションも不要。
   */
  | { kind: 'not_claimable' }

/**
 * best-effortでエラーを永続化する。reportError自体が失敗しても、既に確定した
 * DB状態遷移（ack/retry/dead）を巻き戻さない。postRedemptionNotifyの
 * reportNotificationErrorと同じ防御。
 */
async function reportDeliveryError(error: unknown, context: Record<string, unknown>): Promise<void> {
  try {
    await reportError(error, context)
  } catch (reportingError) {
    logger.warn('[chat-notification-delivery] failed to persist delivery error', {
      context: context.context,
      error: reportingError instanceof Error ? reportingError.message : String(reportingError),
    })
  }
}

export interface DeliverChatNotificationSliceOptions {
  timeBudgetMs?: number
  maxSegments?: number
}

/**
 * 指定batchIdのchat outbox行を1sliceぶんだけ配送する。
 *
 * 呼び出し前提: claimに成功した場合のみDB状態を変更する。claim失敗
 * （既に終端状態・まだdueでない・別owner処理中）は何もせず'not_claimable'を
 * 返す。予算内に完走できればcomplete、途中で予算が尽きればdeferred、
 * 一時障害が発生すればretryable（上限到達ならterminal）を返す。
 */
export async function deliverChatNotificationSlice(
  batchId: string,
  options: DeliverChatNotificationSliceOptions = {},
): Promise<ChatDeliverySliceOutcome> {
  const claim = await claimChatNotificationForBoundedDelivery(batchId)
  if (!claim) return { kind: 'not_claimable' }

  const timeBudgetMs = Math.max(1_000, Math.min(
    options.timeBudgetMs ?? DEFAULT_CHAT_DELIVERY_TIME_BUDGET_MS,
    60_000,
  ))
  const maxSegments = Math.max(1, Math.min(options.maxSegments ?? DEFAULT_CHAT_DELIVERY_MAX_SEGMENTS, 50))
  const deadlineAt = Date.now() + timeBudgetMs

  const data = decodeChatNotificationPayload(claim)
  if (!data) {
    const reason = `transactional chat outbox payload v${claim.payloadVersion} is invalid`
    const persisted = await deadLetterChatNotification(claim, reason)
    if (!persisted) return { kind: 'lease_lost' }
    await reportDeliveryError(new Error(`[chat-notification-delivery] ${reason}`), {
      context: 'chat-notification-delivery:invalidPayload',
      outboxId: claim.id,
      batchId,
    })
    return { kind: 'terminal', code: 'invalid_payload' }
  }

  const beforeExternalSend = async (): Promise<boolean> => {
    if (Date.now() >= deadlineAt) return false
    const renewed = await renewChatNotificationLease(claim)
    return renewed && Date.now() < deadlineAt
  }

  let deliveryStatePersisted = false
  const logContext = {
    outboxId: claim.id,
    batchId,
    streamerId: data.streamer.id,
    broadcasterTwitchUserId: data.broadcasterTwitchUserId,
  }

  try {
    const outcome = await sendClaimedChatAnnouncement(claim, data, beforeExternalSend, {
      deadlineAt,
      maxSegments,
      channelGate: (gateDeadlineAt) => reserveChatChannelSendSlot(data.broadcasterTwitchUserId, {
        intervalMs: MULTI_DRAW_CHAT_INTERVAL_MS,
        deadlineAt: gateDeadlineAt,
      }),
    })

    if (outcome.outcome === 'sent' || outcome.outcome === 'skipped') {
      const persisted = await markChatNotificationSent(claim)
      deliveryStatePersisted = true
      if (!persisted) {
        await reportDeliveryError(
          new Error('[chat-notification-delivery] chat sent but outbox ack lost its lease'),
          { context: 'chat-notification-delivery:ackLostLease', ...logContext },
        )
        return { kind: 'lease_lost' }
      }
      if (outcome.degradation) {
        logger.warn('[chat-notification-delivery] chat sent using fallback sender', {
          ...logContext,
          degradation: outcome.degradation,
        })
        await reportDeliveryError(
          new Error(`Chat delivery used fallback sender: ${outcome.degradation.reason}`),
          { context: 'chat-notification-delivery:chatDegradation', ...logContext, degradation: outcome.degradation },
        )
      }
      return { kind: 'complete' }
    }

    if (outcome.outcome === 'deferred') {
      const nextAttemptAt = new Date(Date.now() + CONTINUATION_MIN_DELAY_MS)
      const persisted = await releaseChatNotificationForContinuation(claim, nextAttemptAt)
      deliveryStatePersisted = true
      if (!persisted) return { kind: 'lease_lost' }
      logger.info('[chat-notification-delivery] slice deferred - budget exhausted', {
        ...logContext,
        nextAttemptAt: nextAttemptAt.toISOString(),
      })
      return { kind: 'deferred', nextAttemptAt: nextAttemptAt.toISOString() }
    }

    if (outcome.outcome === 'terminal') {
      const reason = formatChatFailureReason(outcome.reason, outcome.degradation)
      const persisted = await deadLetterChatNotification(claim, reason)
      deliveryStatePersisted = true
      if (!persisted) {
        await reportDeliveryError(
          new Error(`[chat-notification-delivery] DLQ update lost its lease: ${reason}`),
          { context: 'chat-notification-delivery:dlqLostLease', ...logContext },
        )
        return { kind: 'lease_lost' }
      }
      // scope不足は配信者の再認証待ちのユーザー操作待ちであり、コード不具合では
      // ない。既存postRedemptionNotifyと同じくreportErrorせずinfoに留める。
      if (outcome.code === CHAT_SEND_TERMINAL_CODES.MISSING_SCOPE) {
        logger.info('[chat-notification-delivery] moved to DLQ pending Twitch reauthorization', {
          ...logContext,
          code: outcome.code,
          reason: outcome.reason,
        })
      } else {
        await reportDeliveryError(
          new Error(`[chat-notification-delivery] moved to DLQ: ${reason}`),
          { context: 'chat-notification-delivery:dlq', ...logContext, code: outcome.code },
        )
      }
      return { kind: 'terminal', code: outcome.code }
    }

    if (outcome.outcome === 'aborted') {
      // leaseを失った（またはfence確認不能な）所有者は状態を上書きしない。
      // 新所有者かsweepの回収に委ねる（DB writeはしない）。
      //
      // 既知のtrade-off: このfence（beforeExternalSend）はlease喪失と
      // deadline到達を区別できずどちらも'aborted'にする
      // （chat-service.ts/paced-multi-draw-sender.tsの契約）。segmentの
      // 429/5xxリトライ中にdeadlineへ到達した場合もここへ来るため、正常な
      // 予算切れのはずが、回収後はclaimChatNotificationForBoundedDeliveryの
      // クラッシュ回収分岐（processing+lease失効）を通りattempt_countを
      // 消費する。lease喪失時にDB状態を上書きしない安全側の原則
      // （新所有者の処理中状態を壊さない）をdeadline側でも譲れないため、
      // ここをdeferred（試行回数を消費しない）へread替えることはしない。
      // 実害は「試行回数を1つ余分に消費し、最大60秒+sweep周期だけ遅れて
      // 回収される」ことに留まり、CHAT_OUTBOX_MAX_ATTEMPTSの有限上限で
      // 依然bound済み。ここでのreportErrorはsent/DLQ/retryの各分岐と同様に
      // 運用側が検知できるようにするためのものであり、状態遷移は変えない。
      deliveryStatePersisted = true
      await reportDeliveryError(
        new Error(`[chat-notification-delivery] aborted before an external send completed: ${
          formatChatFailureReason(outcome.reason, outcome.degradation)
        }`),
        { context: 'chat-notification-delivery:aborted', ...logContext },
      )
      return { kind: 'lease_lost' }
    }

    // retryable
    const reason = formatChatFailureReason(outcome.reason, outcome.degradation)
    const state = await retryChatNotificationForBoundedDelivery(claim, reason)
    deliveryStatePersisted = true
    if (state === 'lost-lease') {
      await reportDeliveryError(
        new Error('[chat-notification-delivery] retry update lost its lease'),
        { context: 'chat-notification-delivery:retryLostLease', ...logContext },
      )
      return { kind: 'lease_lost' }
    }
    if (state === 'dead') {
      await reportDeliveryError(
        new Error(`[chat-notification-delivery] exhausted retries: ${reason}`),
        { context: 'chat-notification-delivery:retriesExhausted', ...logContext },
      )
      return { kind: 'terminal', code: 'retries_exhausted' }
    }
    const estimatedNextAttemptAt = new Date(
      Date.now() + estimateChatOutboxRetryDelayMs(claim.attemptCount),
    )
    logger.info('[chat-notification-delivery] slice retry scheduled', {
      ...logContext,
      reason,
      nextAttemptAt: estimatedNextAttemptAt.toISOString(),
    })
    return { kind: 'retryable', nextAttemptAt: estimatedNextAttemptAt.toISOString() }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (!deliveryStatePersisted) {
      await retryChatNotificationForBoundedDelivery(claim, reason)
    }
    await reportDeliveryError(error, { context: 'chat-notification-delivery:unexpected', ...logContext })
    throw error
  }
}
