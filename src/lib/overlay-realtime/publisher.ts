import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { gachaHistory } from '@/lib/db/schema'
import { logger } from '@/lib/logger.server'
import type { OverlayDemoEvent } from '@/lib/overlay/demo-event-store'
import {
  OVERLAY_REALTIME_SCHEMA_VERSION,
  type GachaRealtimeEventV1,
  type OverlayRealtimeCard,
  isOverlayRealtimeStreamerEnabled,
  normalizeOverlayRealtimeCard,
  validateGachaRealtimeEvent,
} from '@/lib/overlay-realtime/contract'
import { resolveOverlayRealtimeEnvironment } from '@/lib/overlay-realtime/runtime-env'
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

/**
 * Resolve private publisher configuration from the active Workers request.
 *
 * The fail-closed invariants (atomic binding snapshot, no process.env access
 * when the production context is unavailable) live in the shared resolver so
 * the #1114 presence reader cannot drift from them.
 */
async function getPublisherEnvironment(): Promise<OverlayRealtimePublisherEnvironment> {
  const resolved = await resolveOverlayRealtimeEnvironment()
  return {
    runtime: resolved.runtime,
    mode: resolved.mode,
    streamerAllowlist: resolved.streamerAllowlist,
    publishUrl: resolved.publishUrl,
    publishSecret: resolved.publishSecret,
    publishService: resolved.service,
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

function resolvePublisherTarget(
  streamerId: string,
  publisherEnv: OverlayRealtimePublisherEnvironment
): { secret: string; url: URL } | null {
  const secret = publisherEnv.publishSecret
  const url = resolvePublishUrl(streamerId, publisherEnv.publishUrl)
  if (
    !secret
    || !url
    || (publisherEnv.runtime === 'workers' && !publisherEnv.publishService)
  ) return null
  return { secret, url }
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
 * Send one already-validated public envelope through the authenticated room
 * publisher.
 *
 * Committed gacha and operator demos intentionally share this transport layer:
 * HMAC authentication, Service Binding routing, retry bounds, and response
 * cleanup must not drift between two public event kinds. Their durability
 * rules remain separate in the builders above/below this function — committed
 * rows fall back to PlanetScale, while demos fall back to the short-lived KV
 * latest-value record.
 */
async function publishValidatedEnvelope(
  streamerId: string,
  event: GachaRealtimeEventV1,
  publisherEnv: OverlayRealtimePublisherEnvironment,
  options: Pick<OverlayPublishOptions, 'maxRetries' | 'retryDelay'> = {}
): Promise<OverlayPublishResult> {
  const target = resolvePublisherTarget(streamerId, publisherEnv)
  if (!target) {
    logger.warn('[overlay-realtime] publisher configuration missing', { streamerId })
    return { outcome: 'skipped', attempts: 0, errorCode: 'configuration-missing' }
  }
  const { secret, url } = target

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
          // stale cross-environment endpoint diagnosable safely.
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

    // Bounded jitter prevents simultaneous EventSub or demo deliveries from
    // retrying the room endpoint in lockstep after a regional failure.
    const jitter = Math.floor(Math.random() * retryDelay)
    await new Promise((resolve) => setTimeout(resolve, retryDelay + jitter))
  }

  return { outcome: 'failed', attempts: maxAttempts, errorCode: 'unexpected' }
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
    // Keep the cheap fail-closed configuration gate ahead of the committed-row
    // identity lookup. A disabled or partially rolled-out publisher must not
    // add a PlanetScale query to every otherwise-successful redemption.
    if (!resolvePublisherTarget(streamerId, publisherEnv)) {
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

    return publishValidatedEnvelope(streamerId, event, publisherEnv, options)
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

/**
 * Immediately fan out an operator-triggered OBS demo through the same signed
 * Durable Object channel as committed gacha events.
 *
 * Demo events intentionally have no PlanetScale row. The route writes the
 * short-lived KV latest-value record first, then calls this function so an
 * already-connected overlay sees the demo immediately while polling-only or
 * briefly disconnected clients still have a bounded fallback. Reusing the
 * existing authenticated publisher avoids creating a second unauthenticated
 * ingress path merely for operational previews.
 */
export async function publishOverlayDemoRealtimeEvent(
  streamerId: string,
  demo: OverlayDemoEvent,
  options: Pick<OverlayPublishOptions, 'maxRetries' | 'retryDelay'> = {}
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
    const occurredAt = normalizeTimestamp(demo.redeemedAt)
    if (!occurredAt) {
      return { outcome: 'failed', attempts: 0, errorCode: 'invalid-demo-event' }
    }

    const event: GachaRealtimeEventV1 = {
      schemaVersion: OVERLAY_REALTIME_SCHEMA_VERSION,
      type: 'gacha_result',
      deliveryKind: 'demo',
      eventId: demo.eventId,
      batchId: demo.eventId,
      streamerId,
      occurredAt,
      user: { twitchUsername: demo.userTwitchUsername },
      draws: [{
        eventId: demo.eventId,
        drawId: demo.eventId,
        drawIndex: 0,
        // The KV demo identifier is deliberately reused as a transport-only
        // history identity. New clients recognize deliveryKind=demo and never
        // wait for this value in PlanetScale; older clients merely keep it in
        // their bounded reconciliation set only for the short mixed-version
        // rollout window, after which a reload or normal cache eviction drops
        // it without affecting committed history.
        historyId: demo.id,
        card: normalizeOverlayRealtimeCard(demo.card),
      }],
      rewardId: null,
      soundGroupId: demo.eventId,
    }
    if (!validateGachaRealtimeEvent(event, streamerId).ok) {
      return { outcome: 'failed', attempts: 0, errorCode: 'invalid-demo-event' }
    }

    return publishValidatedEnvelope(streamerId, event, publisherEnv, options)
  } catch (error) {
    // A failed immediate demo fanout must not invalidate the KV fallback or
    // turn the already-successful dashboard response into a server error.
    logger.warn('[overlay-realtime] unexpected demo publisher failure; KV will recover', {
      streamerId,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return { outcome: 'failed', attempts: 0, errorCode: 'unexpected' }
  }
}
