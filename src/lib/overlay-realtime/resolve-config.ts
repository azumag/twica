import {
  OVERLAY_REALTIME_PROTOCOL_VERSION,
  OVERLAY_REALTIME_SCHEMA_VERSION,
  type OverlayRealtimeConfigV1,
  isOverlayRealtimeStreamerEnabled,
} from '@/lib/overlay-realtime/contract'

type ResolvedOverlayRealtimePublicConfig = Omit<
  OverlayRealtimeConfigV1,
  'configVersion' | 'overlayVersion'
>

const OVERLAY_REALTIME_RETRY_POLICY = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
} as const

// Constructor form keeps this runtime-supported 64-bit arithmetic compatible
// with the repository's pre-ES2020 TypeScript emit target, which rejects only
// BigInt literal syntax (`123n`) rather than the platform BigInt API.
const FNV1A_64_OFFSET_BASIS = BigInt('0xcbf29ce484222325')
const FNV1A_64_PRIME = BigInt('0x100000001b3')
const UTF8_ENCODER = new TextEncoder()

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
 * Resolve every public field owned by this module before deriving its version.
 *
 * Keeping the effective mode, normalized URL, protocol, and retry policy in one
 * value prevents the events signal from hashing one interpretation of the env
 * while the config route returns another. `overlayVersion` remains outside
 * this value because it already has its own build-change signal on both routes.
 */
function resolveOverlayRealtimePublicConfig(
  streamerId: string
): ResolvedOverlayRealtimePublicConfig {
  const baseUrl = websocketBaseUrl()
  const doEnabled =
    isOverlayRealtimeStreamerEnabled(
      process.env.OVERLAY_REALTIME_MODE,
      process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      streamerId
    ) && baseUrl !== null

  return {
    schemaVersion: OVERLAY_REALTIME_SCHEMA_VERSION,
    mode: doEnabled ? 'do-primary' : 'polling-only',
    ...(doEnabled ? { webSocketUrl: baseUrl } : {}),
    protocolVersion: OVERLAY_REALTIME_PROTOCOL_VERSION,
    retryPolicy: { ...OVERLAY_REALTIME_RETRY_POLICY },
  }
}

/**
 * Canonical input for the public-config generation token.
 *
 * A fixed-position JSON tuple gives the current public fields one unambiguous,
 * deterministic representation without depending on object property insertion
 * order. JSON string escaping also prevents variable-length URL contents from
 * creating delimiter ambiguity. Any future public field owned by this resolver
 * must be added here so its semantic change also advances `configVersion`.
 */
function serializeOverlayRealtimePublicConfig(
  config: ResolvedOverlayRealtimePublicConfig
): string {
  return JSON.stringify([
    config.schemaVersion,
    config.mode,
    config.webSocketUrl ?? null,
    config.protocolVersion,
    config.retryPolicy.baseDelayMs,
    config.retryPolicy.maxDelayMs,
  ])
}

/**
 * Compact, synchronous fingerprint for change detection only.
 *
 * FNV-1a is intentionally non-cryptographic: this token grants no authority,
 * hides no data, and is never used to authenticate config. A 64-bit output can
 * collide, but for two independently dispersed config states that chance is
 * about 1 in 2^64 (with birthday risk becoming material around 2^32 distinct
 * states), far beyond the number of operator config revisions expected here.
 * The 16-character hexadecimal digest keeps the longest emitted token at 32
 * characters (`polling-only-v2-` plus the digest), safely below the client's
 * 128-character bound without putting the normalized URL itself in the token.
 */
function fingerprintPublicConfig(value: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (const octet of UTF8_ENCODER.encode(value)) {
    hash ^= BigInt(octet)
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME)
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Preserve the deployed polling-only token for its unchanged public config.
 *
 * Polling-only clients have no WebSocket URL, so URL/env churn that remains
 * ineffective must not create false config changes. If schema, protocol, or
 * retry semantics change later, this exact baseline no longer matches and the
 * fingerprinted generation below will correctly advance the signal.
 */
function isLegacyPollingOnlyConfig(
  config: ResolvedOverlayRealtimePublicConfig
): boolean {
  return config.schemaVersion === 1
    && config.mode === 'polling-only'
    && config.webSocketUrl === undefined
    && config.protocolVersion === 1
    && config.retryPolicy.baseDelayMs === 500
    && config.retryPolicy.maxDelayMs === 30_000
}

function configVersionFor(
  config: ResolvedOverlayRealtimePublicConfig
): string {
  if (isLegacyPollingOnlyConfig(config)) return 'polling-only-v1'
  const fingerprint = fingerprintPublicConfig(
    serializeOverlayRealtimePublicConfig(config)
  )
  return `${config.mode}-v2-${fingerprint}`
}

/**
 * Resolve whether Durable Objects are the primary transport for this streamer.
 *
 * A missing/invalid `OVERLAY_REALTIME_WS_URL` degrades to polling even when the
 * allowlist enables the streamer, because telling a client `do-primary` without
 * a reachable socket URL would strand it on the slow reconnect path.
 */
export function resolveOverlayRealtimeEnabled(streamerId: string): boolean {
  return resolveOverlayRealtimePublicConfig(streamerId).mode === 'do-primary'
}

/**
 * Public config version for a streamer.
 *
 * This is the value the events endpoint echoes so polling-only/disconnected
 * overlays notice a transport rollout without a second request. Connected
 * overlays use the room notice plus the infrequent history reconciliation.
 * The value is derived from the same predicate as the full config and contains
 * no secret material.
 */
export function resolveOverlayRealtimeConfigVersion(streamerId: string): string {
  return configVersionFor(resolveOverlayRealtimePublicConfig(streamerId))
}

/** Full public runtime configuration for an OBS browser source. */
export function resolveOverlayRealtimeConfig(
  streamerId: string
): OverlayRealtimeConfigV1 {
  const config = resolveOverlayRealtimePublicConfig(streamerId)

  return {
    ...config,
    // Changes with the effective public config and is deliberately free of
    // secret material. Clients use it for rollout/rollback detection.
    configVersion: configVersionFor(config),
  }
}
