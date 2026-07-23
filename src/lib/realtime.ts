/*
 * Overlay transport compatibility facade
 *
 * Supabase Realtime used to be the primary overlay transport. The overlay now
 * consumes authoritative gacha_history rows through PlanetScale-backed HTTP
 * polling. Keeping these exported shapes avoids a flag-day rewrite of the OBS
 * page while removing every Supabase URL/key/WebSocket dependency from the
 * browser bundle and gacha write path.
 */

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
  /**
   * Last authoritative history timestamp included in this payload.
   *
   * The overlay page copies only this value into its emergency fallback
   * cursor. Using callback wall-clock time can skip a redemption committed
   * between the primary query and callback execution. Demo events omit the
   * field because they must never advance the business-history cursor.
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

/**
 * Compatibility no-op for server callers.
 *
 * The gacha result has already been committed to PlanetScale before this is
 * called, and the overlay polling endpoint reads that authoritative row. OBS
 * demos, which intentionally have no history row, use demo-event-store.
 */
export async function broadcastGachaResult(
  _streamerId: string,
  _payload: GachaBroadcastPayload,
  _options: { maxRetries?: number; retryDelay?: number } = {}
): Promise<void> {
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

function eventUrl(streamerId: string, since: string, demo: boolean): string {
  const suffix = demo ? 'demo-events' : 'events'
  const url = new URL(`/api/overlay/${streamerId}/${suffix}`, window.location.origin)
  url.searchParams.set('since', since)
  url.searchParams.set('_', String(Date.now()))
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
    xhr.timeout = 10000
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
 *
 * XHR is attempted only when fetch itself rejects (a network/runtime failure).
 * Retrying an HTTP 4xx/5xx or malformed JSON through XHR would duplicate the
 * request, consume the public rate-limit twice, and hide the original server
 * response without improving compatibility.
 */
async function fetchJson<T>(url: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch (fetchError) {
    return fetchJsonWithXhr<T>(url, fetchError)
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function eventGroupId(event: PollingEvent): string {
  return event.eventId?.replace(/:\d+$/, '') ?? event.id
}

/**
 * Emit history rows as the same multi-draw batch shape formerly broadcast by
 * Realtime. This preserves the overlay's “one sound per N-draw” behaviour.
 */
function emitHistoryBatches(
  events: PollingEvent[],
  callback: (payload: GachaBroadcastPayload) => void
): void {
  const groups = new Map<string, PollingEvent[]>()
  for (const event of events) {
    const id = eventGroupId(event)
    const group = groups.get(id)
    if (group) group.push(event)
    else groups.set(id, [event])
  }

  for (const group of groups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    callback({
      type: 'gacha',
      card: first.card,
      ...(group.length > 1 ? { cards: group.map((event) => event.card) } : {}),
      userTwitchUsername: first.userTwitchUsername,
      rewardId: first.rewardId ?? null,
      historyCursor: last.redeemedAt,
    })
  }
}

const MAX_SEEN_EVENT_IDS = 512

/**
 * Keep duplicate protection bounded for multi-hour OBS sessions. The cursor
 * excludes old events from future responses, so retaining the newest IDs is
 * enough to cover retries and eventual-consistency overlap without an
 * ever-growing Set.
 */
function rememberSeenId(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > MAX_SEEN_EVENT_IDS) {
    const oldest = seen.values().next().value as string | undefined
    if (oldest) seen.delete(oldest)
  }
  return true
}

/**
 * Subscribe to overlay events through HTTP polling.
 *
 * The function name is retained for compatibility with the OBS page. This loop
 * announces itself active immediately, disabling the older fallback loop before
 * both can own different cursors. Transient failures are retried internally and
 * only an explicitly finite retry limit hands control back through onError.
 */
export function subscribeToGachaResults(
  streamerId: string,
  callback: (payload: GachaBroadcastPayload) => void,
  options: SubscribeOptions = {}
): () => void {
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY
  const intervalMs = options.retryDelay ?? 3000
  let disposed = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0
  let cursor = new Date().toISOString()
  let demoCursor = cursor
  const seenHistoryIds = new Set<string>()
  const seenDemoIds = new Set<string>()

  const schedule = (delay: number) => {
    if (disposed) return
    timeout = setTimeout(() => {
      void poll()
    }, delay)
  }

  const poll = async () => {
    if (disposed) return
    options.onStatusChange?.('POLLING')

    try {
      // Business events and demo events deliberately use separate cursors. A
      // current-time demo must never advance past a concurrent DB redemption.
      const [historyResponse, demoResponse] = await Promise.all([
        fetchJson<{ events?: PollingEvent[] }>(eventUrl(streamerId, cursor, false)),
        fetchJson<{ event?: PollingEvent | null }>(eventUrl(streamerId, demoCursor, true))
          .catch(() => ({ event: null })),
      ])

      const newHistoryEvents: PollingEvent[] = []
      for (const event of historyResponse.events ?? []) {
        const eventMs = Date.parse(event.redeemedAt)
        cursor = Number.isFinite(eventMs)
          ? new Date(eventMs).toISOString()
          : event.redeemedAt
        if (!rememberSeenId(seenHistoryIds, event.id)) continue
        newHistoryEvents.push(event)
      }
      emitHistoryBatches(newHistoryEvents, callback)

      const demoEvent = demoResponse.event ?? null
      if (demoEvent) {
        const eventMs = Date.parse(demoEvent.redeemedAt)
        demoCursor = Number.isFinite(eventMs)
          ? new Date(eventMs).toISOString()
          : demoEvent.redeemedAt
        if (rememberSeenId(seenDemoIds, demoEvent.id)) {
          callback({
            type: 'gacha',
            card: demoEvent.card,
            userTwitchUsername: demoEvent.userTwitchUsername,
            rewardId: demoEvent.rewardId ?? null,
          })
        }
      }

      retryCount = 0
      schedule(intervalMs)
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
      const backoff = Math.min(intervalMs * Math.pow(2, Math.max(0, retryCount - 1)), 30000)
      schedule(backoff)
    }
  }

  if (typeof window === 'undefined') {
    Promise.resolve().then(() => {
      if (!disposed) {
        options.onError?.({
          type: 'connection',
          message: 'Overlay polling is available only in the browser',
          error: null,
          isExpected: true,
        })
      }
    })
  } else {
    // Mark the polling transport as the active owner before the first request.
    // The existing overlay fallback watches this callback and immediately
    // becomes version-check-only, eliminating a duplicate-fetch window.
    options.onStatusChange?.('POLLING_ACTIVE')
    options.onSuccess?.()
    void poll()
  }

  return () => {
    disposed = true
    if (timeout) clearTimeout(timeout)
  }
}
