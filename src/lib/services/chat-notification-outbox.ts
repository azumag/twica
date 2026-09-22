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
import type { MultiDrawChatDeliveryMode } from '@/lib/twitch/multi-draw-chat'

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
  /** Issue #1549 additive fields. Optional keeps legacy test doubles/source-compatible. */
  deliveryMode?: MultiDrawChatDeliveryMode
  deliveryChunkSize?: number
  /** 次に送るsegment index。summary/旧行は常に0。 */
  deliveryCursor?: number
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
  delivery_mode?: MultiDrawChatDeliveryMode
  delivery_chunk_size?: number
  delivery_cursor?: number
}

function toClaimed(row: ClaimedRow): ClaimedChatNotification {
  const claim: ClaimedChatNotification = {
    id: row.id,
    batchId: row.batch_id,
    payloadVersion: Number(row.payload_version),
    payload: row.payload,
    leaseId: row.lease_id,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
  }
  // Production rows always carry these columns after the migration. Keep them additive
  // here so older unit fixtures that mock the pre-#1549 row shape retain exact equality.
  if (row.delivery_mode !== undefined) claim.deliveryMode = row.delivery_mode
  if (row.delivery_chunk_size !== undefined) claim.deliveryChunkSize = Number(row.delivery_chunk_size)
  if (row.delivery_cursor !== undefined) claim.deliveryCursor = Number(row.delivery_cursor)
  return claim
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

/**
 * ライブEventSub処理が、自分のbatchだけをclaimする。
 * RETURNING * deliberately avoids naming additive delivery columns: Workers Builds can
 * deploy before migration. Old rows then omit those fields and remain on legacy summary.
 */
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
    returning *
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
    returning outbox.*
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

/**
 * 分割N連の1segmentがTwitch側で確定した直後にcursorを前進する。
 *
 * cursorを保存できないまま次segmentを送ると、worker停止/429後の再claimで既送信分を
 * 再送してしまう。そのためowner-fenced UPDATEが成功した場合だけ呼び出し側は次へ進む。
 * `greatest` によりcursorは単調増加し、古いworkerが後退させることもない。
 */
export async function advanceChatNotificationDeliveryCursor(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
  nextCursor: number,
): Promise<boolean> {
  if (!Number.isInteger(nextCursor) || nextCursor < 0) return false
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set delivery_cursor = greatest(delivery_cursor, ${nextCursor}::integer),
        lease_expires_at = now() + (${CHAT_OUTBOX_LEASE_SECONDS}::integer * interval '1 second'),
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
 * attempt_count（claim済みでインクリメント後の値）から指数的backoffの遅延を
 * 求める。retryChatNotification/retryChatNotificationForBoundedDeliveryで共有し、
 * chat-notification-delivery.tsがDBの実際のnext_attempt_atを読み直さずに
 * 次回wake-upのおおよその予定時刻を見積もる用途にも使う（正本は常にDB側の
 * next_attempt_atであり、この見積もりがずれてもclaim時のnext_attempt_at<=now()
 * 判定がfail-closedに保護する）。
 */
export function estimateChatOutboxRetryDelayMs(attemptCount: number): number {
  const delayIndex = Math.min(
    attemptCount - 1,
    CHAT_OUTBOX_RETRY_DELAYS_MS.length - 1,
  )
  return CHAT_OUTBOX_RETRY_DELAYS_MS[Math.max(0, delayIndex)]
}

/**
 * 一時障害を指数的backoffで再予定する。claim時にattempt_countは増えているため、
 * 5回目の失敗はpendingへ戻さずその場でDLQ化する。
 *
 * 既知の残課題（Issue #1665 ロールアウトStep 3で解消する前提）:
 * この関数はpending_kindに触れない（列名を直接埋め込むと、後述の
 * pre-migration deploy中に「実障害からの通常retry」という日常的な処理が
 * 列不存在エラーになってしまうため、意図的にこの列を避けている。
 * claimChatNotificationForBoundedDeliveryコメント参照）。
 * この関数は現状、20分周期cron relay（eventsub-replay route経由の
 * claimDueChatNotifications）から無条件に呼ばれ続ける。専用Queue Worker配備後、
 * pending_kind='continuation'（正常な予算切れの続き）のまま残っている行を
 * このcron relayが先に拾って実障害でretryすると、pending_kindが
 * 'continuation'のまま更新されず、次のclaimChatNotificationForBoundedDeliveryが
 * それを正常な継続と誤認してattempt_countを消費し損ねる
 * （実障害の有限上限をすり抜ける経路になり得る）。
 * 本PRが実際にdeployする範囲では専用Worker自体が存在せずQueueへのenqueueも
 * 無効なため、pending_kind='continuation'な行は生成され得ずこの経路は
 * 到達しない。Issue #1665 導入順序 Step 3（「live/relayの全配送入口を共通
 * dispatcherへ接続し、旧新の二重ownerを遮断してから」）で、eventsub-replay
 * route側のchat outbox処理もbounded delivery系関数へ統合し、この関数
 * （とclaimDueChatNotifications/claimChatNotificationBatch）をchat outbox用途から
 * 退役させること。それまでは新経路のフラグを有効化する運用手順が、
 * このcron relayとの二重ownerを事前に遮断することに依存する。
 */
export async function retryChatNotification(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId' | 'attemptCount'>,
  reason: string,
): Promise<'pending' | 'dead' | 'lost-lease'> {
  if (claim.attemptCount >= CHAT_OUTBOX_MAX_ATTEMPTS) {
    return await deadLetterChatNotification(claim, reason) ? 'dead' : 'lost-lease'
  }

  const delayMs = estimateChatOutboxRetryDelayMs(claim.attemptCount)
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

// =============================================================================
// Issue #1665: bounded delivery（専用Queue + 送信位置からの再開）専用の
// claim/release/retry。
//
// 上のclaimChatNotificationBatch/claimDueChatNotifications/retryChatNotification
// は意図的に変更しない: pending_kind/wake_reserved_until はこのmigration
// （20260922100000）で追加した列であり、Workers Builds はコードdeployと
// migrationが独立して進みうるため、常に呼ばれる既存claim経路がこれらの列名を
// SQL文に埋め込むと「アプリ先行deploy・DB未適用」時に列不存在エラーになる
// （chat-notification-outbox.ts冒頭のclaimChatNotificationBatchコメント、
// 20260912013000のRETURNING *設計と同じ理由）。
//
// 以下の新関数群は、新しいbounded配送経路（chat-notification-delivery.ts）
// からのみ呼ばれる。この経路自体が初期無効（フィーチャーフラグ）であり、
// 有効化はロールアウト手順上必ずmigration適用後に行われるため、新関数が
// pending_kind/wake_reserved_until を直接名指ししても pre-migration deploy を
// 壊さない。
// =============================================================================

/**
 * bounded配送経路専用のclaim。batch_idで1件だけ、continuationとretry/初回を
 * 区別してattempt_countを増減する。
 *
 * pending_kind='continuation'（予算内に完走できず正常に途中終了した続き）を
 * pending状態から再claimする場合だけ、attempt_countを増やさない。lease失効後の
 * processing行の回収（クラッシュ回収）は、continuationかどうかに関係なく通常の
 * 失敗試行として扱い、無限再試行へ化けないようattempt_countを増やす。
 * SET句のCASE式はUPDATE前（更新前）の行の値を参照するPostgreSQLの仕様に
 * 依拠しており、他の列への代入順序には依存しない。
 *
 * WHERE句の`attempt_count < MAX`はcontinuation行には課さない
 * （2026-09-22 azumagレビュー指摘の回帰修正）。continuationはattempt_countを
 * 消費しないため、過去の一時障害で既にattempt_count = MAXへ達していても
 * 正常な続きとしてclaimできなければならない。この上限を無条件のANDにすると、
 * 「一時障害で試行上限に達した直後に、同じ行が予算切れでcontinuationへ入る」
 * という正当な経路で行が二度とclaimされずpendingのまま永久に取り残される
 * （dead化もされない: deadLetterはclaim済みの行にしか作用しないため）。
 * 一方、lease失効processing行（クラッシュ回収=実障害側）の上限は緩めない。
 *
 * 既知の残課題: この判定は「pending_kind='continuation'であること」だけを
 * 信頼する。retryChatNotification（cron relay経由の旧経路、Step 3までは
 * この関数と同じ行を無条件に触りうる）のdocコメント参照。詳細な回避条件と
 * 解消計画はそちらに記載。
 */
export async function claimChatNotificationForBoundedDelivery(
  batchId: string,
): Promise<ClaimedChatNotification | null> {
  const leaseId = crypto.randomUUID()
  const { sql } = await getDb()
  const rows = await sql<ClaimedRow[]>`
    update chat_notification_outbox
    set status = 'processing',
        lease_id = ${leaseId}::uuid,
        lease_expires_at = now() + (${CHAT_OUTBOX_LEASE_SECONDS}::integer * interval '1 second'),
        attempt_count = attempt_count + case
          when status = 'pending' and pending_kind = 'continuation' then 0
          else 1
        end,
        wake_reserved_until = null,
        updated_at = now()
    where batch_id = ${batchId}
      and (
        (status = 'pending' and pending_kind = 'continuation' and next_attempt_at <= now())
        or (
          attempt_count < ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
          and (
            (status = 'pending' and next_attempt_at <= now())
            or (status = 'processing' and lease_expires_at <= now())
          )
        )
      )
    returning *
  `
  return rows[0] ? toClaimed(rows[0]) : null
}

/**
 * 予算内に完走できなかったが失敗ではない正常な途中終了。cursor/lease以外の
 * delivery_cursor自体は呼び出し前にadvanceChatNotificationDeliveryCursorで
 * 既に保存済みである前提。ここではstatusをpendingへ戻し、次のclaimが
 * attempt_countを消費しないよう pending_kind='continuation' を記録する。
 * last_error/attempt_countには触れない（正常系であり障害ログではないため）。
 */
export async function releaseChatNotificationForContinuation(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId'>,
  nextAttemptAt: Date,
): Promise<boolean> {
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set status = 'pending',
        pending_kind = 'continuation',
        next_attempt_at = ${nextAttemptAt.toISOString()}::timestamptz,
        lease_id = null,
        lease_expires_at = null,
        wake_reserved_until = null,
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1
}

/**
 * bounded配送経路専用のretry。ロジックはretryChatNotificationと同じ指数的
 * backoffだが、pending_kind='retry'を明示的に書き込む点だけが異なる。
 *
 * これが必須である理由: このUPDATEがpending_kindを書かないと、直前に
 * continuationとしてpendingへ戻った行（pending_kind='continuation'）が
 * 一時障害で失敗した場合、値が'continuation'のまま残ってしまう。次回claimの
 * CASE式はpending_kindの値だけを見るため、実際には一時障害からのretryなのに
 * attempt_countを消費せず無限に再試行できてしまう
 * （「実障害の有限上限は維持する」という要件への回帰）。
 */
export async function retryChatNotificationForBoundedDelivery(
  claim: Pick<ClaimedChatNotification, 'id' | 'leaseId' | 'attemptCount'>,
  reason: string,
): Promise<'pending' | 'dead' | 'lost-lease'> {
  if (claim.attemptCount >= CHAT_OUTBOX_MAX_ATTEMPTS) {
    return await deadLetterChatNotification(claim, reason) ? 'dead' : 'lost-lease'
  }

  const delayMs = estimateChatOutboxRetryDelayMs(claim.attemptCount)
  const { sql } = await getDb()
  const rows = await sql<{ id: string }[]>`
    update chat_notification_outbox
    set status = 'pending',
        pending_kind = 'retry',
        next_attempt_at = now() + (${delayMs}::integer * interval '1 millisecond'),
        lease_id = null,
        lease_expires_at = null,
        wake_reserved_until = null,
        last_error = left(${reason}::text, 2000),
        updated_at = now()
    where id = ${claim.id}::uuid
      and status = 'processing'
      and lease_id = ${claim.leaseId}::uuid
    returning id
  `
  return rows.length === 1 ? 'pending' : 'lost-lease'
}

export interface ChatNotificationWakeCandidate {
  id: string
  batchId: string
}

/**
 * 回収sweeper（dispatch-due）専用。期限到来済み・未予約の行を原子的に
 * 予約するだけで、claim（lease取得・attempt_count更新）は一切行わない。
 * 実際の配送は、この予約結果のbatchIdを積んだQueue wake-upがconsumeされた
 * 時点でclaimChatNotificationForBoundedDeliveryを呼ぶ別経路が担う。
 *
 * 対象は次の2種類（claimChatNotificationForBoundedDelivery/
 * claimDueChatNotificationsと同じ「期限到来」の定義）:
 * - status='pending' and next_attempt_at<=now(): 通常の初回/retry/continuation。
 * - status='processing' and lease_expires_at<=now(): Queue Worker・内部endpoint
 *   呼び出しがclaim後に応答なく停止した（consumer停止・HTTPタイムアウト等）
 *   クラッシュ回収。pendingだけを対象にすると、この場合に起票済みのwake-up
 *   メッセージが無くなった後、この専用sweepでは永久に再起床できず、既存の
 *   20分周期cron relay（claimDueChatNotifications経由）にしか拾われない
 *   （Issue #1665の「consumer停止」回収要件に対する回帰）。
 * wake_reserved_untilはprocessing行にも同じ意味で書く: 実際のstatus遷移は
 * 変えず、単に「この行への次のwake-up起票は予約済み」という重複防止の印。
 * 次にclaimChatNotificationForBoundedDeliveryが呼ばれた時点でwake_reserved_until
 * はnullへ戻る。
 *
 * attempt_count上限はstatus='pending' and pending_kind='continuation'の行には
 * 課さない（claimChatNotificationForBoundedDeliveryと同じ回帰修正、
 * 2026-09-22 azumagレビュー指摘）。ここで対象外にすると、claim可能でも
 * sweepがwake-upを起票できず同じ行が回収されない状態になる。
 *
 * FOR UPDATE SKIP LOCKEDにより、同時に複数のsweep呼び出しが動いても同じ行を
 * 重複予約しない。予約後にenqueueが失敗しても、reservationSecondsで自然に
 * 期限切れて次回sweepが再度拾える（明示的なロールバックは不要）。
 */
export async function reserveDueChatNotificationOutboxForWake(
  limit: number,
  reservationSeconds: number,
): Promise<ChatNotificationWakeCandidate[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100))
  const safeReservationSeconds = Math.max(1, Math.trunc(reservationSeconds))
  const { sql } = await getDb()
  const rows = await sql<Array<{ id: string; batch_id: string }>>`
    with candidates as (
      select id
      from chat_notification_outbox
      where (wake_reserved_until is null or wake_reserved_until <= now())
        and (
          (status = 'pending' and pending_kind = 'continuation' and next_attempt_at <= now())
          or (
            attempt_count < ${CHAT_OUTBOX_MAX_ATTEMPTS}::integer
            and (
              (status = 'pending' and next_attempt_at <= now())
              or (status = 'processing' and lease_expires_at <= now())
            )
          )
        )
      order by next_attempt_at asc, created_at asc
      for update skip locked
      limit ${safeLimit}::integer
    )
    update chat_notification_outbox as outbox
    set wake_reserved_until = now() + (${safeReservationSeconds}::integer * interval '1 second')
    from candidates
    where outbox.id = candidates.id
    returning outbox.id, outbox.batch_id
  `
  return rows.map((row) => ({ id: row.id, batchId: row.batch_id }))
}
