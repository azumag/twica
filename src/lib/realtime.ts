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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

/**
 * Subscribe to overlay events through HTTP polling.
 *
 * The function name is retained for compatibility with the OBS page. A
 * successful first poll invokes onSuccess, so the page suppresses its older
 * duplicate fallback poll. If this loop fails, onError marks the page
 * disconnected and that fallback automatically resumes.
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
  let successNotified = false
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

  const emit = (event: PollingEvent) => {
    callback({
      type: 'gacha',
      card: event.card,
      userTwitchUsername: event.userTwitchUsername,
      rewardId: event.rewardId ?? null,
    })
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

      for (const event of historyResponse.events ?? []) {
        const eventMs = Date.parse(event.redeemedAt)
        cursor = Number.isFinite(eventMs)
          ? new Date(eventMs).toISOString()
          : event.redeemedAt
        if (seenHistoryIds.has(event.id)) continue
        seenHistoryIds.add(event.id)
        emit(event)
      }

      const demoEvent = demoResponse.event ?? null
      if (demoEvent) {
        const eventMs = Date.parse(demoEvent.redeemedAt)
        demoCursor = Number.isFinite(eventMs)
          ? new Date(eventMs).toISOString()
          : demoEvent.redeemedAt
        if (!seenDemoIds.has(demoEvent.id)) {
          seenDemoIds.add(demoEvent.id)
          emit(demoEvent)
        }
      }

      retryCount = 0
      if (!successNotified) {
        successNotified = true
        options.onStatusChange?.('POLLING_ACTIVE')
        options.onSuccess?.()
      }
      schedule(intervalMs)
    } catch (error) {
      retryCount += 1
      const exhausted = Number.isFinite(maxRetries) && retryCount > maxRetries
      options.onError?.({
        type: 'connection',
        message: exhausted
          ? 'Overlay polling retry limit reached'
          : 'Overlay polling temporarily unavailable',
        error,
        isExpected: !exhausted,
      })

      if (!exhausted) {
        const backoff = Math.min(intervalMs * Math.pow(2, Math.max(0, retryCount - 1)), 30000)
        schedule(backoff)
      }
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
    void poll()
  }

  return () => {
    disposed = true
    if (timeout) clearTimeout(timeout)
  }
}
