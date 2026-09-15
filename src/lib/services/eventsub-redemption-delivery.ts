import { resolveChatNotificationDeliveryMode } from '@/lib/services/chat-notification-congestion'
import {
  advanceChatNotificationDeliveryCursor,
  type ClaimedChatNotification,
} from '@/lib/services/chat-notification-outbox'
import {
  sendChatAnnouncement,
  type ChatAnnouncementOutcome,
  type RedemptionNotifyData,
} from './eventsub-redemption'
import {
  buildIndividualChatSnapshot,
  normalizeMultiDrawChatDeliveryMode,
  type MultiDrawChatSnapshot,
} from '@/lib/twitch/multi-draw-chat'
import { sendPacedMultiDrawChatAnnouncement } from '@/lib/twitch/paced-multi-draw-sender'

/**
 * Live notifications and the outbox relay must use the same snapshotted delivery mode
 * and cursor. Keep their existing ack, backoff and error reporting at the owning boundary;
 * this helper only sends and checkpoints the next unsent segment under the current lease.
 * The supplied fence runs immediately before each external send, after credential lookup.
 */
export async function sendClaimedChatAnnouncement(
  claim: ClaimedChatNotification,
  data: RedemptionNotifyData,
  beforeExternalSend: () => Promise<boolean>,
): Promise<ChatAnnouncementOutcome> {
  const drawnCards = data.gachaResult.cards?.length
    ? data.gachaResult.cards
    : [data.gachaResult.card]
  let mode = normalizeMultiDrawChatDeliveryMode(claim.deliveryMode)
  if (drawnCards.length > 1 && mode !== 'summary') {
    // Persist any congestion fallback before sending. Retry must keep that decision even
    // when the older sequence has completed, and a lost owner must not start a sequence.
    const resolvedMode = await resolveChatNotificationDeliveryMode(claim)
    if (resolvedMode === null) {
      return { outcome: 'aborted', reason: 'Chat delivery mode update lost its lease' }
    }
    mode = resolvedMode
  }

  if (drawnCards.length > 1 && mode !== 'summary') {
    // cardCounts is an additive outbox snapshot field for individual delivery. Older v1
    // payloads do not carry it; buildIndividualChatSnapshot has a deterministic fallback.
    const multiSnapshot = data.chatSnapshot as MultiDrawChatSnapshot | undefined
    return sendPacedMultiDrawChatAnnouncement(
      data.broadcasterTwitchUserId,
      drawnCards,
      data.gachaResult.userTwitchUsername,
      {
        deliveryMode: mode,
        chunkSize: claim.deliveryChunkSize,
        startCursor: claim.deliveryCursor ?? 0,
        beforeExternalSend,
        afterSegmentComplete: async (nextCursor) => {
          const persisted = await advanceChatNotificationDeliveryCursor(claim, nextCursor)
          if (persisted) claim.deliveryCursor = nextCursor
          return persisted
        },
        ...(mode === 'individual'
          ? {
              // Treat every paced card exactly like a normal one-card gacha for wording:
              // same custom/default template, rarity text, detail, URL and packName rules.
              sendIndividualCard: (card: typeof drawnCards[number], drawIndex: number) =>
                sendChatAnnouncement(
                  data.broadcasterTwitchUserId,
                  data.streamer,
                  card,
                  data.gachaResult.userTwitchUsername,
                  data.userId,
                  undefined,
                  data.gachaResult.collectionName,
                  buildIndividualChatSnapshot(drawnCards, drawIndex, multiSnapshot),
                  beforeExternalSend,
                ),
            }
          : {}),
      },
    )
  }

  // Preserve the legacy summary builder, including templates and card-list settings.
  return sendChatAnnouncement(
    data.broadcasterTwitchUserId,
    data.streamer,
    data.gachaResult.card,
    data.gachaResult.userTwitchUsername,
    data.userId,
    data.gachaResult.cards,
    data.gachaResult.collectionName,
    data.chatSnapshot,
    beforeExternalSend,
  )
}
