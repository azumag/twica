export {
  handleRaidNotification,
  handleRedemption,
  runInBackground,
  sendChatAnnouncement,
} from './eventsub-redemption'
export type {
  ChatAnnouncementOutcome,
  ChatAnnouncementSnapshot,
  RedemptionNotifyData,
  RedemptionOutcome,
} from './eventsub-redemption'

import { publishCommittedGachaBatch } from '@/lib/overlay-realtime/publisher'
import { logger } from '@/lib/logger.server'
import { reportError } from '@/lib/sentry/error-handler'
import {
  advanceChatNotificationDeliveryCursor,
  claimChatNotificationBatch,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  markChatNotificationSent,
  renewChatNotificationLease,
  retryChatNotification,
  type ClaimedChatNotification,
} from '@/lib/services/chat-notification-outbox'
import {
  postRedemptionNotify as legacyPostRedemptionNotify,
  sendChatAnnouncement,
  type ChatAnnouncementOutcome,
  type RedemptionNotifyData,
} from './eventsub-redemption'
import { CHAT_SEND_TERMINAL_CODES } from '@/lib/twitch/chat-service'
import { formatChatFailureReason } from '@/lib/twitch/chat-failure-reason'
import { normalizeMultiDrawChatDeliveryMode } from '@/lib/twitch/multi-draw-chat'
import { sendPacedMultiDrawChatAnnouncement } from '@/lib/twitch/paced-multi-draw-sender'

async function reportNotificationError(
  error: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await reportError(error, context)
  } catch (reportingError) {
    logger.warn('[EventSub] Failed to persist notification error', {
      context: context.context,
      error: reportingError instanceof Error
        ? reportingError.message
        : String(reportingError),
    })
  }
}

async function deliverClaimedChatNotification(
  claim: ClaimedChatNotification,
  data: RedemptionNotifyData,
  options: { externalSendDeadlineAt?: number },
): Promise<void> {
  let deliveryStatePersisted = false
  try {
    const persistedData = decodeChatNotificationPayload(claim)
    if (!persistedData) {
      const persisted = await deadLetterChatNotification(
        claim,
        `transactional chat outbox payload v${claim.payloadVersion} is invalid`,
      )
      deliveryStatePersisted = true
      throw new Error(
        persisted
          ? 'Chat announcement payload moved to DLQ'
          : 'Chat announcement payload DLQ update lost its lease',
      )
    }

    const beforeExternalSend = async () => {
      if (
        options.externalSendDeadlineAt !== undefined
        && Date.now() >= options.externalSendDeadlineAt
      ) {
        return false
      }
      const renewed = await renewChatNotificationLease(claim)
      return renewed && (
        options.externalSendDeadlineAt === undefined
        || Date.now() < options.externalSendDeadlineAt
      )
    }

    const drawnCards = persistedData.gachaResult.cards
      && persistedData.gachaResult.cards.length > 0
      ? persistedData.gachaResult.cards
      : [persistedData.gachaResult.card]
    const mode = normalizeMultiDrawChatDeliveryMode(claim.deliveryMode)
    const usePacedDelivery = drawnCards.length > 1 && mode !== 'summary'

    const outcome: ChatAnnouncementOutcome = usePacedDelivery
      ? await sendPacedMultiDrawChatAnnouncement(
          persistedData.broadcasterTwitchUserId,
          drawnCards,
          persistedData.gachaResult.userTwitchUsername,
          {
            deliveryMode: mode,
            chunkSize: claim.deliveryChunkSize,
            startCursor: claim.deliveryCursor,
            beforeExternalSend,
            afterSegmentComplete: async (nextCursor) => {
              const persisted = await advanceChatNotificationDeliveryCursor(claim, nextCursor)
              if (persisted) {
                claim.deliveryCursor = nextCursor
              }
              return persisted
            },
          },
        )
      : await sendChatAnnouncement(
          persistedData.broadcasterTwitchUserId,
          persistedData.streamer,
          persistedData.gachaResult.card,
          persistedData.gachaResult.userTwitchUsername,
          persistedData.userId,
          persistedData.gachaResult.cards,
          persistedData.gachaResult.collectionName,
          persistedData.chatSnapshot,
          beforeExternalSend,
        )

    if (outcome.outcome === 'sent' || outcome.outcome === 'skipped') {
      const persisted = await markChatNotificationSent(claim)
      deliveryStatePersisted = true
      if (!persisted) {
        throw new Error(formatChatFailureReason(
          'Chat announcement sent but outbox ack lost its lease',
          outcome.degradation,
        ))
      }
      if (outcome.degradation) {
        logger.warn('[postRedemptionNotify] Chat sent using fallback sender', {
          streamerId: data.streamer.id,
          broadcasterTwitchUserId: data.broadcasterTwitchUserId,
          degradation: outcome.degradation,
        })
        await reportNotificationError(
          new Error(`Chat delivery used fallback sender: ${outcome.degradation.reason}`),
          {
            context: 'eventsub:postRedemptionNotify:chatDegradation',
            streamerId: data.streamer.id,
            broadcasterTwitchUserId: data.broadcasterTwitchUserId,
            degradation: outcome.degradation,
          },
        )
      }
      return
    }

    const failureReason = formatChatFailureReason(outcome.reason, outcome.degradation)
    if (outcome.outcome === 'terminal') {
      const persisted = await deadLetterChatNotification(claim, failureReason)
      deliveryStatePersisted = true
      if (!persisted) {
        throw new Error(`Chat announcement DLQ update lost its lease: ${failureReason}`)
      }
      if (outcome.code === CHAT_SEND_TERMINAL_CODES.MISSING_SCOPE) {
        logger.warn('[postRedemptionNotify] chat announcement moved to DLQ pending Twitch reauthorization', {
          code: outcome.code,
          reason: outcome.reason,
          streamerId: data.streamer.id,
          broadcasterTwitchUserId: data.broadcasterTwitchUserId,
          outboxId: claim.id,
        })
        return
      }
      throw new Error(`Chat announcement moved to DLQ: ${failureReason}`)
    }
    if (outcome.outcome === 'aborted') {
      deliveryStatePersisted = true
      throw new Error(`Chat announcement aborted: ${failureReason}`)
    }

    const retryState = await retryChatNotification(claim, failureReason)
    deliveryStatePersisted = true
    if (retryState === 'pending') {
      logger.info('[postRedemptionNotify] chat announcement retry scheduled', {
        streamerId: data.streamer.id,
        broadcasterTwitchUserId: data.broadcasterTwitchUserId,
        outboxId: claim.id,
        deliveryCursor: claim.deliveryCursor,
        reason: failureReason,
      })
      return
    }
    throw new Error(`Chat announcement ${retryState}: ${failureReason}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (!deliveryStatePersisted) {
      await retryChatNotification(claim, reason)
    }
    throw error
  }
}

/**
 * Delivery wrapper for Issue #1549. Summary mode stays on the existing message builder.
 * Individual/chunked mode sends deterministic segments and checkpoints the next segment
 * cursor after every Twitch-confirmed send, so retry resumes without replaying earlier cards.
 */
export async function postRedemptionNotify(
  data: RedemptionNotifyData,
  options: { externalSendDeadlineAt?: number } = {},
): Promise<void> {
  if (!data.streamer.chat_announcement_enabled) {
    await legacyPostRedemptionNotify(data, options)
    return
  }

  const chatTask = (async () => {
    const claim = await claimChatNotificationBatch(data.batchId)
    if (!claim) return
    await deliverClaimedChatNotification(claim, data, options)
  })()

  const results = await Promise.allSettled([
    publishCommittedGachaBatch(data.streamer.id, data.gachaResult, {
      batchId: data.batchId,
      maxRetries: 1,
      retryDelay: 500,
    }),
    chatTask,
  ])

  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    const { contextLabel, displayLabel } = index === 0
      ? { contextLabel: 'broadcast', displayLabel: 'broadcast' }
      : { contextLabel: 'chatAnnouncement', displayLabel: 'chat announcement' }
    logger.warn(`[postRedemptionNotify] ${displayLabel} failed`, {
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      streamerId: data.streamer.id,
    })
    await reportNotificationError(result.reason, {
      context: `eventsub:postRedemptionNotify:${contextLabel}`,
      streamerId: data.streamer.id,
      broadcasterTwitchUserId: data.broadcasterTwitchUserId,
    })
  }
}
