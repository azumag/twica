/*
 * Overlay transport compatibility facade
 *
 * Supabase Realtime used to be the primary overlay transport. The overlay now
 * consumes authoritative gacha_history rows through the PlanetScale-backed
 * polling endpoint. Keeping the old WebSocket/HTTP broadcast client alive made
 * the browser bundle and every gacha write depend on a Supabase project that is
 * no longer authoritative.
 *
 * The exported shapes are retained temporarily so migrated call sites do not
 * need a flag-day rewrite. `broadcastGachaResult` is deliberately best-effort
 * no-op because the result has already been committed to PostgreSQL before it
 * is called, and `subscribeToGachaResults` immediately announces the expected
 * polling-only state. OBS demo events, which have no DB history row, use the
 * dedicated overlay demo-event store instead.
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

/**
 * Compatibility no-op for callers that already persisted the gacha result.
 * The overlay polling API will observe the same row within its normal interval.
 */
export async function broadcastGachaResult(
  _streamerId: string,
  _payload: GachaBroadcastPayload,
  _options: { maxRetries?: number; retryDelay?: number } = {}
): Promise<void> {
  return
}

export interface SubscribeOptions {
  maxRetries?: number
  retryDelay?: number
  onError?: (error: RealtimeError) => void
  onSuccess?: () => void
  onStatusChange?: (status: string) => void
}

/**
 * Compatibility subscription that activates the polling path immediately.
 * No Supabase SDK, URL, key, WebSocket, or network request is used.
 */
export function subscribeToGachaResults(
  _streamerId: string,
  _callback: (payload: GachaBroadcastPayload) => void,
  options: SubscribeOptions = {}
): () => void {
  let disposed = false

  // Defer callbacks so callers can finish assigning their cleanup/timer refs,
  // matching the asynchronous nature of the former subscription lifecycle.
  Promise.resolve().then(() => {
    if (disposed) return
    options.onStatusChange?.('POLLING_ONLY')
    options.onError?.({
      type: 'connection',
      message: 'Realtime transport retired; database polling is active',
      error: null,
      isExpected: true,
    })
  })

  return () => {
    disposed = true
  }
}
