import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'
import type { ClaimedChatNotification } from '@/lib/services/chat-notification-outbox'
import { MULTI_DRAW_CHAT_DELIVERY_MODES, type MultiDrawChatDeliveryMode } from '@/lib/twitch/multi-draw-chat'

/**
 * Resolve and persist the first delivery decision under a per-channel DB lock.
 * The RPC reads the channel from the stored payload and fences the decision by lease.
 * Persisting both a paced reservation and a summary fallback makes retries deterministic,
 * including when an older INSERT transaction commits after another row starts delivery.
 */
export async function resolveChatNotificationDeliveryMode(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
): Promise<MultiDrawChatDeliveryMode | null> {
  return withDbRetry(async () => {
    const { sql } = await getDb()
    const rows = await sql<Array<{ mode: MultiDrawChatDeliveryMode | null }>>`
      select public.resolve_chat_outbox_delivery_mode(${claim.id}::uuid, ${claim.leaseId}::uuid) as mode
    `
    const mode = rows[0]?.mode
    // Empty/unknown responses must never be interpreted as permission to send.
    return mode && MULTI_DRAW_CHAT_DELIVERY_MODES.includes(mode) ? mode : null
  }, 'chat outbox delivery mode reservation', { idempotent: true })
}
