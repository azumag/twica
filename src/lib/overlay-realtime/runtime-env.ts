import 'server-only'

import { logger } from '@/lib/logger.server'

/**
 * Shared runtime environment resolution for every caller that talks to the
 * overlay-realtime Worker (#1114).
 *
 * Extracted from publisher.ts so the presence reader inherits the exact same
 * fail-closed invariants instead of drifting into a second implementation:
 *
 * 1. OpenNext exposes Cloudflare variables/secrets through
 *    `getCloudflareContext().env`, which can be rotated independently of a
 *    Next.js build. Reading bindings first avoids acting on values baked into
 *    an older server bundle.
 * 2. Bindings are treated as ONE atomic configuration snapshot. Falling back
 *    key-by-key could combine a rotated runtime secret with a stale build-time
 *    URL, or silently bypass polling-only mode after a binding removal.
 * 3. When the Workers request context itself is unavailable in production,
 *    the resolver fails CLOSED (all fields undefined, no process.env access):
 *    the polling transport remains authoritative, so skipping is safer than
 *    sending or reading with possibly stale credentials. Non-production
 *    contexts (`next dev`, Vitest) have no OpenNext context by design and fall
 *    back to process-local environment values.
 */
export interface OverlayRealtimeRuntimeEnvironment {
  runtime: 'workers' | 'local'
  mode: string | undefined
  streamerAllowlist: string | undefined
  publishUrl: string | undefined
  publishSecret: string | undefined
  /**
   * Service binding to the overlay-realtime Worker. Cloudflare rejects global
   * fetch() between Workers of one zone, so deployed callers MUST route
   * through this binding; global fetch remains only for dev/Vitest.
   */
  service: { fetch(request: Request): Promise<Response> } | undefined
}

function stringBinding(
  env: Record<string, unknown>,
  key: keyof NodeJS.ProcessEnv
): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function serviceBinding(
  env: Record<string, unknown>
): OverlayRealtimeRuntimeEnvironment['service'] {
  const value = env.OVERLAY_REALTIME_SERVICE
  return (
    typeof value === 'object'
    && value !== null
    && 'fetch' in value
    && typeof value.fetch === 'function'
  )
      ? value as OverlayRealtimeRuntimeEnvironment['service']
      : undefined
}

export async function resolveOverlayRealtimeEnvironment(): Promise<OverlayRealtimeRuntimeEnvironment> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    const runtimeEnv = env as unknown as Record<string, unknown>
    return {
      runtime: 'workers',
      mode: stringBinding(runtimeEnv, 'OVERLAY_REALTIME_MODE'),
      streamerAllowlist: stringBinding(
        runtimeEnv,
        'OVERLAY_REALTIME_STREAMER_ALLOWLIST'
      ),
      publishUrl: stringBinding(runtimeEnv, 'OVERLAY_REALTIME_PUBLISH_URL'),
      publishSecret: stringBinding(
        runtimeEnv,
        'OVERLAY_REALTIME_PUBLISH_SECRET'
      ),
      service: serviceBinding(runtimeEnv),
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      // Production must fail closed when the Workers request context is
      // unavailable. Callers treat a missing URL/secret/service as "skip";
      // process.env is deliberately NOT consulted because it may retain
      // stale build-time values pointing at another environment.
      logger.warn('[overlay-realtime] runtime context unavailable', {
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      return {
        runtime: 'workers',
        mode: undefined,
        streamerAllowlist: undefined,
        publishUrl: undefined,
        publishSecret: undefined,
        service: undefined,
      }
    }

    // `next dev` and Vitest have no OpenNext request context. Their
    // environment is process-local and cannot cross the preview/production
    // Workers boundary.
    return {
      runtime: 'local',
      mode: process.env.OVERLAY_REALTIME_MODE,
      streamerAllowlist: process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      publishUrl: process.env.OVERLAY_REALTIME_PUBLISH_URL,
      publishSecret: process.env.OVERLAY_REALTIME_PUBLISH_SECRET,
      service: undefined,
    }
  }
}

/**
 * Build an internal endpoint URL from the configured base, rejecting plain
 * HTTP in production. Shared by publisher and presence reader so the safety
 * conditions (protocol check, query/hash strip) cannot drift apart
 * (auto-review optional finding).
 */
export function resolveRealtimeUrl(
  base: string | undefined,
  pathname: string
): URL | null {
  if (!base) return null
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      return null
    }
    url.pathname = pathname
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}
