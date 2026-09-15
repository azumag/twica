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

function hasCompleteIndividualCardCountSnapshot(
  cards: RedemptionNotifyData['gachaResult']['cards'],
  snapshot: MultiDrawChatSnapshot | undefined,
): boolean {
  if (!cards?.length || !snapshot?.cardCounts || Array.isArray(snapshot.cardCounts)) return false

  const drawnCounts = new Map<string, number>()
  for (const card of cards) {
    drawnCounts.set(card.id, (drawnCounts.get(card.id) ?? 0) + 1)
  }

  let newlyAcquiredTypes = 0
  for (const [cardId, drawnCount] of drawnCounts) {
    const finalCount = snapshot.cardCounts[cardId]
    if (!Number.isInteger(finalCount) || finalCount < drawnCount) return false
    if (finalCount === drawnCount) newlyAcquiredTypes += 1
  }
  return snapshot.uniqueCount >= newlyAcquiredTypes
}

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
    // cardCounts is an additive outbox snapshot field for individual delivery. Pre-migration
    // rows intentionally stay on the deterministic structural fallback rather than re-reading
    // mutable ownership state or rendering inaccurate custom count placeholders.
    const multiSnapshot = data.chatSnapshot as MultiDrawChatSnapshot | undefined
    const useSingleDrawTemplate = mode === 'individual'
      && hasCompleteIndividualCardCountSnapshot(drawnCards, multiSnapshot)
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
        ...(useSingleDrawTemplate
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
