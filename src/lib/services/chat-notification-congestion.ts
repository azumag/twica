import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'
import type { ClaimedChatNotification } from '@/lib/services/chat-notification-outbox'

/**
 * A channel must have at most one paced multi-draw sequence in flight.
 *
 * Two independent EventSub workers can otherwise each send every 1.6 seconds and combine
 * into an effective ~0.8 second channel cadence. The older queued/processing paced row wins;
 * newer rows should fall back to the existing summary message instead of waiting behind it.
 *
 * This is intentionally a read-only decision. The current row's snapshotted delivery_mode
 * remains unchanged so retries are deterministic; the same older-row ordering produces the
 * same fallback decision until that older row reaches sent/dead.
 */
export async function hasOlderPacedChatNotification(
  claim: Pick<ClaimedChatNotification, 'id' | 'createdAt'>,
  streamerId: string,
): Promise<boolean> {
  return withDbRetry(async () => {
    const { sql } = await getDb()
    const rows = await sql<Array<{ busy: boolean }>>`
      select exists (
        select 1
        from chat_notification_outbox older
        where older.id <> ${claim.id}::uuid
          and older.status in ('pending', 'processing')
          and older.delivery_mode in ('individual', 'chunked')
          and older.payload #>> '{streamer,id}' = ${streamerId}
          and (
            older.created_at < ${claim.createdAt}::timestamptz
            or (
              older.created_at = ${claim.createdAt}::timestamptz
              and older.id::text < ${claim.id}
            )
          )
      ) as busy
    `
    return rows[0]?.busy === true
  }, 'chat outbox paced congestion check', { idempotent: true })
}
