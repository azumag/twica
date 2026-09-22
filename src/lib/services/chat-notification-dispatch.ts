/**
 * Issue #1665: 専用Cloudflare Queueへのenqueue-onlyディスパッチャ。
 *
 * Queueは「起床通知」に過ぎない。カード・本文・視聴者名・token・送り先URLは
 * 一切載せず、batchIdだけを運ぶ。実際の配送内容は必ずDB（chat_notification_outbox）
 * から読む（chat-notification-delivery.ts参照）。
 *
 * このモジュールは意図的にfail-openではなくfail-safeにする: Queue binding
 * 未設定・enqueue失敗はいずれも「成功扱いにしない」が、例外もthrowしない
 * （呼び出し元のガチャcommitパスを壊さない）。outboxのpending行はそのまま
 * 残り、既存の20分周期Cron relay（eventsub-replay route経由）が引き続き
 * 拾える。旧来の同期全件ループへは自動フォールバックしない
 * （Issue #1665設計: 「Queue binding未設定・Queue障害を成功扱いにせず…
 * 旧長時間ループへ自動フォールバックしない」）。
 *
 * 新経路は初期無効: dispatchEnabledはwrangler.tomlの[vars]に含めない
 * 環境変数(CHAT_DELIVERY_DISPATCH_ENABLED)で制御する。ロールアウト手順上、
 * これはmigration適用・専用Worker/Queueの配備が完了した後にのみ有効化する
 * 想定（Issue #1665 導入順序 Step 3以降）。root wrangler.tomlへの
 * queues.producersバインディング追加自体も、実際のCloudflare Queueリソースが
 * まだ存在しないためこのPRには含めない（追加するとQueue未作成の状態で
 * 本体workerのdeployが失敗する）。そのため現時点ではCHAT_NOTIFICATION_QUEUE
 * bindingは常に未設定であり、有効化フラグを立てても`unavailable`を返すだけで
 * 安全に無害化される。
 */
import { logger } from '@/lib/logger.server'
import { reportError } from '@/lib/sentry/error-handler'
import { reserveDueChatNotificationOutboxForWake } from '@/lib/services/chat-notification-outbox'

export const CHAT_DELIVERY_WAKEUP_VERSION = 1 as const

export interface ChatDeliveryWakeupV1 {
  version: typeof CHAT_DELIVERY_WAKEUP_VERSION
  batchId: string
}

interface QueueProducerLike {
  send(message: ChatDeliveryWakeupV1): Promise<void>
}

interface ChatDispatchEnvironment {
  dispatchEnabled: boolean
  queue: QueueProducerLike | undefined
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value?.trim().toLowerCase() === 'true'
}

function stringBinding(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function queueBinding(env: Record<string, unknown>): QueueProducerLike | undefined {
  const value = env.CHAT_NOTIFICATION_QUEUE
  return (
    typeof value === 'object'
    && value !== null
    && 'send' in value
    && typeof (value as { send: unknown }).send === 'function'
  ) ? value as QueueProducerLike : undefined
}

/**
 * Resolve dispatch configuration from the active Workers request, falling back
 * to process.env for next dev / Vitest（overlay-realtime/publisher.tsの
 * getPublisherEnvironmentと同じ理由・同じ構造）。
 */
async function getDispatchEnvironment(): Promise<ChatDispatchEnvironment> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    const runtimeEnv = env as unknown as Record<string, unknown>
    return {
      dispatchEnabled: isTruthyFlag(stringBinding(runtimeEnv, 'CHAT_DELIVERY_DISPATCH_ENABLED')),
      queue: queueBinding(runtimeEnv),
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      // Workersリクエストコンテキストが無い状態でのenqueueはfail-closed。
      logger.warn('[chat-notification-dispatch] runtime context unavailable', {
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      return { dispatchEnabled: false, queue: undefined }
    }
    return {
      dispatchEnabled: isTruthyFlag(process.env.CHAT_DELIVERY_DISPATCH_ENABLED),
      queue: undefined,
    }
  }
}

async function reportDispatchErrorSafely(error: unknown, context: Record<string, unknown>): Promise<void> {
  try {
    await reportError(error, context)
  } catch (reportingError) {
    logger.warn('[chat-notification-dispatch] failed to persist dispatch error', {
      context: context.context,
      error: reportingError instanceof Error ? reportingError.message : String(reportingError),
    })
  }
}

export type ChatDeliveryEnqueueOutcome =
  | { outcome: 'enqueued' }
  | { outcome: 'disabled' }
  | { outcome: 'unavailable'; reason: 'queue-binding-missing' | 'enqueue-failed' }

async function sendWakeup(
  env: Pick<ChatDispatchEnvironment, 'queue'>,
  batchId: string,
): Promise<ChatDeliveryEnqueueOutcome> {
  if (!env.queue) {
    logger.warn('[chat-notification-dispatch] queue binding unavailable', { batchId })
    return { outcome: 'unavailable', reason: 'queue-binding-missing' }
  }
  try {
    await env.queue.send({ version: CHAT_DELIVERY_WAKEUP_VERSION, batchId })
    return { outcome: 'enqueued' }
  } catch (error) {
    logger.warn('[chat-notification-dispatch] enqueue failed', {
      batchId,
      error: error instanceof Error ? error.message : String(error),
    })
    await reportDispatchErrorSafely(error, { context: 'chat-notification-dispatch:enqueue', batchId })
    return { outcome: 'unavailable', reason: 'enqueue-failed' }
  }
}

/**
 * ガチャcommit直後、またはbounded配送sliceがdeferred/retryableで終わった
 * 直後に呼ぶ。enqueueは正本ではなく最適化であり、失敗してもoutbox行は
 * pendingのまま残り、回収sweep（dispatchDueChatNotifications）または
 * 既存Cron relayが拾う。
 */
export async function enqueueChatNotificationWakeup(batchId: string): Promise<ChatDeliveryEnqueueOutcome> {
  const env = await getDispatchEnvironment()
  if (!env.dispatchEnabled) return { outcome: 'disabled' }
  return sendWakeup(env, batchId)
}

export interface DispatchDueChatNotificationsResult {
  reserved: number
  enqueued: number
  skippedDisabled: boolean
}

/**
 * due/lease失効行の回収sweeper用。予約に成功した行だけenqueueを試みる。
 * 1回あたりの上限（limit）・予約秒数は呼び出し元（内部HTTPエンドポイントの
 * dispatch-dueハンドラ）が決める。
 */
export async function dispatchDueChatNotifications(
  limit: number,
  reservationSeconds: number,
): Promise<DispatchDueChatNotificationsResult> {
  const env = await getDispatchEnvironment()
  if (!env.dispatchEnabled) return { reserved: 0, enqueued: 0, skippedDisabled: true }

  const candidates = await reserveDueChatNotificationOutboxForWake(limit, reservationSeconds)
  // 各行は互いに独立したenqueueであり、直列にawaitする理由がない
  // （sweepの壁時計時間が予約件数に比例して伸びるだけで、正しさ上の利点も
  // ない）。sendWakeupは自身のtry/catchで例外を吸収し必ずoutcomeを返すため
  // rejectしない。予約はreservationSecondsで自然に失効するため、enqueue
  // 失敗時に明示的なロールバックも不要（次回sweepが再度拾える）。
  const results = await Promise.all(
    candidates.map((candidate) => sendWakeup(env, candidate.batchId)),
  )
  const enqueued = results.filter((result) => result.outcome === 'enqueued').length
  return { reserved: candidates.length, enqueued, skippedDisabled: false }
}
