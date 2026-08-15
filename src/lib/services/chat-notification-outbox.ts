/**
 * Issue #708: PlanetScale transactional chat outbox のclaim/ack境界。
 *
 * payload作成はexecute_gacha_transaction_with_chat_outbox内でカード付与と
 * 同時commitされる。
 * このモジュールは外部Twitch APIをDB transaction外で実行できるよう、短い
 * owner-fenced UPDATEだけで配送権を取得・完了する。配送はat-least-onceであり、
 * Twitch送信成功後からmarkSent前の停止時にはlease失効後に重複し得る。
 */
import { getDb } from '@/lib/db/client'
import type { RedemptionNotifyData } from '@/lib/services/eventsub-redemption'

export const CHAT_OUTBOX_MAX_ATTEMPTS = 5
// Helix送信は最大3試行（各試行timeout + backoff）を含むため、通常の最悪時間より
// 十分長い60秒を確保する。短すぎるleaseは、まだ送信中の行をCronが再claimして
// 同時に二重送信するため、waitUntilの寿命より配送処理の上限を基準にする。
export const CHAT_OUTBOX_LEASE_SECONDS = 60
export const CHAT_OUTBOX_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const
export const CHAT_OUTBOX_SENT_RETENTION_DAYS = 7
export const CHAT_OUTBOX_DEAD_RETENTION_DAYS = 30

export interface ClaimedChatNotification {
  id: string
  batchId: string
  payloadVersion: number
  payload: unknown
  leaseId: string
  attemptCount: number
  createdAt: string
}

export interface ChatNotificationOutboxWorkItem {
  id: string
  batchId: string
  createdAt: string
}

interface ClaimedRow {
  id: string
  batch_id: string
  payload_version: number
  payload: unknown
  lease_id: string
  attempt_count: number
  created_at: string
}

function toClaimed(row: ClaimedRow): ClaimedChatNotification {
  return {
    id: row.id,
    batchId: row.batch_id,
    payloadVersion: Number(row.payload_version),
    payload: row.payload,
    leaseId: row.lease_id,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
  }
}

function isGachaCard(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Record<string, unknown>
  return typeof card.id === 'string'
    && typeof card.name === 'string'
    && typeof card.rarity === 'string'
    && typeof card.drop_rate === 'number'
    && (card.description === null || typeof card.description === 'string')
    && (card.image_url === null || typeof card.image_url === 'string')
    // Issue #948 の additive field。旧 payload はキー欠落（undefined）を許容し、
    // 新 payload は text 列由来の string|null のみ通す。rewardId 等の他 optional
    // string と同じ検証水準に揃える防御であり、正当な行を DLQ 化する余地はない。
    && isOptionalNullableString(card.collection_name)
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

/**
 * 永続payload v1のdecoder。claimのbatch/versionとpayloadを相互検証し、deploy間で
 * shapeが変わっても未知versionを誤配送せずDLQへ送れるようにする。
 */
export function decodeChatNotificationPayload(
  claim: Pick<ClaimedChatNotification, 'batchId' | 'payloadVersion' | 'payload'>,
): RedemptionNotifyData | null {
  if (claim.payloadVersion !== 1 || typeof claim.payload !== 'object' || claim.payload === null) {
    return null
  }
  const candidate = claim.payload as Partial<RedemptionNotifyData>
  const streamer = candidate.streamer as unknown as Record<string, unknown> | null
  const result = candidate.gachaResult as unknown as Record<string, unknown> | null
  const snapshot = candidate.chatSnapshot as unknown as Record<string, unknown> | null
  if (
    candidate.batchId !== claim.batchId
    || typeof candidate.broadcasterTwitchUserId !== 'string'
    || typeof candidate.userId !== 'string'
    || streamer === null
    || typeof streamer !== 'object'
    || typeof streamer.id !== 'string'
    || typeof streamer.chat_announcement_enabled !== 'boolean'
    || typeof streamer.chat_announcement_multi_show_cards !== 'boolean'
    || !isOptionalNullableString(streamer.chat_announcement_template)
    || !isOptionalNullableString(streamer.chat_announcement_multi_template)
    || !isOptionalNullableString(streamer.default_card_pack_name)
    || result === null
    || typeof result !== 'object'
    || result.type !== 'gacha'
    || typeof result.userTwitchUsername !== 'string'
    || !isGachaCard(result.card)
    || !isOptionalNullableString(result.rewardId)
    || !isOptionalNullableString(result.collectionName)
    || !Array.isArray(result.cards)
    || result.cards.length === 0
    || !result.cards.every(isGachaCard)
    || snapshot === null
    || typeof snapshot !== 'object'
    || !Number.isInteger(snapshot.cardCount)
    || (snapshot.cardCount as number) < 0
    || !Number.isInteger(snapshot.uniqueCount)
    || (snapshot.uniqueCount as number) < 0
    || !Number.isInteger(snapshot.allCount)
    || (snapshot.allCount as number) < 0
    || !Array.isArray(snapshot.newCardNames)
    || !snapshot.newCardNames.every((name) => typeof name === 'string')
    // payload v1へのadditive field。migration先行中の旧workerは余分なfieldを無視でき、
    // app先行中の新workerはfieldが無い既存outboxを判定不能として安全に配送できる。
    || (snapshot.newCardNamesResolved !== undefined
      && typeof snapshot.newCardNamesResolved !== 'boolean')
  ) {
    return null
  }
  return candidate as RedemptionNotifyData
}

/**
 * Workerのdry-run peek用。claim可能行に加え、DLQ化・保持期限削除だけが必要な場合も
 * 1件返し、KV backlogが0件でも次の実relay呼び出しを起動させる。状態変更はしない。
 */
export async function peekChatNotificationOutboxWork(
  limit: number,
): Promise<ChatNotificationOutboxWorkItem[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100))
  const { sql } = await getDb()
  const rows = await sql<Array<{ id: string; batch_id: string; created_at: string }>>`
    select id, batch_id, created_at
    from chat_notification_outbox
    where (
      attempt_count < ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
      and (
        (status = 'pending' and next_attempt_at <= now())
        or (status = 'processing' and lease_expires_at <= now())
      )
    ) or (
      status = 'processing'
      and lease_expires_at <= now()
      and attempt_count >= ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
    ) or (
      status = 'sent'
      and sent_at <= now() - (${CHAT_OUTBOX_SENT_RETENTION_DAYS}::integer * interval '1 day')
    ) or (
      status = 'dead'
      and dead_at <= now() - (${CHAT_OUTBOX_DEAD_RETENTION_DAYS}::integer * interval '1 day')
    )
    order by created_at asc
    limit ${safeLimit}::integer
  `
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    createdAt: row.created_at,
  }))
}

/**
 * Cron relayだけが行う保持期限メンテナンス。
 *
 * live EventSub claimごとに実行するとガチャ1回あたり余計なDB writeを増やすため、
 * 20分間隔のrelayへ集約する。sentは7日、調査・手動回収用deadは30日で削除し、
 * JSON payloadを無期限に残さない。
 */
async function maintainChatNotificationOutbox(): Promise<void> {
  const { sql } = await getDb()
  await sql`
    update chat_notification_outbox
    set status = 'dead',
        dead_at = now(),
        lease_id = null,
        lease_expires_at = null,
        last_error = coalesce(last_error, 'delivery lease expired after max attempts'),
        updated_at = now()
    where status = 'processing'
      and lease_expires_at <= now()
      and attempt_count >= ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
  `
  await sql`
    delete from chat_notification_outbox
    where (
      status = 'sent'
      and sent_at <= now() - (${CHAT_OUTBOX_SENT_RETENTION_DAYS}::integer * interval '1 day')
    ) or (
      status = 'dead'
      and dead_at <= now() - (${CHAT_OUTBOX_DEAD_RETENTION_DAYS}::integer * interval '1 day')
    )
  `
}

/** ライブEventSub処理が、自分のbatchだけをclaimする。 */
export async function claimChatNotificationBatch(
  batchId: string,
): Promise<ClaimedChatNotification | null> {
  const leaseId = crypto.randomUUID()
  const { sql } = await getDb()
  const rows = await sql<ClaimedRow[]>`
    update chat_notification_outbox
    set status = 'processing',
        lease_id = ${leaseId}::uuid,
        lease_expires_at = now() + (${CHAT_OUTBOX_LEASE_SECONDS}::integer * interval '1 second'),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where batch_id = ${batchId}
      and attempt_count < ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
      and (
        (status = 'pending' and next_attempt_at <= now())
        or (status = 'processing' and lease_expires_at <= now())
      )
    returning id, batch_id, payload_version, payload, lease_id, attempt_count, created_at
  `
  return rows[0] ? toClaimed(rows[0]) : null
}

/**
 * Cron/手動relayが次の1件だけを期限到来順にclaimする。複数件を先にまとめて
 * leaseすると、後半は送信開始前に期限切れし得るため、引数に関係なく最大1件とする。
 * 呼び出し側は送信・ack後に再度claimし、各行へ送信直前の60秒leaseを与える。
 */
export async function claimDueChatNotifications(
  _limit: number,
  options: { maintain?: boolean } = {},
): Promise<ClaimedChatNotification[]> {
  if (options.maintain !== false) {
    await maintainChatNotificationOutbox()
  }
  const leaseId = crypto.randomUUID()
  const safeLimit = 1
  const { sql } = await getDb()
  const rows = await sql<ClaimedRow[]>`
    with candidates as (
      select id
      from chat_notification_outbox
      where attempt_count < ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and lease_expires_at <= now())
        )
      order by next_attempt_at asc, created_at asc
      for update skip locked
      limit ${safeLimit}::integer
    )
    update chat_notification_outbox as outbox
    set status = 'processing',
        lease_id = ${leaseId}::uuid,
        lease_expires_at = now() + (${CHAT_OUTBOX_LEASE_SECONDS}::integer * interval '1 second'),
        attempt_count = outbox.attempt_count + 1,
        updated_at = now()
    from candidates
    where outbox.id = candidates.id
    returning outbox.id, outbox.batch_id, outbox.payload_version, outbox.payload,
              outbox.lease_id, outbox.attempt_count, outbox.created_at
  `
  return rows.map(toClaimed)
}

/**
 * Twitchへの各外部送信の直前に、現在のclaim所有者だけがleaseを延長する。
 *
 * token取得・refreshやDB retryは初回claim後に実行されるため、固定60秒leaseだけ
 * では資格情報の解決中に別relayが同じ行を再claimし、その後に旧所有者も送信する
 * 競合が残る。外部API直前のowner-fenced UPDATEを送信可否の最終判定にすることで、
 * 既に新しいleaseへ引き継がれた旧所有者はTwitchへ到達する前に停止できる。
 */
export async function renewChatNotificationLease(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
): Promise<boolean> {
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set lease_expires_at = now() + (${CHAT_OUTBOX_LEASE_SECONDS}::integer * interval '1 second'),
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1
}

/** Twitch送信成功または設定上のskipを、claim所有者だけが完了できる。 */
export async function markChatNotificationSent(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
): Promise<boolean> {
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set status = 'sent',
        sent_at = now(),
        lease_id = null,
        lease_expires_at = null,
        last_error = null,
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1
}

/** scope/credential/4xx/payload破損など、再試行しても直らない行をDLQ化する。 */
export async function deadLetterChatNotification(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
  reason: string,
): Promise<boolean> {
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set status = 'dead',
        dead_at = now(),
        lease_id = null,
        lease_expires_at = null,
        last_error = left(${reason}::text, 2000),
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1
}

/**
 * 一時障害を指数的backoffで再予定する。claim時にattempt_countは増えているため、
 * 5回目の失敗はpendingへ戻さずその場でDLQ化する。
 */
export async function retryChatNotification(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId' | 'attemptCount'>,
  reason: string,
): Promise<'pending' | 'dead' | 'lost-lease'> {
  if (claim.attemptCount >= CHAT_OUTBOX_MAX_ATTEMPTS) {
    return await deadLetterChatNotification(claim, reason) ? 'dead' : 'lost-lease'
  }

  const delayIndex = Math.min(
    claim.attemptCount - 1,
    CHAT_OUTBOX_RETRY_DELAYS_MS.length - 1,
  )
  const delayMs = CHAT_OUTBOX_RETRY_DELAYS_MS[Math.max(0, delayIndex)]
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set status = 'pending',
        next_attempt_at = now() + (${delayMs}::integer * interval '1 millisecond'),
        lease_id = null,
        lease_expires_at = null,
        last_error = left(${reason}::text, 2000),
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1 ? 'pending' : 'lost-lease'
}
