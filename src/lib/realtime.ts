/*
 * Overlay transport compatibility facade
 *
 * Durable Objects WebSocket is the low-latency primary when runtime config
 * enables it. PlanetScale-backed HTTP polling always runs as the durable gap
 * recovery path, so a DO outage or a stale OBS browser source cannot lose a
 * committed gacha result. No Supabase URL, key, SDK, or channel is used here.
 */

import {
  OVERLAY_REALTIME_HEARTBEAT_MS,
  OVERLAY_REALTIME_PROTOCOL_VERSION,
  OVERLAY_REALTIME_TRANSPORT_DISABLED,
  buildPollingRealtimeEvents,
  type GachaRealtimeEventV1,
  type OverlayRealtimeConfigV1,
  type OverlayRealtimeServerMessage,
  validateGachaRealtimeEvent,
} from '@/lib/overlay-realtime/contract'

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
  userTwitchUsername: string
  rewardId?: string | null
  /** Stable batch key used to suppress duplicate sound across recovery pages. */
  soundGroupId?: string
  /**
   * Last authoritative history timestamp included in this payload.
   * Demo events omit it and therefore never advance the business cursor.
   */
  historyCursor?: string
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

interface PollingCursor {
  redeemedAt: string
  historyId: string
}

interface PollingResponse {
  events?: PollingEvent[]
  realtimeEvents?: GachaRealtimeEventV1[]
  nextCursor?: PollingCursor | null
  demoEvent?: PollingEvent | null
  /**
   * Effective overlay transport version, echoed by the events endpoint so a
   * connected overlay notices a rollout/rollback without polling the config
   * endpoint on its own timer. Optional so an overlay served by an older
   * deployment keeps working unchanged.
   */
  realtimeConfigVersion?: string
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
}

const MAX_SEEN_EVENT_IDS = 512
const SEEN_EVENT_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Safety net only. Rollout/rollback is normally noticed through the
 * `realtimeConfigVersion` echoed by the events endpoint on a request the
 * overlay already makes, so this timer exists purely for the case where
 * history polling itself is broken and can no longer carry the signal.
 */
const CONFIG_SAFETY_REFRESH_MS = 5 * 60_000
/**
 * Upper bound on how long DO reconnects stay suppressed after the room
 * reports itself disabled (see `disabledForConfigVersion` below).
 *
 * The suppression normally clears when the config endpoint returns a
 * different `configVersion`, but the app Worker's allowlist can be a
 * wildcard (`*`) that never changes per-streamer, in which case the operator
 * flipping the room-side allowlist back produces no new `configVersion` at
 * all — the client would otherwise stay on polling forever until reloaded
 * (issue #844). Reusing `CONFIG_SAFETY_REFRESH_MS` as the TTL means the
 * bounded retry piggybacks on the safety-net timer that already exists
 * instead of introducing a second one.
 *
 * This reuse is tighter than "share a number": the only thing that re-checks
 * the TTL is `refreshConfig()`, and while suppressed the only thing that
 * calls `refreshConfig()` on a timer is `configTimer`, armed for exactly
 * `CONFIG_SAFETY_REFRESH_MS` in its own `finally` block. Changing
 * SUPPRESSION_TTL_MS alone (e.g. to shorten it) would not shorten the actual
 * wait, because the next `refreshConfig()` call — the only place that reads
 * this constant — still would not happen until the unchanged safety timer
 * fires. Change both together, or give the suppression its own timer.
 */
const SUPPRESSION_TTL_MS = CONFIG_SAFETY_REFRESH_MS
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
const WS_CONNECT_TIMEOUT_MS = 10_000
/**
 * How long a healthy socket may stay silent before the client gives up on it.
 *
 * The room emits a heartbeat every `OVERLAY_REALTIME_HEARTBEAT_MS`, so missing
 * more than two in a row means the socket is half-open: alive to the browser
 * but delivering nothing. Two intervals of slack keeps a single delayed wake or
 * a brief network stall from churning connections.
 *
 * This replaces the fixed 30-second history poll. A connected overlay now makes
 * no periodic HTTP request at all; it reloads history only when it reconnects
 * or when a sequence gap proves it missed a delivery.
 */
const SOCKET_LIVENESS_TIMEOUT_MS = OVERLAY_REALTIME_HEARTBEAT_MS * 2.5

function eventUrl(
  streamerId: string,
  cursor: PollingCursor,
  demoCursor: PollingCursor
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
    for (const [eventId, firstSeenAt] of records) {
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

function validConfig(value: unknown): value is OverlayRealtimeConfigV1 {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<OverlayRealtimeConfigV1>
  return config.schemaVersion === 1
    && (config.mode === 'polling-only' || config.mode === 'do-primary')
    && config.protocolVersion === OVERLAY_REALTIME_PROTOCOL_VERSION
    && typeof config.retryPolicy?.baseDelayMs === 'number'
    && typeof config.retryPolicy?.maxDelayMs === 'number'
    && typeof config.configVersion === 'string'
    && (config.mode !== 'do-primary' || typeof config.webSocketUrl === 'string')
}

function websocketUrl(baseUrl: string, streamerId: string): string | null {
  try {
    const url = new URL(baseUrl)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
    url.pathname = `/v1/rooms/${encodeURIComponent(streamerId)}/connect`
    url.search = ''
    url.searchParams.set('clientVersion', 'overlay-v1')
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
  callback: (payload: GachaBroadcastPayload) => void,
  options: SubscribeOptions = {}
): () => void {
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY
  const intervalMs = options.retryDelay ?? 3_000
  const seenEventIds = loadSeenEvents(streamerId)
  let disposed = false
  let retryCount = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let configTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectTimeout: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let socketGeneration = 0
  let reconnectAttempt = 0
  let pollInFlight = false
  let currentConfig: OverlayRealtimeConfigV1 | null = null
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
   * different config, or after SUPPRESSION_TTL_MS regardless of config
   * version — see SUPPRESSION_TTL_MS for why the version alone is not enough.
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
   * SUPPRESSION_TTL_MS reconnects every ~15-30s indefinitely via the normal
   * exponential-backoff path in `scheduleReconnect` (this reoccurrence of the
   * loop ec6852f fixed was found in review, not in the preview test — the
   * preview run happened to have the room re-enabled before the gap showed).
   * After OPEN_FAILURE_SUPPRESSION_THRESHOLD straight open failures, treat it
   * like an explicit `transport_disabled` notice: fall back to the slower
   * TTL-gated retry instead of hammering an endpoint that keeps 503ing.
   */
  let consecutiveOpenFailures = 0
  let historyCursor: PollingCursor = {
    redeemedAt: new Date().toISOString(),
    historyId: '',
  }
  let demoCursor: PollingCursor = { ...historyCursor }

  const ingest = (event: GachaRealtimeEventV1, source: 'durable-object' | 'polling') => {
    const validation = validateGachaRealtimeEvent(event, streamerId)
    if (!validation.ok) {
      options.onStatusChange?.(`INVALID_EVENT:${source}`)
      return
    }

    const unseenDraws = event.draws.filter((draw) => rememberSeenId(seenEventIds, draw.eventId))
    if (unseenDraws.length === 0) {
      options.onStatusChange?.(`DUPLICATE_EVENT:${source}`)
      return
    }
    persistSeenEvents(streamerId, seenEventIds)
    callback({
      type: 'gacha',
      card: unseenDraws[0].card,
      ...(unseenDraws.length > 1 ? { cards: unseenDraws.map((draw) => draw.card) } : {}),
      userTwitchUsername: event.user.twitchUsername,
      rewardId: event.rewardId ?? null,
      soundGroupId: event.soundGroupId,
      historyCursor: event.occurredAt,
    })
  }

  const schedulePoll = (delay: number) => {
    if (disposed) return
    pollTimer = setTimeout(() => void poll(), delay)
  }

  const poll = async () => {
    if (disposed || pollInFlight) return
    pollInFlight = true
    options.onStatusChange?.('POLLING')
    try {
      // History recovery and the rare operator demo share one HTTP response.
      // Keeping separate cursors in that response preserves the critical rule
      // that a demo timestamp must never advance committed gacha history, while
      // avoiding one always-on Worker invocation per active OBS overlay.
      const historyResponse = await fetchJson<PollingResponse>(
        eventUrl(streamerId, historyCursor, demoCursor)
      )

      const rawEvents = historyResponse.events ?? []
      const envelopes = historyResponse.realtimeEvents?.length
        ? historyResponse.realtimeEvents
        : buildPollingRealtimeEvents(streamerId, rawEvents)
      for (const event of envelopes) ingest(event, 'polling')

      if (historyResponse.nextCursor) {
        historyCursor = historyResponse.nextCursor
      } else if (rawEvents.length > 0) {
        const last = rawEvents[rawEvents.length - 1]
        historyCursor = { redeemedAt: last.redeemedAt, historyId: last.id }
      }

      const demoEvent = historyResponse.demoEvent ?? null
      if (demoEvent) {
        demoCursor = { redeemedAt: demoEvent.redeemedAt, historyId: demoEvent.id }
        const demoId = demoEvent.eventId ?? `demo:${demoEvent.id}`
        if (rememberSeenId(seenEventIds, demoId)) {
          persistSeenEvents(streamerId, seenEventIds)
          callback({
            type: 'gacha',
            card: demoEvent.card,
            userTwitchUsername: demoEvent.userTwitchUsername,
            rewardId: demoEvent.rewardId ?? null,
          })
        }
      }

      retryCount = 0
      // A healthy socket schedules no further pass at all. History is reloaded
      // only on reconnect (onopen polls immediately), on a sequence gap, or if
      // the room stops proving liveness — so a connected overlay makes no
      // periodic HTTP request. A room outage restores normal polling through
      // onclose, which is also what the liveness deadline triggers.
      const socketHealthy =
        currentConfig?.mode === 'do-primary'
        && typeof WebSocket !== 'undefined'
        && socket?.readyState === WebSocket.OPEN
      if (!socketHealthy) schedulePoll(intervalMs)

      // Rollout/rollback detection rides on this response instead of a separate
      // config poll. refreshConfig() owns the socket and poll timers, so it is
      // started after the next pass is scheduled and is allowed to override it.
      maybeRefreshConfigFor(historyResponse.realtimeConfigVersion)
    } catch (error) {
      retryCount += 1
      const exhausted = Number.isFinite(maxRetries) && retryCount > maxRetries
      if (exhausted) {
        options.onError?.({
          type: 'connection',
          message: 'Overlay polling retry limit reached',
          error,
          isExpected: false,
        })
        return
      }
      options.onStatusChange?.(`POLLING_RETRY:${retryCount}`)
      schedulePoll(Math.min(intervalMs * 2 ** Math.max(0, retryCount - 1), 30_000))
    } finally {
      pollInFlight = false
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
      if (pollTimer) clearTimeout(pollTimer)
      schedulePoll(0)
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
    const target = websocketUrl(currentConfig.webSocketUrl ?? '', streamerId)
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
        // frame and this connection becoming active.
        if (pollTimer) clearTimeout(pollTimer)
        schedulePoll(0)
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
            options.onStatusChange?.(`DO_NOTICE:${parsed.code}`)
            if (parsed.code === TRANSPORT_DISABLED_NOTICE) {
              // The room itself reports that the operator disabled it. Remember
              // which config this applies to so a config endpoint that still
              // advertises `do-primary` cannot immediately reconnect us into the
              // room that just refused to serve.
              disabledForConfigVersion = currentConfig?.configVersion ?? null
              disabledAt = Date.now()
              closeSocket()
              if (pollTimer) clearTimeout(pollTimer)
              schedulePoll(0)
              // Authoritative signal, so it bypasses the version-mismatch floor
              // instead of waiting for the next history pass to notice.
              void refreshConfig()
            }
            return
          }
          if (parsed.type === 'gacha_result') {
            // A jump proves this socket missed a delivery. That is the only
            // reason a healthy connection reloads history now that the fixed
            // 30-second pass is gone; the database still decides what was
            // actually missed, this only decides *when* to ask.
            if (
              typeof parsed.seq === 'number'
              && lastSeq !== null
              && parsed.seq > lastSeq + 1
            ) {
              options.onStatusChange?.(`DO_SEQ_GAP:${lastSeq}->${parsed.seq}`)
              if (pollTimer) clearTimeout(pollTimer)
              schedulePoll(0)
            }
            if (typeof parsed.seq === 'number') lastSeq = parsed.seq
            ingest(parsed.event, 'durable-object')
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
        if (pollTimer) clearTimeout(pollTimer)
        schedulePoll(0)
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
        // path): re-arms the safety timer for SUPPRESSION_TTL_MS from now
        // instead of leaving it on whatever schedule the last config fetch
        // happened to set.
        void refreshConfig()
      }
    } catch {
      options.onStatusChange?.('DO_CONSTRUCTOR_FAILED')
      scheduleReconnect()
    }
  }

  const refreshConfig = async (expectedVersion?: string) => {
    if (disposed || configRefreshInFlight) return
    configRefreshInFlight = true
    lastConfigAttemptAt = Date.now()
    // A change-triggered refetch must not race the safety-net timer into two
    // concurrent config states; the timer is always re-armed in `finally`.
    if (configTimer) clearTimeout(configTimer)
    try {
      const config = await fetchJson<unknown>(
        configUrl(streamerId, expectedVersion),
        'default'
      )
      if (!validConfig(config)) throw new Error('invalid config')
      const previousMode = currentConfig?.mode
      const previousUrl = currentConfig?.webSocketUrl
      currentConfig = config
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
      // per-streamer, so also expire the suppression after SUPPRESSION_TTL_MS
      // regardless of config version — otherwise an operator flipping the
      // room-side allowlist back produces no signal this client can see
      // (issue #844) and it would stay on polling until reloaded.
      if (
        disabledForConfigVersion !== null
        && (
          config.configVersion !== disabledForConfigVersion
          || Date.now() - disabledAt >= SUPPRESSION_TTL_MS
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
          if (pollTimer) clearTimeout(pollTimer)
          schedulePoll(0)
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
          if (pollTimer) clearTimeout(pollTimer)
          schedulePoll(0)
        }
      }
    } catch {
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
        if (pollTimer) clearTimeout(pollTimer)
        schedulePoll(0)
      }
      options.onStatusChange?.('CONFIG_FALLBACK:POLLING_ONLY')
    } finally {
      configRefreshInFlight = false
      if (!disposed) {
        configTimer = setTimeout(
          () => void refreshConfig(),
          CONFIG_SAFETY_REFRESH_MS
        )
      }
    }
  }

  /**
   * Apply a config change that history polling reported.
   *
   * The events endpoint echoes the effective config version on every pass the
   * overlay already makes, so an operator flipping the allowlist is noticed
   * without a dedicated 30-second config poll per overlay. Detection is
   * therefore faster in polling-only mode (~3s) and unchanged while
   * DO-connected (~30s), while removing roughly half of all overlay requests.
   *
   * The floor keeps a config endpoint outage from turning every polling pass
   * into a refetch: the safe fallback version never matches the server's, so an
   * ungated comparison would loop.
   */
  const maybeRefreshConfigFor = (reportedVersion: string | undefined) => {
    if (disposed || !reportedVersion) return
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
    // older loop becomes version-check-only and cannot duplicate events.
    options.onStatusChange?.('POLLING_ACTIVE')
    options.onSuccess?.()
    void poll()
    void refreshConfig()
  }

  return () => {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
    if (configTimer) clearTimeout(configTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (connectTimeout) clearTimeout(connectTimeout)
    if (livenessTimer) clearTimeout(livenessTimer)
    closeSocket()
  }
}
