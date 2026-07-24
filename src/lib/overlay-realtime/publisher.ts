import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { gachaHistory } from '@/lib/db/schema'
import { logger } from '@/lib/logger.server'
import {
  OVERLAY_REALTIME_SCHEMA_VERSION,
  type GachaRealtimeEventV1,
  type OverlayRealtimeCard,
  isOverlayRealtimeStreamerEnabled,
  normalizeOverlayRealtimeCard,
  validateGachaRealtimeEvent,
} from '@/lib/overlay-realtime/contract'
import { createPublishSignature } from '@/lib/overlay-realtime/signature'

export interface OverlayPublishPayload {
  card: OverlayRealtimeCard
  cards?: OverlayRealtimeCard[]
  userTwitchUsername: string
  rewardId?: string | null
}

export interface OverlayPublishOptions {
  /** Stable EventSub message ID or generated manual-draw ID committed to DB. */
  batchId: string
  maxRetries?: number
  retryDelay?: number
}

export interface OverlayPublishResult {
  outcome: 'accepted' | 'skipped' | 'failed'
  attempts: number
  errorCode?: string
}

function drawEventId(batchId: string, index: number): string {
  return index === 0 ? batchId : `${batchId}:${index + 1}`
}

function normalizeTimestamp(value: string | Date | null): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

/**
 * Build the public envelope from rows returned by the committed transaction.
 *
 * The caller-supplied card payload controls presentation only; identity and
 * ordering always come back from gacha_history. If any expected row is absent,
 * the immediate publish is skipped and the authoritative polling fallback
 * recovers it. Guessing a history ID here would make cross-transport dedupe
 * impossible and is therefore less safe than a short delay.
 */
async function buildCommittedEnvelope(
  streamerId: string,
  payload: OverlayPublishPayload,
  batchId: string
): Promise<GachaRealtimeEventV1 | null> {
  const cards = (
    payload.cards?.length ? payload.cards : [payload.card]
  ).map(normalizeOverlayRealtimeCard)
  const expectedEventIds = cards.map((_, index) => drawEventId(batchId, index))
  const { db } = await getDb()
  const rows = await db
    .select({
      id: gachaHistory.id,
      eventId: gachaHistory.event_id,
      redeemedAt: gachaHistory.redeemed_at,
    })
    .from(gachaHistory)
    .where(
      and(
        eq(gachaHistory.streamer_id, streamerId),
        inArray(gachaHistory.event_id, expectedEventIds)
      )
    )

  const rowsByEventId = new Map(
    rows
      .filter((row): row is typeof row & { eventId: string } => typeof row.eventId === 'string')
      .map((row) => [row.eventId, row])
  )
  const orderedRows = expectedEventIds.map((eventId) => rowsByEventId.get(eventId))
  if (orderedRows.some((row) => !row)) return null

  const occurredAt = normalizeTimestamp(orderedRows[orderedRows.length - 1]?.redeemedAt ?? null)
  if (!occurredAt) return null

  const event: GachaRealtimeEventV1 = {
    schemaVersion: OVERLAY_REALTIME_SCHEMA_VERSION,
    type: 'gacha_result',
    eventId: expectedEventIds[0],
    batchId,
    streamerId,
    occurredAt,
    user: { twitchUsername: payload.userTwitchUsername },
    draws: expectedEventIds.map((eventId, drawIndex) => ({
      eventId,
      drawId: eventId,
      drawIndex,
      historyId: orderedRows[drawIndex]!.id,
      card: cards[drawIndex],
    })),
    rewardId: payload.rewardId ?? null,
    soundGroupId: batchId,
  }

  if (!validateGachaRealtimeEvent(event, streamerId).ok) return null
  return event
}

interface OverlayRealtimePublisherEnvironment {
  runtime: 'workers' | 'local'
  mode: string | undefined
  streamerAllowlist: string | undefined
  publishUrl: string | undefined
  publishSecret: string | undefined
  publishService: OverlayRealtimeServiceBinding | undefined
}

interface OverlayRealtimeServiceBinding {
  fetch(request: Request): Promise<Response>
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
): OverlayRealtimeServiceBinding | undefined {
  const value = env.OVERLAY_REALTIME_SERVICE
  return (
    typeof value === 'object'
    && value !== null
    && 'fetch' in value
    && typeof value.fetch === 'function'
  )
    ? value as OverlayRealtimeServiceBinding
    : undefined
}

/**
 * Resolve private publisher configuration from the active Workers request.
 *
 * OpenNext exposes Cloudflare runtime variables and secrets through
 * `getCloudflareContext().env`. Reading that binding first is important:
 * Workers secrets can be rotated independently of a Next.js build, whereas a
 * direct `process.env.NAME` reference may retain the value that existed while
 * the server bundle was produced. `process.env` remains the explicit fallback
 * for `next dev`, Vitest, and other non-Workers execution contexts.
 */
async function getPublisherEnvironment(): Promise<OverlayRealtimePublisherEnvironment> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    const runtimeEnv = env as unknown as Record<string, unknown>
    // Treat Workers bindings as one atomic configuration snapshot. Falling
    // back one key at a time could combine a rotated runtime secret with a
    // stale build-time URL, or bypass polling-only mode after a binding is
    // deliberately removed.
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
      publishService: serviceBinding(runtimeEnv),
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      // A production publish must fail closed when its Workers request context
      // is unavailable. The polling source remains authoritative, so skipping
      // is safer than sending with possibly stale build-time credentials.
      logger.warn('[overlay-realtime] runtime publisher context unavailable', {
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      return {
        runtime: 'workers',
        mode: undefined,
        streamerAllowlist: undefined,
        publishUrl: undefined,
        publishSecret: undefined,
        publishService: undefined,
      }
    }

    // `next dev` and Vitest have no OpenNext request context. Their environment
    // is process-local and cannot cross the preview/production Workers boundary.
    return {
      runtime: 'local',
      mode: process.env.OVERLAY_REALTIME_MODE,
      streamerAllowlist: process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      publishUrl: process.env.OVERLAY_REALTIME_PUBLISH_URL,
      publishSecret: process.env.OVERLAY_REALTIME_PUBLISH_SECRET,
      publishService: undefined,
    }
  }
}

function resolvePublishUrl(streamerId: string, base: string | undefined): URL | null {
  if (!base) return null
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') return null
    url.pathname = `/internal/v1/rooms/${encodeURIComponent(streamerId)}/publish`
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    // The publisher needs only the HTTP status. Canceling the unread stream is
    // Cloudflare's recommended cleanup and releases its remaining resources
    // without parsing or logging private response data.
    await response.body.cancel()
  } catch {
    // Transport cleanup is best-effort. A successfully classified publish
    // response must not be turned into a failed gacha notification because its
    // already-unused body stream was concurrently closed by the runtime.
  }
}

/**
 * Publish after the database transaction has committed.
 *
 * Failures never change the gacha result: PlanetScale polling is the durable
 * recovery source. Retries are bounded and cover only network/5xx failures;
 * schema/auth 4xx responses fail immediately so a bad deployment cannot create
 * an unbounded background workload.
 */
export async function publishCommittedGachaBatch(
  streamerId: string,
  payload: OverlayPublishPayload,
  options: OverlayPublishOptions
): Promise<OverlayPublishResult> {
  const publisherEnv = await getPublisherEnvironment()
  if (!isOverlayRealtimeStreamerEnabled(
    publisherEnv.mode,
    publisherEnv.streamerAllowlist,
    streamerId
  )) {
    return { outcome: 'skipped', attempts: 0, errorCode: 'mode-disabled' }
  }

  try {
    const secret = publisherEnv.publishSecret
    const url = resolvePublishUrl(streamerId, publisherEnv.publishUrl)
    if (
      !secret
      || !url
      || (publisherEnv.runtime === 'workers' && !publisherEnv.publishService)
    ) {
      logger.warn('[overlay-realtime] publisher configuration missing', { streamerId })
      return { outcome: 'skipped', attempts: 0, errorCode: 'configuration-missing' }
    }

    const event = await buildCommittedEnvelope(streamerId, payload, options.batchId)
    if (!event) {
      logger.warn('[overlay-realtime] committed identity unavailable; polling will recover', {
        streamerId,
        batchId: options.batchId,
      })
      return { outcome: 'skipped', attempts: 0, errorCode: 'identity-unavailable' }
    }

    const body = JSON.stringify(event)
    const maxAttempts = Math.max(1, Math.min((options.maxRetries ?? 1) + 1, 3))
    const retryDelay = Math.max(50, Math.min(options.retryDelay ?? 250, 1_000))

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timestamp = String(Date.now())
      const nonce = crypto.randomUUID()
      const signature = await createPublishSignature(
        secret,
        url.pathname,
        body,
        timestamp,
        nonce
      )
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1_500)

      try {
        const requestInit: RequestInit = {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            'x-twica-timestamp': timestamp,
            'x-twica-nonce': nonce,
            'x-twica-signature': signature,
          },
          signal: controller.signal,
        }
        // Cloudflare rejects global fetch() calls from one Worker to another
        // Worker on the same zone. The Service Binding is the supported,
        // zero-network-hop path in deployed Workers; global fetch remains only
        // for next dev and Vitest, where no Workers binding exists.
        const response = publisherEnv.publishService
          ? await publisherEnv.publishService.fetch(new Request(url, requestInit))
          : await fetch(url, requestInit)
        await discardResponseBody(response)
        if (response.ok) return { outcome: 'accepted', attempts: attempt }
        if (!retryableStatus(response.status) || attempt >= maxAttempts) {
          logger.warn('[overlay-realtime] publish rejected', {
            streamerId,
            // Origin/path are public routing metadata and contain no signature,
            // secret, or payload. Keeping them in the rejection log makes a
            // stale cross-environment endpoint diagnosable without weakening
            // the HMAC boundary or exposing viewer/card data.
            targetOrigin: url.origin,
            targetPath: url.pathname,
            status: response.status,
            attempt,
          })
          return { outcome: 'failed', attempts: attempt, errorCode: `http-${response.status}` }
        }
      } catch (error) {
        if (attempt >= maxAttempts) {
          logger.warn('[overlay-realtime] publish network failure', {
            streamerId,
            attempt,
            error: error instanceof Error ? error.name : 'unknown',
          })
          return { outcome: 'failed', attempts: attempt, errorCode: 'network' }
        }
      } finally {
        clearTimeout(timeout)
      }

      // Bounded jitter prevents simultaneous EventSub deliveries from retrying
      // the room endpoint in lockstep after a transient regional failure.
      const jitter = Math.floor(Math.random() * retryDelay)
      await new Promise((resolve) => setTimeout(resolve, retryDelay + jitter))
    }

    return { outcome: 'failed', attempts: maxAttempts, errorCode: 'unexpected' }
  } catch (error) {
    // Immediate delivery is an optimization after the authoritative database
    // commit. No configuration, WebCrypto, or identity re-read failure may
    // turn an already-successful draw into an API 500; the polling cursor will
    // recover the committed history row on its next pass.
    logger.warn('[overlay-realtime] unexpected publisher failure; polling will recover', {
      streamerId,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return { outcome: 'failed', attempts: 0, errorCode: 'unexpected' }
  }
}
