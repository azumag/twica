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

/** OBS browser sources can run an older Chromium where fetch is less reliable. */
function fetchJson<T>(url: string): Promise<T> {
  return fetch(url, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<T>
    })
    .catch((fetchError) => {
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
    })
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
    callback({
      type: 'gacha',
      card: first.card,
      ...(group.length > 1 ? { cards: group.map((event) => event.card) } : {}),
      userTwitchUsername: first.userTwitchUsername,
      rewardId: first.rewardId ?? null,
    })
  }
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
        if (seenHistoryIds.has(event.id)) continue
        seenHistoryIds.add(event.id)
        newHistoryEvents.push(event)
      }
      emitHistoryBatches(newHistoryEvents, callback)

      const demoEvent = demoResponse.event ?? null
      if (demoEvent) {
        const eventMs = Date.parse(demoEvent.redeemedAt)
        demoCursor = Number.isFinite(eventMs)
          ? new Date(eventMs).toISOString()
          : demoEvent.redeemedAt
        if (!seenDemoIds.has(demoEvent.id)) {
          seenDemoIds.add(demoEvent.id)
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
