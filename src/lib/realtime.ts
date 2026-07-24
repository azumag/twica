/*
 * Overlay transport compatibility facade
 *
 * Durable Objects WebSocket is the low-latency primary when runtime config
 * enables it. PlanetScale-backed HTTP polling always runs as the durable gap
 * recovery path, so a DO outage or a stale OBS browser source cannot lose a
 * committed gacha result. No Supabase URL, key, SDK, or channel is used here.
 */

import {
  OVERLAY_REALTIME_PROTOCOL_VERSION,
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
const CONFIG_REFRESH_MS = 30_000
const WS_CONNECT_TIMEOUT_MS = 10_000
const CONNECTED_GAP_RECOVERY_MS = 30_000

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

function configUrl(streamerId: string): string {
  // The endpoint has a 15-second public cache TTL. Do not append the
  // millisecond cache-buster used by history polling: doing so would create an
  // unbounded set of edge cache keys and defeat inexpensive rollout config.
  return new URL(
    `/api/overlay/${streamerId}/realtime-config`,
    window.location.origin
  ).toString()
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
      // Once the low-latency socket is healthy, polling becomes a periodic
      // reconciliation pass instead of a competing 3-second primary. A room
      // outage immediately restores the normal interval through onclose, and
      // reconnect always triggers an immediate pass before slowing down again.
      const nextInterval =
        currentConfig?.mode === 'do-primary'
        && typeof WebSocket !== 'undefined'
        && socket?.readyState === WebSocket.OPEN
          ? Math.max(intervalMs, CONNECTED_GAP_RECOVERY_MS)
          : intervalMs
      schedulePoll(nextInterval)
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

  const closeSocket = () => {
    socketGeneration += 1
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
        reconnectAttempt = 0
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
          if (parsed.type === 'gacha_result') ingest(parsed.event, 'durable-object')
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
        if (![1002, 1003, 1008, 1009].includes(event.code)) scheduleReconnect()
      }
    } catch {
      options.onStatusChange?.('DO_CONSTRUCTOR_FAILED')
      scheduleReconnect()
    }
  }

  const refreshConfig = async () => {
    if (disposed) return
    try {
      const config = await fetchJson<unknown>(configUrl(streamerId), 'default')
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
      if (config.mode === 'do-primary') {
        if (previousMode !== config.mode || previousUrl !== config.webSocketUrl || !socket) {
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
      if (!disposed) configTimer = setTimeout(() => void refreshConfig(), CONFIG_REFRESH_MS)
    }
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
    closeSocket()
  }
}
