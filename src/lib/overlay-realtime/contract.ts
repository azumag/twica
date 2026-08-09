export const OVERLAY_REALTIME_SCHEMA_VERSION = 1 as const
export const OVERLAY_REALTIME_PROTOCOL_VERSION = 1 as const

/**
 * `server_notice` code meaning the room is no longer allowlisted.
 *
 * Lives in the shared contract because the standalone Worker sends it and the
 * browser client acts on it. Two independent literals would let a rename
 * silently turn the operator kill switch into a no-op: the room would close its
 * sockets while the client waited for a notice code it no longer recognised.
 */
export const OVERLAY_REALTIME_TRANSPORT_DISABLED = 'transport_disabled' as const

/**
 * `server_notice` code the room emits on its periodic check so a client can
 * tell "nothing happened" apart from "this socket is dead".
 *
 * Once history polling stops running on a timer, a half-open socket — one that
 * never delivers a close event — would silently starve the overlay forever.
 * The room already wakes on that interval for the kill switch, so the liveness
 * signal is free: it costs no extra wake and no HTTP request.
 */
export const OVERLAY_REALTIME_HEARTBEAT = 'heartbeat' as const

/**
 * How often a room with live sockets emits the heartbeat above. Shared so the
 * client can derive its liveness deadline from the same number the Worker uses
 * instead of two constants drifting apart.
 */
export const OVERLAY_REALTIME_HEARTBEAT_MS = 60_000
export const MAX_REALTIME_DRAWS = 15
export const MAX_REALTIME_EVENT_BYTES = 64 * 1024
/**
 * Public build identifiers are currently 12-character Git SHAs (or `dev`).
 * Keep protocol consumers tolerant of future formats while bounding any value
 * copied into logs, callback state, or sessionStorage by an untrusted response.
 */
export const MAX_OVERLAY_VERSION_LENGTH = 128
/**
 * `gacha_history.id` is generated as an RFC 4122 UUID. The exact predicate is
 * shared by the history API and browser checkpoint readers: accepting a value
 * from sessionStorage that the API later rejects would pin every recovery
 * request in a permanent HTTP 400 loop.
 */
const OVERLAY_HISTORY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PUBLIC_CARD_DESCRIPTION_LENGTH = 1_024
const MAX_PUBLIC_CARD_IMAGE_URL_LENGTH = 2_048

const STREAMER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface OverlayRealtimeCard {
  id: string
  name: string
  description: string | null
  image_url: string | null
  // #899: 余白（fit）モードの余白色（overlay 表示の object-contain + 背景色に使う）
  image_padding_color?: string | null
  rarity: string
}

/**
 * Bound presentation fields before they enter either transport.
 *
 * Card columns are PostgreSQL `text`, so historical data can be larger than a
 * realtime frame even when current UI inputs are small. Truncating display-only
 * text/URLs keeps normal batches compact, while the final serialized-size
 * validator enforces the 64 KiB fanout limit for every payload. Authoritative
 * card data in PlanetScale is never modified.
 */
export function normalizeOverlayRealtimeCard(
  card: OverlayRealtimeCard
): OverlayRealtimeCard {
  return {
    id: card.id.slice(0, 128),
    name: card.name.slice(0, 256),
    description: card.description?.slice(
      0,
      MAX_PUBLIC_CARD_DESCRIPTION_LENGTH
    ) ?? null,
    image_url: card.image_url?.slice(
      0,
      MAX_PUBLIC_CARD_IMAGE_URL_LENGTH
    ) ?? null,
    // ホワイトリスト済みの4値（black/white/gray/transparent）のみが入る想定のため、
    // 上限のみ束縛する（過大な値が入ってもオーバーレイ表示に危険はない）
    image_padding_color: card.image_padding_color?.slice(0, 16) ?? null,
    rarity: card.rarity.slice(0, 64),
  }
}

/**
 * Identity for one committed draw.
 *
 * `drawId` intentionally equals the database `event_id` today, but is kept as
 * a separate protocol field: eventId is the transport dedupe key, while drawId
 * identifies ordering within a batch. Keeping both names explicit prevents a
 * future transport implementation from inventing an ID that cannot be mapped
 * back to the authoritative history row.
 */
export interface GachaRealtimeDrawV1 {
  eventId: string
  drawId: string
  drawIndex: number
  historyId: string
  card: OverlayRealtimeCard
}

export interface GachaRealtimeEventV1 {
  schemaVersion: typeof OVERLAY_REALTIME_SCHEMA_VERSION
  type: 'gacha_result'
  /** Dedupe key for the first draw; every draw also carries its own eventId. */
  eventId: string
  /** Stable EventSub message ID or manual-draw ID shared by the whole batch. */
  batchId: string
  streamerId: string
  occurredAt: string
  user: {
    twitchUsername: string
  }
  draws: GachaRealtimeDrawV1[]
  rewardId?: string | null
  /** All draws in one batch share one sound group and produce one sound. */
  soundGroupId: string
}

export type OverlayRealtimeServerMessage =
  | {
      type: 'welcome'
      protocolVersion: typeof OVERLAY_REALTIME_PROTOCOL_VERSION
      connectionId: string
      serverTime: string
      /**
       * Room fanout counter at connect time.
       *
       * Lets a client baseline itself so the next delivery is recognisably
       * contiguous. Optional so a client served by a newer deployment keeps
       * working against a room that has not been redeployed yet.
       */
      seq?: number
    }
  | {
      type: 'gacha_result'
      /**
       * Monotonic per-room fanout counter.
       *
       * A jump means this socket missed a delivery, which is the only reason a
       * healthy connection needs to poll history at all. Carried beside the
       * event rather than inside it so the authoritative envelope that polling
       * rebuilds from the database stays byte-identical to the pushed one.
       */
      seq?: number
      event: GachaRealtimeEventV1
    }
  | {
      type: 'server_notice'
      code: string
      retryAfterMs?: number
    }

export interface OverlayRealtimeConfigV1 {
  schemaVersion: 1
  mode: 'polling-only' | 'do-primary'
  webSocketUrl?: string
  protocolVersion: typeof OVERLAY_REALTIME_PROTOCOL_VERSION
  retryPolicy: {
    baseDelayMs: number
    maxDelayMs: number
  }
  configVersion: string
  /**
   * App build served by this Worker. Optional so a new browser bundle remains
   * compatible with an older realtime-config endpoint during deployment.
   */
  overlayVersion?: string
}

export interface PollingContractEvent {
  id: string
  eventId: string | null
  redeemedAt: string
  userTwitchUsername: string
  rewardId?: string | null
  card: OverlayRealtimeCard
}

export interface ContractValidationResult {
  ok: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isNullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= maxLength)
}

/**
 * Validate a public overlay build identifier at every network boundary.
 *
 * The value is intentionally format-agnostic because deployment systems may
 * move beyond Git SHAs, but empty, whitespace-padded, and oversized strings are
 * rejected so an optional compatibility field cannot become an unbounded input.
 */
export function isValidOverlayVersion(value: unknown): value is string {
  return isBoundedString(value, MAX_OVERLAY_VERSION_LENGTH)
    && value.trim() === value
}

/** Validate an exact `gacha_history.id` cursor at every public boundary. */
export function isValidOverlayHistoryId(value: unknown): value is string {
  return typeof value === 'string' && OVERLAY_HISTORY_ID_PATTERN.test(value)
}

export function isValidStreamerId(value: string): boolean {
  return STREAMER_ID_PATTERN.test(value)
}

/**
 * Resolve the effective per-streamer rollout policy in every runtime.
 *
 * The Next.js config endpoint, commit publisher, and standalone Worker must
 * share this exact parser. Duplicating it would let a future allowlist format
 * change enable publish while the client is told to poll, or let the Worker
 * accept connections after the operator has activated the kill switch.
 */
export function isOverlayRealtimeStreamerEnabled(
  mode: string | undefined,
  rawAllowlist: string | undefined,
  streamerId: string
): boolean {
  if (mode !== 'do-primary' || !isValidStreamerId(streamerId)) return false
  const allowlist = rawAllowlist?.trim()
  if (!allowlist) return false
  if (allowlist === '*') return true
  return allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(streamerId)
}

/**
 * Runtime validation is deliberately dependency-free so the exact same
 * contract runs in Next.js, the browser overlay, and the standalone Worker.
 * The checks bound every attacker-controlled string before an event is fanned
 * out to all sockets; this limits memory amplification and prevents accidental
 * inclusion of private database/user fields in the public protocol.
 */
export function validateGachaRealtimeEvent(
  value: unknown,
  expectedStreamerId?: string
): ContractValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'event must be an object' }
  if (value.schemaVersion !== OVERLAY_REALTIME_SCHEMA_VERSION) {
    return { ok: false, error: 'unsupported schemaVersion' }
  }
  if (value.type !== 'gacha_result') return { ok: false, error: 'unsupported event type' }
  if (!isBoundedString(value.eventId, 256)) return { ok: false, error: 'invalid eventId' }
  if (!isBoundedString(value.batchId, 256)) return { ok: false, error: 'invalid batchId' }
  if (!isBoundedString(value.streamerId, 64) || !isValidStreamerId(value.streamerId)) {
    return { ok: false, error: 'invalid streamerId' }
  }
  if (expectedStreamerId && value.streamerId !== expectedStreamerId) {
    return { ok: false, error: 'streamer mismatch' }
  }
  if (!isBoundedString(value.occurredAt, 64) || !Number.isFinite(Date.parse(value.occurredAt))) {
    return { ok: false, error: 'invalid occurredAt' }
  }
  if (!isRecord(value.user) || !isBoundedString(value.user.twitchUsername, 64)) {
    return { ok: false, error: 'invalid public user' }
  }
  if (!Array.isArray(value.draws) || value.draws.length < 1 || value.draws.length > MAX_REALTIME_DRAWS) {
    return { ok: false, error: 'invalid draw count' }
  }
  if (!isBoundedString(value.soundGroupId, 256)) {
    return { ok: false, error: 'invalid soundGroupId' }
  }
  if (
    value.rewardId !== undefined
    && value.rewardId !== null
    && !isBoundedString(value.rewardId, 256)
  ) {
    return { ok: false, error: 'invalid rewardId' }
  }

  const seenEventIds = new Set<string>()
  for (const [index, rawDraw] of value.draws.entries()) {
    if (!isRecord(rawDraw)) return { ok: false, error: 'draw must be an object' }
    if (!isBoundedString(rawDraw.eventId, 256)) return { ok: false, error: 'invalid draw eventId' }
    if (!isBoundedString(rawDraw.drawId, 256)) return { ok: false, error: 'invalid drawId' }
    if (!isBoundedString(rawDraw.historyId, 128)) return { ok: false, error: 'invalid historyId' }
    if (rawDraw.drawIndex !== index) return { ok: false, error: 'drawIndex must be contiguous' }
    if (seenEventIds.has(rawDraw.eventId)) return { ok: false, error: 'duplicate draw eventId' }
    seenEventIds.add(rawDraw.eventId)

    const card = rawDraw.card
    if (!isRecord(card)) return { ok: false, error: 'card must be an object' }
    if (!isBoundedString(card.id, 128)) return { ok: false, error: 'invalid card id' }
    if (!isBoundedString(card.name, 256)) return { ok: false, error: 'invalid card name' }
    if (
      !isNullableBoundedString(
        card.description,
        MAX_PUBLIC_CARD_DESCRIPTION_LENGTH
      )
    ) {
      return { ok: false, error: 'invalid card description' }
    }
    if (
      !isNullableBoundedString(
        card.image_url,
        MAX_PUBLIC_CARD_IMAGE_URL_LENGTH
      )
    ) {
      return { ok: false, error: 'invalid card image URL' }
    }
    if (!isBoundedString(card.rarity, 64)) return { ok: false, error: 'invalid rarity' }
  }

  if (value.eventId !== (value.draws[0] as Record<string, unknown>).eventId) {
    return { ok: false, error: 'top-level eventId must match first draw' }
  }
  // Field limits bound common amplification, while the serialized check also
  // covers UTF-8 expansion and JSON escaping of quotes/control characters.
  // Keeping it in the shared validator makes Next.js, polling, and the Worker
  // enforce the same wire-size contract instead of relying on router order.
  if (
    serializedEventSize(value as unknown as GachaRealtimeEventV1)
    > MAX_REALTIME_EVENT_BYTES
  ) {
    return { ok: false, error: 'event exceeds byte limit' }
  }
  return { ok: true }
}

export function parseGachaRealtimeEvent(value: unknown): GachaRealtimeEventV1 | null {
  return validateGachaRealtimeEvent(value).ok ? value as GachaRealtimeEventV1 : null
}

export function serializedEventSize(event: GachaRealtimeEventV1): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

function pollingBatchId(event: PollingContractEvent): string {
  return event.eventId?.replace(/:\d+$/, '') ?? `legacy:${event.id}`
}

function pollingDrawIndex(event: PollingContractEvent): number | null {
  if (!event.eventId) return null
  const match = event.eventId.match(/:(\d+)$/)
  if (!match) return 0
  const oneBasedIndex = Number(match[1])
  return Number.isSafeInteger(oneBasedIndex) && oneBasedIndex >= 2
    ? oneBasedIndex - 1
    : null
}

/**
 * Convert authoritative history rows to the same versioned envelope delivered
 * by the Durable Object. Keeping this builder in the shared contract prevents
 * the HTTP route and an older overlay client from assigning different batch or
 * draw identities during a rolling deployment.
 *
 * The route orders rows by `(redeemed_at, id)` before calling this function.
 * Draw order is recovered from the committed event-ID suffix. If a large
 * backlog splits a batch across cursor pages, the stable `soundGroupId` is
 * intentionally preserved on both partial envelopes; the page-level bounded
 * sound cache therefore plays it once while every unseen draw still renders.
 */
export function buildPollingRealtimeEvents(
  streamerId: string,
  events: PollingContractEvent[]
): GachaRealtimeEventV1[] {
  const groups = new Map<string, PollingContractEvent[]>()
  for (const event of events) {
    const batchId = pollingBatchId(event)
    const group = groups.get(batchId)
    if (group) group.push(event)
    else groups.set(batchId, [event])
  }

  return [...groups.entries()].map(([batchId, group]) => {
    const first = group[0]
    const lastByCommitOrder = group[group.length - 1]
    // gacha_history IDs are UUIDs, so the stable `(redeemed_at, id)` polling
    // order is intentionally unrelated to draw order. Restore N-draw order
    // from the committed event ID suffix (`batch`, `batch:2`, ...). Legacy
    // null IDs have no recoverable draw index and retain database order.
    const indexedGroup = group.map((event, inputIndex) => ({
      event,
      inputIndex,
      drawIndex: pollingDrawIndex(event),
    }))
    const canRestoreDrawOrder = indexedGroup.every(
      (entry) => entry.drawIndex !== null
    )
    if (canRestoreDrawOrder) {
      indexedGroup.sort(
        (left, right) =>
          (left.drawIndex as number) - (right.drawIndex as number)
          || left.inputIndex - right.inputIndex
      )
    }
    const orderedGroup = indexedGroup.map((entry) => entry.event)
    const draws = orderedGroup.map((event, drawIndex) => {
      const eventId = event.eventId ?? `legacy:${event.id}`
      return {
        eventId,
        drawId: eventId,
        drawIndex,
        historyId: event.id,
        card: normalizeOverlayRealtimeCard(event.card),
      }
    })
    return {
      schemaVersion: OVERLAY_REALTIME_SCHEMA_VERSION,
      type: 'gacha_result',
      eventId: draws[0].eventId,
      batchId,
      streamerId,
      occurredAt: lastByCommitOrder.redeemedAt,
      user: { twitchUsername: first.userTwitchUsername },
      draws,
      rewardId: first.rewardId ?? null,
      soundGroupId: batchId,
    }
  })
}
