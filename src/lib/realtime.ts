/*
 * Overlay transport compatibility facade
 *
 * Durable Objects WebSocket is the low-latency primary when runtime config
 * enables it. PlanetScale-backed HTTP polling runs while disconnected and for
 * explicit reconnect/sequence-gap recovery. A ten-minute reconciliation also
 * covers the gapless failure case where a committed row could not be published
 * to the room at all; pushed events never advance that durable DB checkpoint.
 * No Supabase URL, key, SDK, or channel is used.
 */

import {
  OVERLAY_REALTIME_HEARTBEAT_MS,
  OVERLAY_REALTIME_PROTOCOL_VERSION,
  OVERLAY_REALTIME_PRESENCE_REFRESH,
  OVERLAY_REALTIME_PRESENCE_TOKEN_TTL_MS,
  OVERLAY_REALTIME_PRESENCE_TOKEN_MAX_LENGTH,
  OVERLAY_REALTIME_TRANSPORT_DISABLED,
  buildPollingRealtimeEvents,
  type GachaRealtimeEventV1,
  type OverlayRealtimeConfigV1,
  type OverlayRealtimeServerMessage,
  isValidOverlayHistoryId,
  isValidOverlayVersion,
  validateGachaRealtimeEvent,
} from '@/lib/overlay-realtime/contract'
import { normalizeOverlayHistoryTimestamp } from '@/lib/overlay-history-cursor'

export interface GachaBroadcastPayload {
  type: 'gacha'
  card: {
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: string
  }
  cards?: Array<{
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: string
  }>
  /** Stable identities for each card in an N-draw callback, in display order. */
  drawEventIds?: string[]
  userTwitchUsername: string
  rewardId?: string | null
  /** Stable batch key used to suppress duplicate sound across recovery pages. */
  soundGroupId?: string
  /**
   * Event timestamp retained for callback compatibility and diagnostics.
   * Cursor ownership remains inside the controller; callers must not treat a
   * pushed timestamp as proof that all earlier DB rows reached the room.
   */
  historyCursor?: string
}

/**
 * The page may return a promise while React commits the card DOM. `false` is
 * an explicit negative acknowledgement: the transport must leave the event
 * uncommitted in its dedupe state and retry it through its normal recovery
 * path.
 */
export type GachaDeliveryResult = void | boolean | Promise<void | boolean>
export type GachaResultCallback = (
  payload: GachaBroadcastPayload,
) => GachaDeliveryResult

type IngestStatus = 'invalid' | 'duplicate' | 'pending' | 'delivered' | 'callback-error'

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(
    value
    && typeof (value as { then?: unknown }).then === 'function'
  )
}

export interface RealtimeError {
  type: 'connection' | 'subscription' | 'broadcast' | 'unknown'
  message: string
  error: unknown
  isExpected?: boolean
}

interface PollingEvent {
  id: string
  eventId: string | null
  redeemedAt: string
  userTwitchUsername: string
  rewardId?: string | null
  card: GachaBroadcastPayload['card']
}

/** Exact PlanetScale history position used across reload/reconnect recovery. */
export interface OverlayHistoryCursor {
  redeemedAt: string
  historyId: string
}

interface PollingResponse {
  events?: PollingEvent[]
  realtimeEvents?: GachaRealtimeEventV1[]
  nextCursor?: OverlayHistoryCursor | null
  demoEvent?: PollingEvent | null
  /** App build echoed by `/events`; optional for rolling compatibility. */
  overlayVersion?: unknown
  /**
   * Effective overlay transport version, echoed by the events endpoint so a
   * polling-only overlay notices a rollout without a second HTTP request.
   * Optional so an overlay served by an older deployment keeps working.
   */
  realtimeConfigVersion?: unknown
}

/**
 * Kept only for old test/caller source compatibility. Runtime server call sites
 * use `publishCommittedGachaBatch`, which rebuilds identity from committed DB
 * rows before signed DO publish.
 */
export async function broadcastGachaResult(
  _streamerId: string,
  _payload: GachaBroadcastPayload,
  _options: { maxRetries?: number; retryDelay?: number } = {}
): Promise<void> {
  void _options
  return
}

export interface SubscribeOptions {
  /** Consecutive polling failures before stopping; unlimited by default. */
  maxRetries?: number
  /** Polling interval and base retry delay; defaults to three seconds. */
  retryDelay?: number
  onError?: (error: RealtimeError) => void
  onSuccess?: () => void
  onStatusChange?: (status: string) => void
  /** Restores the exact DB position saved immediately before an overlay reload. */
  initialHistoryCursor?: OverlayHistoryCursor
  /** Reports each DB-confirmed cursor advance for persistence before reload. */
  onHistoryCursor?: (cursor: OverlayHistoryCursor) => void
  /** Receives a validated app build from either config or history recovery. */
  onOverlayVersion?: (overlayVersion: string) => void
}

// The reconciliation checkpoint intentionally trails live socket delivery.
// Retain enough IDs across a reload for large N-draw bursts, and trigger an
// early DB pass well before this bounded storage window can roll over.
const MAX_SEEN_EVENT_IDS = 8_192
const SOCKET_RECONCILIATION_TRIGGER_IDS = 512
// Every validated event is at most 64 KiB. Thirty-two buffered envelopes cap a
// recovery-order window at roughly 2 MiB before liveness takes precedence.
const MAX_BUFFERED_SOCKET_EVENTS = 32
const SOCKET_RECOVERY_BUFFER_MAX_MS = 10_000
const SEEN_EVENT_TTL_MS = 24 * 60 * 60 * 1000
const PRESENCE_TOKEN_NONCE_PATTERN = /^[0-9a-f-]{36}$/i
const PRESENCE_STORAGE_KEY_PREFIX = 'twica:overlay-presence:v1:'
const PRESENCE_TOKEN_CLOCK_SKEW_MS = 60_000
/**
 * Reconciliation cadence for a healthy DO connection. Ten minutes reduces the
 * old fixed history traffic while preserving eventual delivery when the
 * post-commit room publish fails before the room can assign a sequence number.
 * The same `/events` response carries config/build versions, so this single
 * request replaces a separate steady-state config refresh.
 */
const CONNECTED_RECONCILIATION_MS = 10 * 60_000
/**
 * Upper bound on how long DO reconnects stay suppressed after the room
 * reports itself disabled (see `disabledForConfigVersion` below).
 *
 * The suppression normally clears when the config endpoint returns a
 * different `configVersion`, but the app Worker's allowlist can be a
 * wildcard (`*`) that never changes per-streamer, in which case the operator
 * flipping the room-side allowlist back produces no new `configVersion` at all
 * — the client would otherwise stay on polling until reloaded (issue #844).
 * This operational recovery TTL is intentionally independent from the normal
 * ten-minute reconciliation cadence: while suppression is active the same timer
 * is scheduled for this shorter five-minute interval.
 */
const DO_SUPPRESSION_TTL_MS = 5 * 60_000
/**
 * Straight WS-open failures (never reached `onopen`) before falling back to
 * the slow TTL-gated retry instead of `scheduleReconnect`'s normal
 * exponential backoff. See `consecutiveOpenFailures` for why this exists.
 */
const OPEN_FAILURE_SUPPRESSION_THRESHOLD = 3
/**
 * Room-reported kill switch. Imported from the shared contract rather than
 * re-declared so a rename cannot leave the Worker sending a code the client
 * silently ignores.
 */
const TRANSPORT_DISABLED_NOTICE = OVERLAY_REALTIME_TRANSPORT_DISABLED
/**
 * Floor between config fetches triggered by a version mismatch.
 *
 * Without it, a config endpoint outage would make every 3-second polling pass
 * refetch (the safe fallback version never matches the server's), which would
 * be worse than the fixed timer this replaced. Thirty seconds keeps the
 * degraded case identical to the previous fixed interval while leaving a real
 * change to be picked up on the first pass that observes it.
 */
const CONFIG_CHANGE_REFETCH_FLOOR_MS = 30_000
/**
 * Minimum interval for DB-independent config probes after `/events` fails.
 *
 * A healthy old socket can keep heartbeating while its replacement URL has
 * changed, so a PlanetScale outage must not make endpoint rotation unbounded.
 * One probe immediately after the ten-minute reconciliation failure, then at
 * most one per five minutes, preserves that recovery path without replacing
 * the removed steady-state config poll with a degraded-mode request storm.
 */
const HISTORY_FAILURE_CONFIG_REFETCH_FLOOR_MS = 5 * 60_000
const MAX_CONFIG_VERSION_LENGTH = 128
const MAX_CONFIG_URL_LENGTH = 2_048
const MIN_CONFIG_RETRY_DELAY_MS = 100
const MAX_CONFIG_RETRY_DELAY_MS = 5 * 60_000
const WS_CONNECT_TIMEOUT_MS = 10_000
/**
 * How long a healthy socket may stay silent before the client gives up on it.
 *
 * The room emits a heartbeat every `OVERLAY_REALTIME_HEARTBEAT_MS`, so missing
 * more than two in a row means the socket is half-open: alive to the browser
 * but delivering nothing. Two intervals of slack keeps a single delayed wake or
 * a brief network stall from churning connections.
 *
 * This replaces using a frequent history poll as a liveness check. A connected
 * overlay reconciles only every ten minutes; heartbeats detect a half-open
 * socket quickly instead of waiting for that low-frequency DB pass.
 */
const SOCKET_LIVENESS_TIMEOUT_MS = OVERLAY_REALTIME_HEARTBEAT_MS * 2.5

function eventUrl(
  streamerId: string,
  cursor: OverlayHistoryCursor,
  demoCursor: OverlayHistoryCursor
): string {
  const url = new URL(`/api/overlay/${streamerId}/events`, window.location.origin)
  url.searchParams.set('since', cursor.redeemedAt)
  url.searchParams.set('demoSince', demoCursor.redeemedAt)
  url.searchParams.set('contract', 'v1')
  if (cursor.historyId) url.searchParams.set('afterId', cursor.historyId)
  url.searchParams.set('_', String(Date.now()))
  return url.toString()
}

function configUrl(streamerId: string, expectedVersion?: string): string {
  // The endpoint has a 15-second public cache TTL. Do not append the
  // millisecond cache-buster used by history polling: doing so would create an
  // unbounded set of edge cache keys and defeat inexpensive rollout config.
  const url = new URL(
    `/api/overlay/${streamerId}/realtime-config`,
    window.location.origin
  )
  // When a refetch was triggered by a version change observed on the events
  // endpoint, key the request by that version. This is bounded (one key per
  // config version that has ever existed, not per millisecond) and guarantees
  // the cache cannot answer a change-triggered refetch with the pre-change
  // response it is still holding.
  if (expectedVersion) url.searchParams.set('v', expectedVersion)
  return url.toString()
}

function fetchJsonWithXhr<T>(url: string, fetchError: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(fetchError)
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'json'
    xhr.timeout = 10_000
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((xhr.response ?? JSON.parse(xhr.responseText)) as T)
        } catch (parseError) {
          reject(parseError)
        }
      } else {
        reject(new Error(`HTTP ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(fetchError)
    xhr.ontimeout = () => reject(new Error('XHR timeout'))
    xhr.send()
  })
}

/**
 * OBS browser sources can run an older Chromium where fetch is less reliable.
 * XHR is attempted only when fetch itself rejects. Retrying HTTP errors through
 * XHR would consume the public rate limit twice without improving compatibility.
 */
async function fetchJson<T>(
  url: string,
  cache: RequestCache = 'no-store'
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache })
  } catch (fetchError) {
    return fetchJsonWithXhr<T>(url, fetchError)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function seenStorageKey(streamerId: string): string {
  return `twica:overlay-seen:v1:${streamerId}`
}

function loadSeenEvents(streamerId: string): Map<string, number> {
  const seen = new Map<string, number>()
  try {
    const raw = sessionStorage.getItem(seenStorageKey(streamerId))
    const records = raw ? JSON.parse(raw) as Array<[string, number]> : []
    const cutoff = Date.now() - SEEN_EVENT_TTL_MS
    // sessionStorage is not a trusted boundary. Bound work before iterating so
    // a corrupted oversized array cannot turn an OBS reload into a CPU spike.
    for (const [eventId, firstSeenAt] of records.slice(-MAX_SEEN_EVENT_IDS)) {
      if (typeof eventId === 'string' && Number.isFinite(firstSeenAt) && firstSeenAt >= cutoff) {
        seen.set(eventId, firstSeenAt)
      }
    }
  } catch {
    // Private-mode/old OBS storage failure reduces reload dedupe only; the
    // in-memory map below remains authoritative for the current page lifetime.
  }
  return seen
}

function persistSeenEvents(streamerId: string, seen: Map<string, number>): void {
  try {
    sessionStorage.setItem(
      seenStorageKey(streamerId),
      JSON.stringify([...seen.entries()].slice(-MAX_SEEN_EVENT_IDS))
    )
  } catch {
    // Storage quota/security failures must not stop overlay delivery.
  }
}

interface ParsedPresenceToken {
  token: string
  expiresAt: number
}

/**
 * Validate only the bounded, public shape of the bearer capability. The
 * Worker remains the authority for the HMAC; the browser uses the expiry to
 * choose between the URL token and the token saved by a previous page
 * lifetime. Keeping this parser here also prevents an untrusted server notice
 * from filling localStorage with arbitrary data.
 */
function parsePresenceToken(value: unknown, now = Date.now()): ParsedPresenceToken | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > OVERLAY_REALTIME_PRESENCE_TOKEN_MAX_LENGTH) {
    return null
  }
  const parts = value.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null
  const expiresAt = Number(parts[0])
  if (
    !Number.isSafeInteger(expiresAt)
    || expiresAt <= now
    || expiresAt > now + OVERLAY_REALTIME_PRESENCE_TOKEN_TTL_MS + PRESENCE_TOKEN_CLOCK_SKEW_MS
    || !PRESENCE_TOKEN_NONCE_PATTERN.test(parts[1])
    || !/^[0-9a-f]{64}$/i.test(parts[2])
  ) {
    return null
  }
  return { token: value, expiresAt }
}

function presenceStorageKey(streamerId: string): string {
  return `${PRESENCE_STORAGE_KEY_PREFIX}${encodeURIComponent(streamerId)}`
}

function readOverlayPresenceToken(streamerId: string): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  // Tokenless settings previews and demos must never inherit the capability
  // saved by the real OBS source. A presence query parameter marks the page
  // as an opted-in source even when its original token has expired.
  if (!params.has('presence')) return null

  const fromUrl = parsePresenceToken(params.get('presence'))
  let fromStorage: ParsedPresenceToken | null = null
  try {
    fromStorage = parsePresenceToken(
      window.localStorage.getItem(presenceStorageKey(streamerId))
    )
  } catch {
    // Private-mode/security failures only lose reload persistence; the URL
    // token and the current socket's in-memory refresh remain usable.
  }

  // URL order wins ties so a newly copied URL with the same expiry is used;
  // otherwise an already refreshed token survives an OBS Browser Source
  // reload even though the configured URL still contains the old token.
  const selected = fromStorage && (!fromUrl || fromStorage.expiresAt > fromUrl.expiresAt)
    ? fromStorage
    : fromUrl
  if (!selected) return null
  try {
    window.localStorage.setItem(presenceStorageKey(streamerId), selected.token)
  } catch {
    // The capability is still forwarded for this page lifetime.
  }
  return selected.token
}

function persistOverlayPresenceToken(streamerId: string, value: unknown): ParsedPresenceToken | null {
  const parsed = parsePresenceToken(value)
  if (!parsed || typeof window === 'undefined') return parsed
  const params = new URLSearchParams(window.location.search)
  // A tokenless preview must stay tokenless even if a malformed/old room
  // happens to send a refresh notice on its public WebSocket.
  if (!params.has('presence')) return null
  try {
    const stored = parsePresenceToken(
      window.localStorage.getItem(presenceStorageKey(streamerId))
    )
    // Never replace a newer token with a delayed/duplicated server notice.
    if (!stored || parsed.expiresAt >= stored.expiresAt) {
      window.localStorage.setItem(presenceStorageKey(streamerId), parsed.token)
    }
  } catch {
    // Storage is an optimization for reloads, not a delivery dependency.
  }
  return parsed
}

function rememberSeenId(seen: Map<string, number>, id: string): boolean {
  if (seen.has(id)) return false
  seen.set(id, Date.now())
  while (seen.size > MAX_SEEN_EVENT_IDS) {
    const oldest = seen.keys().next().value as string | undefined
    if (!oldest) break
    seen.delete(oldest)
  }
  return true
}

function isBoundedConfigString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
}

function normalizeHistoryCursor(
  value: unknown,
  requireHistoryId = false
): OverlayHistoryCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const cursor = value as Record<string, unknown>
  const redeemedAt = normalizeOverlayHistoryTimestamp(cursor.redeemedAt)
  if (!redeemedAt || typeof cursor.historyId !== 'string') return null
  if (cursor.historyId === '') {
    return requireHistoryId ? null : { redeemedAt, historyId: '' }
  }
  return isValidOverlayHistoryId(cursor.historyId)
    ? { redeemedAt, historyId: cursor.historyId }
    : null
}

function isValidConfigWebSocketUrl(value: unknown): value is string {
  if (!isBoundedConfigString(value, MAX_CONFIG_URL_LENGTH)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'ws:')
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

function validConfig(value: unknown): value is OverlayRealtimeConfigV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (
    config.schemaVersion !== 1
    || (config.mode !== 'polling-only' && config.mode !== 'do-primary')
    || config.protocolVersion !== OVERLAY_REALTIME_PROTOCOL_VERSION
    || !isBoundedConfigString(config.configVersion, MAX_CONFIG_VERSION_LENGTH)
    || !config.retryPolicy
    || typeof config.retryPolicy !== 'object'
    || Array.isArray(config.retryPolicy)
  ) {
    return false
  }

  const retryPolicy = config.retryPolicy as Record<string, unknown>
  const baseDelayMs = retryPolicy.baseDelayMs
  const maxDelayMs = retryPolicy.maxDelayMs
  if (
    typeof baseDelayMs !== 'number'
    || typeof maxDelayMs !== 'number'
    || !Number.isInteger(baseDelayMs)
    || !Number.isInteger(maxDelayMs)
    || baseDelayMs < MIN_CONFIG_RETRY_DELAY_MS
    || maxDelayMs < baseDelayMs
    || maxDelayMs > MAX_CONFIG_RETRY_DELAY_MS
  ) {
    return false
  }

  if (
    config.webSocketUrl !== undefined
    && !isValidConfigWebSocketUrl(config.webSocketUrl)
  ) {
    return false
  }
  if (config.mode === 'do-primary' && config.webSocketUrl === undefined) {
    return false
  }

  return config.overlayVersion === undefined
    || isValidOverlayVersion(config.overlayVersion)
}

function websocketUrl(
  baseUrl: string,
  streamerId: string,
  presenceTokenOverride?: string | null,
): string | null {
  try {
    const url = new URL(baseUrl)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
    url.pathname = `/v1/rooms/${encodeURIComponent(streamerId)}/connect`
    url.search = ''
    url.searchParams.set('clientVersion', 'overlay-v1')
    // The settings page places a room-scoped liveness capability on the OBS
    // URL. Keep it out of the public config response; only the overlay page
    // that was given the capability forwards it to the WebSocket edge.
    const presenceToken = presenceTokenOverride === undefined
      ? (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('presence')
        : null)
      : presenceTokenOverride
    if (presenceToken && presenceToken.length <= OVERLAY_REALTIME_PRESENCE_TOKEN_MAX_LENGTH) {
      url.searchParams.set('presence', presenceToken)
    }
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Start the DO-primary + polling-recovery controller.
 *
 * Both sources pass through one event-ID cache before reaching the page queue.
 * Polling remains active during WebSocket reconnect/deploy windows and uses the
 * server's stable `(redeemed_at, history_id)` cursor when available.
 */
export function subscribeToGachaResults(
  streamerId: string,
  callback: GachaResultCallback,
  options: SubscribeOptions = {}
): () => void {
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY
  const intervalMs = options.retryDelay ?? 3_000
  const seenEventIds = loadSeenEvents(streamerId)
  let disposed = false
  let retryCount = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectTimeout: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let socketGeneration = 0
  let reconnectAttempt = 0
  let pollInFlight = false
  // Recovery requests can arrive while an earlier history snapshot is still
  // in flight (most notably WebSocket onopen racing startup polling). Remember
  // that edge instead of dropping it; one trailing empty-page read closes the
  // commit window between the two snapshots.
  let recoveryPollPending = false
  // While a socket recovery is draining DB history, hold pushed frames so the
  // authoritative `(redeemed_at, id)` order is displayed before the live tail.
  let socketRecoveryActive = false
  let bufferedSocketEvents: GachaRealtimeEventV1[] = []
  let recoveryBufferTimer: ReturnType<typeof setTimeout> | null = null
  // WebSocket frames and recovery flushes share one serial task queue. The
  // first task starts synchronously (so existing low-latency callbacks remain
  // observable in the same turn), then stays serialized while a DOM
  // acknowledgement is pending. Without this owner, B can overtake A.
  let socketDeliveryBusy = false
  const socketDeliveryTasks: Array<() => Promise<void> | void> = []
  let socketFlushInFlight = false
  const demoRetryCounts = new Map<string, number>()
  const demoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // A long N-draw DOM acknowledgement can overlap the safety poll. Keep
  // those IDs distinct from committed dedupe entries so polling does not move
  // the durable cursor past an event whose batch is still awaiting display.
  const pendingEventIds = new Set<string>()
  // IDs delivered by DO but not yet observed in a DB response. This separate
  // set prevents bounded general dedupe eviction from cascading into hundreds
  // of duplicate renders while a multi-page reconciliation drains.
  const unreconciledSocketEventIds = new Set<string>()
  let highVolumeRecoveryRequested = false
  let currentConfig: OverlayRealtimeConfigV1 | null = null
  // The initial capability comes from the settings-generated overlay URL. A
  // connected room may replace it through a private server notice before the
  // next reconnect, so long-running OBS sessions do not silently age out.
  let currentPresenceToken = readOverlayPresenceToken(streamerId)
  // A present value followed by an absent value means this new client reached
  // an older app Worker during rollback. One legacy `/events` probe preserves
  // build-version rollback detection without a steady-state DB poll.
  let configPreviouslyCarriedOverlayVersion = false
  /** Guards the change-triggered refetch against a config endpoint outage. */
  let lastConfigAttemptAt = 0
  let configRefreshInFlight = false
  /**
   * Last per-room fanout number this socket observed. `null` until the room
   * reports one, which keeps the client compatible with a room that has not
   * been redeployed yet.
   */
  let lastSeq: number | null = null
  let livenessTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Config version that was in effect when the room reported itself disabled,
   * and when that happened. The room is authoritative about whether it will
   * serve this streamer, and the two allowlists (app Worker and standalone
   * Worker) are separate secrets that can disagree mid-rollout. Without this
   * marker a room that says "disabled" while the config endpoint still says
   * `do-primary` sends the client into a reconnect-with-backoff loop against
   * an endpoint that answers 503 — observed in preview during the kill-switch
   * test. Reconnecting is allowed again as soon as the operator publishes a
   * different config, or after DO_SUPPRESSION_TTL_MS regardless of config
   * version — see DO_SUPPRESSION_TTL_MS for why version alone is not enough.
   */
  let disabledForConfigVersion: string | null = null
  let disabledAt = 0
  /**
   * Consecutive connection attempts that never reached `onopen`.
   *
   * A room that rejects the WS upgrade (edge Worker's `realtimeEnabled()`
   * gate returning 503 — see `workers/overlay-realtime/src/index.ts`)
   * produces the exact same `onerror` + `onclose(1006)` the browser fires for
   * an ordinary transient drop; there is no way to tell them apart from the
   * close event alone. Without this counter, a room disabled for longer than
   * DO_SUPPRESSION_TTL_MS reconnects every ~15-30s indefinitely via the normal
   * exponential-backoff path in `scheduleReconnect` (this reoccurrence of the
   * loop ec6852f fixed was found in review, not in the preview test — the
   * preview run happened to have the room re-enabled before the gap showed).
   * After OPEN_FAILURE_SUPPRESSION_THRESHOLD straight open failures, treat it
   * like an explicit `transport_disabled` notice: fall back to the slower
   * TTL-gated retry instead of hammering an endpoint that keeps 503ing.
   */
  let consecutiveOpenFailures = 0
  const startedAt = new Date().toISOString()
  const restoredHistoryCursor = normalizeHistoryCursor(options.initialHistoryCursor)
  let historyCursor: OverlayHistoryCursor = restoredHistoryCursor
    ?? { redeemedAt: startedAt, historyId: '' }
  // Demo delivery is independent from committed history. Restoring an old
  // business cursor here would replay old operator demos after a build reload.
  let demoCursor: OverlayHistoryCursor = {
    redeemedAt: startedAt,
    historyId: '',
  }

  const reportHistoryCursor = (cursor: OverlayHistoryCursor) => {
    historyCursor = { ...cursor }
    options.onHistoryCursor?.({ ...historyCursor })
  }

  const beginSocketRecovery = () => {
    if (disposed) return
    socketRecoveryActive = true
    // A previous bounded flush may have kept the recovery state active after
    // a callback failure. Re-arm the safety deadline in that case; otherwise
    // every later live frame would remain buffered forever with no timeout.
    if (recoveryBufferTimer) return
    recoveryBufferTimer = setTimeout(() => {
      recoveryBufferTimer = null
      releaseSocketRecoveryBuffer('timeout')
    }, SOCKET_RECOVERY_BUFFER_MAX_MS)
  }

  const ingest = (
    event: GachaRealtimeEventV1,
    source: 'durable-object' | 'polling'
  ): IngestStatus | Promise<IngestStatus> => {
    const validation = validateGachaRealtimeEvent(event, streamerId)
    if (!validation.ok) {
      options.onStatusChange?.(`INVALID_EVENT:${source}`)
      return 'invalid'
    }

    // Do not make an event durable in the dedupe cache until the page callback
    // has accepted it. A browser render callback can throw during a rolling
    // deploy, React teardown, or an older OBS runtime; if the ID were kept
    // before that callback, the following polling recovery would classify the
    // same committed draw as a duplicate and the user would see a permanent
    // black overlay. Track only IDs added by this ingest so a callback failure
    // can roll them back without disturbing earlier successful deliveries.
    const newlySeenEventIds: string[] = []
    const newlyUnreconciledSocketEventIds: string[] = []
    let pendingDrawEncountered = false
    const releaseNewClaims = () => {
      // A polling envelope can contain a draw that is already awaiting a page
      // ACK followed by a new draw from the same batch. Do not leave the new
      // tail in `pendingEventIds` when the envelope is deferred as a whole;
      // the next pass must be able to claim it after the first draw settles.
      for (const eventId of newlySeenEventIds) {
        seenEventIds.delete(eventId)
        pendingEventIds.delete(eventId)
      }
      for (const eventId of newlyUnreconciledSocketEventIds) {
        unreconciledSocketEventIds.delete(eventId)
      }
    }
    const unseenDraws = event.draws.filter((draw) => {
      if (pendingEventIds.has(draw.eventId)) {
        pendingDrawEncountered = true
        return false
      }
      // Seeing the exact ID in a polling envelope proves that this socket
      // delivery is now behind the authoritative DB checkpoint. Treat it as a
      // duplicate even if the general bounded cache has already evicted it.
      const confirmedSocketDelivery = source === 'polling'
        && unreconciledSocketEventIds.delete(draw.eventId)
      if (confirmedSocketDelivery || seenEventIds.has(draw.eventId)) return false
      if (!rememberSeenId(seenEventIds, draw.eventId)) return false
      newlySeenEventIds.push(draw.eventId)
      pendingEventIds.add(draw.eventId)

      if (source === 'durable-object' && event.deliveryKind !== 'demo') {
        // Committed socket events remain pending until the authoritative DB
        // cursor observes their IDs. Operator demos deliberately have no
        // gacha_history row (their bounded fallback is KV), so adding one here
        // would manufacture permanent reconciliation debt and eventually
        // trigger high-volume /events reads after enough dashboard previews.
        unreconciledSocketEventIds.add(draw.eventId)
        newlyUnreconciledSocketEventIds.push(draw.eventId)
        if (unreconciledSocketEventIds.size > MAX_SEEN_EVENT_IDS) {
          // A sustained DB outage must not grow OBS memory without bound. This
          // extreme degradation can replay an oldest draw after DB recovery,
          // but never advances the checkpoint or loses an unseen committed row.
          const oldest = unreconciledSocketEventIds.values().next().value
          if (typeof oldest === 'string') unreconciledSocketEventIds.delete(oldest)
          options.onStatusChange?.('DO_DEDUPE_WINDOW_TRUNCATED')
        }
      }
      return true
    })
    if (pendingDrawEncountered) {
      releaseNewClaims()
      options.onStatusChange?.(`PENDING_EVENT:${source}`)
      return 'pending'
    }
    if (
      source === 'polling'
      && unreconciledSocketEventIds.size < SOCKET_RECONCILIATION_TRIGGER_IDS
    ) {
      highVolumeRecoveryRequested = false
    }
    if (unseenDraws.length === 0) {
      options.onStatusChange?.(`DUPLICATE_EVENT:${source}`)
      return 'duplicate'
    }
    const rollback = () => {
      // A callback failure is a delivery failure, not a malformed event. Roll
      // back only the IDs claimed by this attempt; polling can then retry the
      // exact committed row without consuming another channel-point exchange.
      releaseNewClaims()
      options.onStatusChange?.(`CALLBACK_ERROR:${source}`)
      return 'callback-error' as const
    }
    const commit = (accepted: void | boolean) => {
      if (accepted === false) {
        throw new Error('overlay callback rejected event')
      }
      for (const eventId of newlySeenEventIds) {
        pendingEventIds.delete(eventId)
      }
      // Persist only after the page accepted the payload. Storage is an
      // optimization for reload dedupe; the in-memory rollback above is the
      // correctness boundary for the current overlay lifetime.
      persistSeenEvents(streamerId, seenEventIds)
      return 'delivered' as const
    }
    try {
      const callbackResult = callback({
        type: 'gacha',
        card: unseenDraws[0].card,
        ...(unseenDraws.length > 1 ? { cards: unseenDraws.map((draw) => draw.card) } : {}),
        ...(unseenDraws.length > 1
          ? { drawEventIds: unseenDraws.map((draw) => draw.eventId) }
          : {}),
        userTwitchUsername: event.user.twitchUsername,
        rewardId: event.rewardId ?? null,
        soundGroupId: event.soundGroupId,
        historyCursor: event.occurredAt,
      })
      if (isPromiseLike<void | boolean>(callbackResult)) {
        return Promise.resolve(callbackResult)
          .then(commit)
          .catch(() => rollback())
      }
      return commit(callbackResult)
    } catch {
      return rollback()
    }
  }

  const socketIsHealthy = () => (
    currentConfig?.mode === 'do-primary'
    && typeof WebSocket !== 'undefined'
    && socket?.readyState === WebSocket.OPEN
  )

  const schedulePoll = (delay: number) => {
    if (disposed) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      pollTimer = null
      void poll()
    }, delay)
  }

  /**
   * Request an authoritative history recovery without racing the one already
   * running. `bufferLiveFrames` is used for startup/reconnect/gap boundaries:
   * pushed events wait until DB pages have drained, preserving DB order.
   */
  const requestRecoveryPoll = (bufferLiveFrames = false) => {
    if (disposed) return
    if (bufferLiveFrames) beginSocketRecovery()
    if (pollInFlight) {
      recoveryPollPending = true
      return
    }
    schedulePoll(0)
  }

  const drainSocketDeliveryTasks = () => {
    if (socketDeliveryBusy || disposed) return
    const task = socketDeliveryTasks.shift()
    if (!task) return
    socketDeliveryBusy = true
    const finish = () => {
      socketDeliveryBusy = false
      drainSocketDeliveryTasks()
    }
    try {
      const result = task()
      if (isPromiseLike<void>(result)) {
        void Promise.resolve(result).then(finish, (error) => {
          if (!disposed) {
            options.onStatusChange?.('DO_DELIVERY_TASK_ERROR')
            options.onError?.({
              type: 'broadcast',
              message: 'Overlay WebSocket delivery failed',
              error,
              isExpected: false,
            })
          }
          finish()
        })
      } else {
        finish()
      }
    } catch (error) {
      if (!disposed) {
        options.onStatusChange?.('DO_DELIVERY_TASK_ERROR')
        options.onError?.({
          type: 'broadcast',
          message: 'Overlay WebSocket delivery failed',
          error,
          isExpected: false,
        })
      }
      finish()
    }
  }

  const enqueueSocketTask = (task: () => Promise<void> | void) => {
    socketDeliveryTasks.push(task)
    drainSocketDeliveryTasks()
  }

  function maybeRequestVolumeReconciliation(): void {
    if (
      disposed
      || highVolumeRecoveryRequested
      || unreconciledSocketEventIds.size < SOCKET_RECONCILIATION_TRIGGER_IDS
    ) {
      return
    }
    highVolumeRecoveryRequested = true
    options.onStatusChange?.(
      `DO_RECONCILE_VOLUME:${unreconciledSocketEventIds.size}`
    )
    requestRecoveryPoll()
  }

  const scheduleDemoRetry = (event: GachaRealtimeEventV1) => {
    const demoId = event.draws[0]?.eventId
    if (!demoId || disposed || demoRetryTimers.has(demoId)) return
    const attempt = (demoRetryCounts.get(demoId) ?? 0) + 1
    demoRetryCounts.set(demoId, attempt)
    if (attempt > 3) {
      options.onStatusChange?.('DO_DEMO_RETRY_EXHAUSTED')
      demoRetryCounts.delete(demoId)
      demoRetryTimers.delete(demoId)
      // A broken operator demo must not hold the live queue forever. Remove
      // only that demo and schedule the retained tail; committed user events
      // remain ordered and are never discarded by this bounded demo guard.
      bufferedSocketEvents = bufferedSocketEvents.filter(
        (bufferedEvent) => bufferedEvent.draws[0]?.eventId !== demoId
      )
      if (bufferedSocketEvents.length > 0) {
        enqueueSocketTask(() => flushBufferedSocketEvents())
      } else {
        socketRecoveryActive = false
      }
      return
    }
    const delay = Math.min(100 * 2 ** (attempt - 1), 1_000)
    options.onStatusChange?.(`DO_DEMO_RETRY:${attempt}`)
    const timer = setTimeout(() => {
      demoRetryTimers.delete(demoId)
      enqueueSocketTask(() => flushBufferedSocketEvents())
    }, delay)
    demoRetryTimers.set(demoId, timer)
  }

  function flushBufferedSocketEvents(): void | Promise<void> {
    if (socketFlushInFlight || disposed) return
    socketFlushInFlight = true
    const buffered = bufferedSocketEvents
    bufferedSocketEvents = []
    let finished = false
    const finish = (completed: boolean) => {
      if (finished) return
      finished = true
      socketFlushInFlight = false
      if (completed) socketRecoveryActive = false
      if (completed) maybeRequestVolumeReconciliation()
    }
    const handleResult = (event: GachaRealtimeEventV1, index: number, result: IngestStatus) => {
      if (result === 'callback-error') {
        // Keep the failed frame and every later frame in their original order.
        // Releasing B while A is waiting for a DOM acknowledgement would make
        // recovery render B before A.
        bufferedSocketEvents = buffered.slice(index).concat(bufferedSocketEvents)
        if (event.deliveryKind === 'demo') {
          socketRecoveryActive = true
          scheduleDemoRetry(event)
        } else {
          // The frame has been rolled back from dedupe; ask the authoritative
          // history endpoint for an immediate retry instead of waiting for the
          // ten-minute healthy-socket reconciliation.
          requestRecoveryPoll(true)
        }
        return false
      }
      if (result === 'pending') {
        // The same event is already waiting for a page-side DOM ACK. Keep it
        // and its tail behind that in-flight owner; the next polling pass will
        // retry only after the owner resolves.
        bufferedSocketEvents = buffered.slice(index).concat(bufferedSocketEvents)
        requestRecoveryPoll(true)
        return false
      }
      if (event.deliveryKind === 'demo') {
        const demoId = event.draws[0]?.eventId
        if (demoId) {
          demoRetryCounts.delete(demoId)
          const retryTimer = demoRetryTimers.get(demoId)
          if (retryTimer) clearTimeout(retryTimer)
          demoRetryTimers.delete(demoId)
        }
      }
      return true
    }
    const drain = (startIndex: number): void | Promise<void> => {
      for (let index = startIndex; index < buffered.length; index += 1) {
        const event = buffered[index]
        // The authoritative reconciliation checkpoint advances only from an
        // actual DB response. Even a newly delivered socket frame may have an
        // earlier gapless publish failure behind it, so ingest it without moving
        // the history cursor.
        const result = ingest(event, 'durable-object')
        if (isPromiseLike<IngestStatus>(result)) {
          return Promise.resolve(result)
            .then((resolved) => {
              if (!handleResult(event, index, resolved)) {
                finish(false)
                return
              }
              return drain(index + 1)
            })
            .catch(() => {
              bufferedSocketEvents = buffered.slice(index).concat(bufferedSocketEvents)
              requestRecoveryPoll()
              finish(false)
            })
        }
        if (!handleResult(event, index, result)) {
          finish(false)
          return
        }
      }
      finish(true)
    }
    return drain(0)
  }

  function releaseSocketRecoveryBuffer(
    degradedBy?: 'capacity' | 'timeout'
  ): void {
    if (recoveryBufferTimer) clearTimeout(recoveryBufferTimer)
    recoveryBufferTimer = null
    const hadRecovery = socketRecoveryActive || bufferedSocketEvents.length > 0
    if (degradedBy && hadRecovery) {
      options.onStatusChange?.(`DO_RECOVERY_DEGRADED:${degradedBy}`)
    }
    enqueueSocketTask(() => flushBufferedSocketEvents())
  }

  const poll = async () => {
    if (disposed) return
    if (pollInFlight) {
      recoveryPollPending = true
      return
    }
    pollInFlight = true
    options.onStatusChange?.('POLLING')
    let historyPageHadRows = false
    let failed = false
    let callbackRejected = false
    let pendingAcknowledgement = false
    let retryDelayMs: number | null = null
    try {
      // History recovery and the rare operator demo share one HTTP response.
      // Keeping separate cursors in that response preserves the critical rule
      // that a demo timestamp must never advance committed gacha history, while
      // avoiding one always-on Worker invocation per active OBS overlay.
      const historyResponse = await fetchJson<PollingResponse>(
        eventUrl(streamerId, historyCursor, demoCursor)
      )
      if (disposed) return

      // `/events` is an untrusted public boundary. Notify the page only after
      // applying the same non-empty length bound as realtime-config; malformed
      // optional metadata must not schedule a reload or break history recovery.
      if (isValidOverlayVersion(historyResponse.overlayVersion)) {
        options.onOverlayVersion?.(historyResponse.overlayVersion)
      }

      const rawEvents = historyResponse.events ?? []
      const envelopes = historyResponse.realtimeEvents?.length
        ? historyResponse.realtimeEvents
        : buildPollingRealtimeEvents(streamerId, rawEvents)
      // A polling draw is the ordering barrier for the live tail. Start
      // buffering healthy-socket frames before awaiting its DOM acknowledgement
      // so B cannot overtake a still-pending A even when A eventually rejects.
      if (socketIsHealthy() && envelopes.length > 0) {
        beginSocketRecovery()
      }
      for (const event of envelopes) {
        const ingestResult = await ingest(event, 'polling')
        if (ingestResult === 'pending') {
          pendingAcknowledgement = true
          throw new Error('overlay callback is still awaiting display acknowledgement')
        }
        if (ingestResult === 'callback-error') {
          // Do not advance the authoritative cursor past a draw whose page
          // callback rejected it. The catch/finally path schedules a bounded
          // retry of the same /events page.
          callbackRejected = true
          throw new Error('overlay callback rejected polling event')
        }
      }

      if (historyResponse.nextCursor !== undefined && historyResponse.nextCursor !== null) {
        const nextCursor = normalizeHistoryCursor(historyResponse.nextCursor, true)
        if (!nextCursor) {
          throw new Error('invalid history cursor')
        }
        reportHistoryCursor(nextCursor)
        historyPageHadRows = true
      } else if (rawEvents.length > 0) {
        const last = rawEvents[rawEvents.length - 1]
        const legacyCursor = normalizeHistoryCursor(
          { redeemedAt: last.redeemedAt, historyId: last.id },
          true
        )
        // Older app Workers omit `nextCursor`. Validate their last row with the
        // same exact cursor contract before allowing it to become the next URL.
        if (!legacyCursor) {
          throw new Error('invalid legacy history cursor')
        }
        reportHistoryCursor(legacyCursor)
        historyPageHadRows = true
      } else if (envelopes.length > 0) {
        // A V1 response with history but no exact cursor cannot be drained
        // safely: retry rather than querying the same page forever or skipping
        // rows that share a timestamp.
        throw new Error('history response omitted next cursor')
      }

      const demoEvent = historyResponse.demoEvent ?? null
      if (demoEvent) {
        const demoId = demoEvent.eventId ?? `demo:${demoEvent.id}`
        if (rememberSeenId(seenEventIds, demoId)) {
          try {
            const accepted = await callback({
              type: 'gacha',
              card: demoEvent.card,
              userTwitchUsername: demoEvent.userTwitchUsername,
              rewardId: demoEvent.rewardId ?? null,
            })
            if (accepted === false) {
              throw new Error('overlay callback rejected demo event')
            }
          } catch {
            seenEventIds.delete(demoId)
            options.onStatusChange?.('CALLBACK_ERROR:polling-demo')
            throw new Error('overlay callback rejected demo event')
          }
          demoCursor = { redeemedAt: demoEvent.redeemedAt, historyId: demoEvent.id }
          persistSeenEvents(streamerId, seenEventIds)
        }
      }

      retryCount = 0
      // Rollout/rollback detection rides on this response instead of a separate
      // config poll. A refresh can itself request recovery; the pending flag is
      // consumed in `finally` together with any onopen/gap request.
      maybeRefreshConfigFor(historyResponse.realtimeConfigVersion)
    } catch (error) {
      failed = true
      retryCount += 1
      if (callbackRejected || pendingAcknowledgement) {
        // A failed DOM acknowledgement leaves the history cursor before the
        // rejected draw. Keep later WebSocket frames behind that draw until a
        // retrying /events pass commits it; otherwise B can render before A
        // and the fixed overlay can still appear to skip the first card.
        beginSocketRecovery()
      }
      // `/events` normally carries the config generation for free, but a DB
      // failure prevents that response from being produced. Probe the DB-free
      // config endpoint only in this degraded case so a healthy socket on URL A
      // still moves to B within a bounded interval. The helper is separately
      // rate-limited and preserves the current socket if the probe itself fails.
      maybeRefreshConfigAfterHistoryFailure()
      const exhausted = Number.isFinite(maxRetries) && retryCount > maxRetries
      if (exhausted) {
        options.onError?.({
          type: 'connection',
          message: 'Overlay polling retry limit reached',
          error,
          isExpected: false,
        })
      } else {
        options.onStatusChange?.(`POLLING_RETRY:${retryCount}`)
        retryDelayMs = Math.min(
          intervalMs * 2 ** Math.max(0, retryCount - 1),
          30_000
        )
      }
    } finally {
      pollInFlight = false
      if (disposed) return

      const trailingRecovery = recoveryPollPending
      recoveryPollPending = false
      if (failed) {
        if (retryDelayMs !== null) schedulePoll(retryDelayMs)
        return
      }

      // `nextCursor` means at least one DB row was read. Continue immediately
      // until an empty page proves the 100-row API window has been drained.
      // A request raised during the fetch likewise earns one trailing pass,
      // closing the startup/reconnect snapshot race without concurrent reads.
      if (historyPageHadRows || trailingRecovery) {
        schedulePoll(0)
        return
      }

      if (socketRecoveryActive) {
        releaseSocketRecoveryBuffer()
      } else if (bufferedSocketEvents.length > 0) {
        // A prior socket callback may have failed after buffering A/B. The
        // successful polling pass above has now retried the committed A; drain
        // the retained live tail only after that acknowledgement completes.
        enqueueSocketTask(() => flushBufferedSocketEvents())
      }

      // A healthy socket's low-frequency reconciliation is owned by the safety
      // timer. Disconnected and polling-only modes retain the normal
      // three-second cadence.
      if (!socketIsHealthy()) schedulePoll(intervalMs)
    }
  }

  /**
   * Restart the silence deadline for the current socket.
   *
   * Called for every server frame, gacha or heartbeat alike. If it ever fires,
   * the socket is delivering nothing despite looking open, so it is closed
   * deliberately: `onclose` then resumes history polling and reconnects, which
   * is the same recovery path a clean disconnect takes.
   */
  const armLiveness = () => {
    if (livenessTimer) clearTimeout(livenessTimer)
    if (disposed) return
    livenessTimer = setTimeout(() => {
      if (disposed || !socket) return
      options.onStatusChange?.('DO_LIVENESS_TIMEOUT')
      try {
        socket.close(1006, 'No server frames')
      } catch {
        // Falling through to closeSocket still restores polling.
      }
      closeSocket()
      requestRecoveryPoll()
      scheduleReconnect()
    }, SOCKET_LIVENESS_TIMEOUT_MS)
  }

  const closeSocket = () => {
    socketGeneration += 1
    if (livenessTimer) clearTimeout(livenessTimer)
    livenessTimer = null
    lastSeq = null
    if (connectTimeout) clearTimeout(connectTimeout)
    connectTimeout = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    const active = socket
    socket = null
    if (
      active
      && typeof WebSocket !== 'undefined'
      && active.readyState < WebSocket.CLOSING
    ) {
      active.close(1000, 'Transport changed')
    }
  }

  const scheduleReconnect = () => {
    if (disposed || currentConfig?.mode !== 'do-primary') return
    reconnectAttempt += 1
    const base = Math.max(100, currentConfig.retryPolicy.baseDelayMs)
    const maximum = Math.max(base, currentConfig.retryPolicy.maxDelayMs)
    const exponential = Math.min(base * 2 ** Math.min(reconnectAttempt - 1, 8), maximum)
    const delay = Math.floor(exponential / 2 + Math.random() * exponential / 2)
    options.onStatusChange?.(`DO_RECONNECT_WAIT:${delay}`)
    reconnectTimer = setTimeout(() => connectWebSocket(), delay)
  }

  const connectWebSocket = () => {
    if (disposed || currentConfig?.mode !== 'do-primary' || typeof WebSocket === 'undefined') return
    const target = websocketUrl(
      currentConfig.webSocketUrl ?? '',
      streamerId,
      currentPresenceToken,
    )
    if (!target) {
      options.onStatusChange?.('DO_CONFIG_INVALID')
      return
    }

    closeSocket()
    const generation = ++socketGeneration
    // Distinguishes "the socket opened, then something else closed it" from
    // "the upgrade itself was refused" — see consecutiveOpenFailures.
    let hasOpened = false
    options.onStatusChange?.('DO_CONNECTING')
    try {
      const nextSocket = new WebSocket(target)
      socket = nextSocket
      connectTimeout = setTimeout(() => {
        if (generation === socketGeneration && nextSocket.readyState !== WebSocket.OPEN) {
          nextSocket.close(1000, 'Connection timeout')
        }
      }, WS_CONNECT_TIMEOUT_MS)

      nextSocket.onopen = () => {
        if (disposed || generation !== socketGeneration) return
        if (connectTimeout) clearTimeout(connectTimeout)
        connectTimeout = null
        hasOpened = true
        reconnectAttempt = 0
        consecutiveOpenFailures = 0
        options.onStatusChange?.('DO_CONNECTED')
        nextSocket.send(JSON.stringify({
          type: 'hello',
          protocolVersion: OVERLAY_REALTIME_PROTOCOL_VERSION,
          clientVersion: 'overlay-v1',
        }))
        // Immediate polling closes the gap between the previous socket's last
        // frame and this connection becoming active. If startup polling is
        // still in flight, requestRecoveryPoll remembers a trailing snapshot.
        requestRecoveryPoll(true)
      }

      nextSocket.onmessage = (message) => {
        if (disposed || generation !== socketGeneration || typeof message.data !== 'string') return
        try {
          const parsed = JSON.parse(message.data) as OverlayRealtimeServerMessage
          if (parsed.type === 'welcome' && parsed.protocolVersion !== OVERLAY_REALTIME_PROTOCOL_VERSION) {
            options.onStatusChange?.('DO_PROTOCOL_MISMATCH')
            closeSocket()
            return
          }
          // Any frame proves the socket is alive, including a heartbeat that
          // carries no payload.
          armLiveness()
          if (parsed.type === 'welcome') {
            // Baseline from the room so the next delivery is contiguous rather
            // than looking like a miss. The immediate poll scheduled by onopen
            // already covers whatever happened while disconnected.
            lastSeq = typeof parsed.seq === 'number' ? parsed.seq : null
            return
          }
          if (parsed.type === 'server_notice') {
            if (parsed.code === OVERLAY_REALTIME_PRESENCE_REFRESH) {
              const refreshed = persistOverlayPresenceToken(
                streamerId,
                parsed.presenceToken,
              )
              if (refreshed) {
                const current = parsePresenceToken(currentPresenceToken)
                if (!current || refreshed.expiresAt >= current.expiresAt) {
                  currentPresenceToken = refreshed.token
                }
                options.onStatusChange?.('DO_PRESENCE_REFRESHED')
              }
              return
            }
            options.onStatusChange?.(`DO_NOTICE:${parsed.code}`)
            if (parsed.code === TRANSPORT_DISABLED_NOTICE) {
              // The room itself reports that the operator disabled it. Remember
              // which config this applies to so a config endpoint that still
              // advertises `do-primary` cannot immediately reconnect us into the
              // room that just refused to serve.
              disabledForConfigVersion = currentConfig?.configVersion ?? null
              disabledAt = Date.now()
              closeSocket()
              requestRecoveryPoll()
              // Authoritative signal, so it bypasses the version-mismatch floor
              // instead of waiting for the next history pass to notice.
              void refreshConfig()
            }
            return
          }
          if (parsed.type === 'gacha_result') {
            // Serialize WebSocket delivery behind the DOM acknowledgement. A
            // callback can be asynchronous while React commits the card, so
            // handling frames directly here would allow B to overtake A.
            enqueueSocketTask(() => {
              if (disposed || generation !== socketGeneration) return
              // Validate before buffering, not only before display. Otherwise a
              // malformed room frame could bypass the 64 KiB contract and make
              // the count-bounded recovery queue consume unbounded memory.
              const eventValidation = validateGachaRealtimeEvent(
                parsed.event,
                streamerId
              )
              if (!eventValidation.ok) {
                options.onStatusChange?.('INVALID_EVENT:durable-object')
                return
              }
              // A jump proves this socket missed a delivery. That is the only
              // reason a healthy connection reloads history now; the database
              // still decides what was actually missed.
              const sequenceGap = (
                typeof parsed.seq === 'number'
                && lastSeq !== null
                && parsed.seq > lastSeq + 1
              )
              if (sequenceGap) {
                options.onStatusChange?.(`DO_SEQ_GAP:${lastSeq}->${parsed.seq}`)
                requestRecoveryPoll(true)
              }
              if (typeof parsed.seq === 'number') lastSeq = parsed.seq
              if (socketRecoveryActive) {
                bufferedSocketEvents.push(parsed.event)
                if (bufferedSocketEvents.length >= MAX_BUFFERED_SOCKET_EVENTS) {
                  // DB ordering is best-effort once the bounded recovery window
                  // fills. Release validated live events, retain their IDs for
                  // later DB dedupe, and keep the checkpoint unchanged.
                  releaseSocketRecoveryBuffer('capacity')
                }
                return
              }
              // A pushed event is low-latency delivery, not proof that every
              // earlier committed row reached the room. Only `/events` may move
              // the durable reconciliation checkpoint.
              const handleIngestResult = (ingestResult: IngestStatus) => {
                if (ingestResult === 'delivered') {
                  maybeRequestVolumeReconciliation()
                } else if (ingestResult === 'callback-error') {
                if (parsed.event.deliveryKind === 'demo') {
                  // Keep later live frames behind the failed demo until its
                  // local retry has committed; otherwise B would overtake A.
                  socketRecoveryActive = true
                  bufferedSocketEvents.unshift(parsed.event)
                  scheduleDemoRetry(parsed.event)
                } else {
                  // A render callback failure must not become a permanent
                  // duplicate. Poll the committed row immediately so the next
                  // attempt can recover after the page is ready.
                  requestRecoveryPoll(true)
                }
                }
              }
              const ingestResult = ingest(parsed.event, 'durable-object')
              if (isPromiseLike<IngestStatus>(ingestResult)) {
                return Promise.resolve(ingestResult).then(handleIngestResult).then(() => undefined)
              }
              handleIngestResult(ingestResult)
            })
          }
        } catch {
          options.onStatusChange?.('DO_MESSAGE_INVALID')
        }
      }

      nextSocket.onerror = () => {
        if (generation === socketGeneration) options.onStatusChange?.('DO_ERROR')
      }
      nextSocket.onclose = (event) => {
        if (disposed || generation !== socketGeneration) return
        socket = null
        options.onStatusChange?.(`DO_CLOSED:${event.code}`)
        requestRecoveryPoll()
        // Policy/protocol violations require operator config correction. Keep
        // polling alive but avoid an infinite reconnect storm.
        if ([1002, 1003, 1008, 1009].includes(event.code)) return

        if (hasOpened) {
          scheduleReconnect()
          return
        }

        // The upgrade never completed. A room that 503s the connect request
        // (edge Worker's realtimeEnabled() gate — see
        // OPEN_FAILURE_SUPPRESSION_THRESHOLD) produces this same
        // onerror+onclose(1006) as an ordinary transient drop, so a handful
        // of attempts are given the benefit of the doubt via the normal
        // backoff before concluding the room is refusing us.
        consecutiveOpenFailures += 1
        if (consecutiveOpenFailures < OPEN_FAILURE_SUPPRESSION_THRESHOLD) {
          scheduleReconnect()
          return
        }
        options.onStatusChange?.('DO_SUPPRESSED:open_failures')
        disabledForConfigVersion = currentConfig?.configVersion ?? null
        disabledAt = Date.now()
        // Anchors the TTL to this moment (mirrors the transport_disabled
        // path): re-arms the safety timer for DO_SUPPRESSION_TTL_MS from now
        // instead of leaving it on whatever schedule the last config fetch
        // happened to set.
        void refreshConfig()
      }
    } catch {
      options.onStatusChange?.('DO_CONSTRUCTOR_FAILED')
      scheduleReconnect()
    }
  }

  /**
   * Re-arm the one steady-state timer without creating parallel config and
   * history schedules. Healthy sockets reconcile history; suppressed or
   * disconnected sockets refresh config so kill-switch recovery stays bounded.
   */
  function scheduleSafetyRefresh(delay: number): void {
    if (disposed) return
    if (safetyTimer) clearTimeout(safetyTimer)
    safetyTimer = setTimeout(() => {
      safetyTimer = null
      if (disabledForConfigVersion === null && socketIsHealthy()) {
        // Do not buffer healthy live delivery for a routine sweep. The DB
        // checkpoint intentionally trails socket delivery, so dedupe can
        // recover a gapless failed publish on this pass without skipping it.
        requestRecoveryPoll()
        scheduleSafetyRefresh(CONNECTED_RECONCILIATION_MS)
        return
      }
      void refreshConfig()
    }, delay)
  }

  async function refreshConfig(
    expectedVersion?: string,
    preserveCurrentOnFailure = false
  ): Promise<void> {
    if (disposed || configRefreshInFlight) return
    configRefreshInFlight = true
    lastConfigAttemptAt = Date.now()
    // A change-triggered refetch must not race the safety-net timer into two
    // concurrent config states; the timer is always re-armed in `finally`.
    if (safetyTimer) clearTimeout(safetyTimer)
    safetyTimer = null
    try {
      const config = await fetchJson<unknown>(
        configUrl(streamerId, expectedVersion),
        'default'
      )
      if (!validConfig(config)) throw new Error('invalid config')
      if (disposed) return
      const previousMode = currentConfig?.mode
      const previousUrl = currentConfig?.webSocketUrl
      currentConfig = config
      const needsLegacyVersionProbe =
        configPreviouslyCarriedOverlayVersion
        && config.overlayVersion === undefined
      // Notify only for a successfully fetched and fully validated config.
      // Safe fallback and malformed responses deliberately never carry a
      // version signal that could schedule an unrelated page reload.
      if (config.overlayVersion) {
        configPreviouslyCarriedOverlayVersion = true
        options.onOverlayVersion?.(config.overlayVersion)
      } else if (needsLegacyVersionProbe) {
        configPreviouslyCarriedOverlayVersion = false
      }
      options.onStatusChange?.(`CONFIG:${config.mode}:${config.configVersion}`)
      if (
        previousMode !== config.mode
        || previousUrl !== config.webSocketUrl
      ) {
        // An operator mode/endpoint change starts a fresh connection policy.
        // Retaining an old outage's high backoff would make kill-switch
        // recovery needlessly slow after a valid config update.
        reconnectAttempt = 0
      }
      // A new config supersedes whatever the room said about the old one.
      // The app Worker's allowlist can be a wildcard that never changes
      // per-streamer, so also expire suppression after DO_SUPPRESSION_TTL_MS
      // regardless of config version — otherwise an operator flipping the
      // room-side allowlist back produces no signal this client can see
      // (issue #844) and it would stay on polling until reloaded.
      if (
        disabledForConfigVersion !== null
        && (
          config.configVersion !== disabledForConfigVersion
          || Date.now() - disabledAt >= DO_SUPPRESSION_TTL_MS
        )
      ) {
        disabledForConfigVersion = null
      }

      if (config.mode === 'do-primary') {
        if (config.configVersion === disabledForConfigVersion) {
          // The room refused this exact config, and the TTL above has not
          // elapsed yet. Stay on polling — which still delivers every
          // committed event — rather than retrying a socket the server has
          // already said it will not serve.
          options.onStatusChange?.('DO_SUPPRESSED:room_disabled')
          requestRecoveryPoll()
        } else if (
          previousMode !== config.mode
          || previousUrl !== config.webSocketUrl
          || !socket
        ) {
          connectWebSocket()
        }
      } else {
        closeSocket()
        if (previousMode === 'do-primary') {
          requestRecoveryPoll()
        }
      }

      // A new client can outlive an app-Worker rollback. Older config routes
      // legitimately omit overlayVersion, while their `/events` response still
      // carries it. Probe once on the present->absent capability transition;
      // steady modern deployments use the ten-minute history reconciliation.
      if (needsLegacyVersionProbe && socketIsHealthy()) {
        requestRecoveryPoll(true)
      }
    } catch {
      if (preserveCurrentOnFailure && currentConfig !== null && socketIsHealthy()) {
        // This was a DB-outage side probe, not evidence that the last validated
        // config became invalid. Keep the heartbeating transport alive and let
        // the bounded degraded retry try again; falling back here would discard
        // the only working delivery path while both HTTP endpoints are impaired.
        options.onStatusChange?.('CONFIG_REFRESH_FAILED:KEEP_CURRENT')
        return
      }
      const wasDoPrimary = currentConfig?.mode === 'do-primary'
      currentConfig = {
        schemaVersion: 1,
        mode: 'polling-only',
        protocolVersion: 1,
        retryPolicy: { baseDelayMs: 500, maxDelayMs: 30_000 },
        configVersion: 'safe-fallback',
      }
      closeSocket()
      if (wasDoPrimary) {
        requestRecoveryPoll()
      }
      options.onStatusChange?.('CONFIG_FALLBACK:POLLING_ONLY')
    } finally {
      configRefreshInFlight = false
      if (!disposed) {
        // A room refusal needs the five-minute recovery bound from #844. Once
        // suppression clears, return to the lower-frequency reconciliation
        // cadence instead of coupling these two operational controls again.
        const nextRefreshMs = disabledForConfigVersion === null
          ? CONNECTED_RECONCILIATION_MS
          : DO_SUPPRESSION_TTL_MS
        scheduleSafetyRefresh(nextRefreshMs)
      }
    }
  }

  function maybeRefreshConfigAfterHistoryFailure(): void {
    if (
      disposed
      || !socketIsHealthy()
      || configRefreshInFlight
      || Date.now() - lastConfigAttemptAt < HISTORY_FAILURE_CONFIG_REFETCH_FLOOR_MS
    ) return
    // Do not await inside the history retry owner. Config has its own in-flight
    // guard and timer ownership, while pollInFlight continues to serialize all
    // DB reads. Starting the probe here lets endpoint rotation proceed without
    // delaying the existing bounded history backoff.
    void refreshConfig(undefined, true)
  }

  /**
   * Apply a config change that history polling reported.
   *
   * The events endpoint echoes the effective config version on every pass a
   * polling-only or disconnected overlay already makes. A healthy DO socket
   * also performs one reconciliation pass every ten minutes, while its room
   * notice handles an urgent disable without waiting for that cadence.
   *
   * The floor keeps a config endpoint outage from turning every polling pass
   * into a refetch: the safe fallback version never matches the server's, so an
   * ungated comparison would loop.
   */
  const maybeRefreshConfigFor = (reportedVersion: unknown) => {
    if (
      disposed
      || !isBoundedConfigString(reportedVersion, MAX_CONFIG_VERSION_LENGTH)
    ) return
    if (reportedVersion === currentConfig?.configVersion) return
    if (Date.now() - lastConfigAttemptAt < CONFIG_CHANGE_REFETCH_FLOOR_MS) return
    void refreshConfig(reportedVersion)
  }

  if (typeof window === 'undefined') {
    Promise.resolve().then(() => {
      if (!disposed) {
        options.onError?.({
          type: 'connection',
          message: 'Overlay transport is available only in the browser',
          error: null,
          isExpected: true,
        })
      }
    })
  } else {
    // Claim cursor ownership before async config/WebSocket work. The page's
    // older loop remains only as a disconnected emergency fallback and cannot
    // duplicate events while this controller reports itself connected.
    options.onStatusChange?.('POLLING_ACTIVE')
    options.onSuccess?.()
    void poll()
    void refreshConfig()
  }

  return () => {
    disposed = true
    recoveryPollPending = false
    socketRecoveryActive = false
    bufferedSocketEvents = []
    unreconciledSocketEventIds.clear()
    if (pollTimer) clearTimeout(pollTimer)
    if (safetyTimer) clearTimeout(safetyTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (connectTimeout) clearTimeout(connectTimeout)
    if (livenessTimer) clearTimeout(livenessTimer)
    if (recoveryBufferTimer) clearTimeout(recoveryBufferTimer)
    for (const timer of demoRetryTimers.values()) clearTimeout(timer)
    demoRetryTimers.clear()
    demoRetryCounts.clear()
    pendingEventIds.clear()
    closeSocket()
  }
}
