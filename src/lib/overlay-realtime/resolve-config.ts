import {
  OVERLAY_REALTIME_PROTOCOL_VERSION,
  type OverlayRealtimeConfigV1,
  isOverlayRealtimeStreamerEnabled,
} from '@/lib/overlay-realtime/contract'

/**
 * Single place where the app Worker decides a streamer's effective overlay
 * transport.
 *
 * Both `/api/overlay/[streamerId]/realtime-config` (which the OBS browser
 * source reads at startup) and `/api/overlay/[streamerId]/events` (which
 * carries the change signal on every poll) must answer with the exact same
 * effective config. If they were computed independently, a future change to the
 * allowlist format could make the events endpoint advertise a config version
 * that the config endpoint never returns, and clients would refetch forever.
 *
 * `contract.ts` deliberately owns the allowlist parsing itself so the
 * standalone Worker shares it; this module only adds the app-Worker-specific
 * pieces (env lookup and WebSocket base URL).
 */

function websocketBaseUrl(): string | null {
  const raw = process.env.OVERLAY_REALTIME_WS_URL
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return null
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Resolve whether Durable Objects are the primary transport for this streamer.
 *
 * A missing/invalid `OVERLAY_REALTIME_WS_URL` degrades to polling even when the
 * allowlist enables the streamer, because telling a client `do-primary` without
 * a reachable socket URL would strand it on the slow reconnect path.
 */
export function resolveOverlayRealtimeEnabled(streamerId: string): boolean {
  return (
    isOverlayRealtimeStreamerEnabled(
      process.env.OVERLAY_REALTIME_MODE,
      process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      streamerId
    ) && websocketBaseUrl() !== null
  )
}

/**
 * Public config version for a streamer.
 *
 * This is the value the events endpoint echoes so a connected overlay can
 * notice a rollout/rollback without polling the config endpoint on its own
 * timer. It is derived from the same predicate as the full config and contains
 * no secret material.
 */
export function resolveOverlayRealtimeConfigVersion(streamerId: string): string {
  return resolveOverlayRealtimeEnabled(streamerId)
    ? 'do-primary-v1'
    : 'polling-only-v1'
}

/** Full public runtime configuration for an OBS browser source. */
export function resolveOverlayRealtimeConfig(
  streamerId: string
): OverlayRealtimeConfigV1 {
  const baseUrl = websocketBaseUrl()
  const doEnabled =
    isOverlayRealtimeStreamerEnabled(
      process.env.OVERLAY_REALTIME_MODE,
      process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      streamerId
    ) && baseUrl !== null

  return {
    schemaVersion: 1,
    mode: doEnabled ? 'do-primary' : 'polling-only',
    ...(doEnabled ? { webSocketUrl: baseUrl } : {}),
    protocolVersion: OVERLAY_REALTIME_PROTOCOL_VERSION,
    retryPolicy: {
      baseDelayMs: 500,
      maxDelayMs: 30_000,
    },
    // Changes with the effective public config and is deliberately free of
    // secret material. Clients use it for rollout/rollback detection.
    configVersion: doEnabled ? 'do-primary-v1' : 'polling-only-v1',
  }
}
