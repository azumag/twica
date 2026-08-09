import type { Card } from '@/types/database'

const KV_BINDING_NAME = 'RATE_LIMIT_KV'
const KEY_PREFIX = 'overlay:demo:'
// A healthy overlay performs a full HTTP reconciliation every 10 minutes, and
// realtime liveness detection plus bounded reconnect retries can consume a
// further 150 seconds before that fallback is consulted. Fifteen minutes is
// deliberately longer than that 750-second recovery window, leaving another
// 150 seconds for timer jitter and KV edge propagation, while still bounding
// storage to one latest-value record per streamer instead of retaining demos.
const DEMO_EVENT_TTL_SECONDS = 15 * 60

type OverlayDemoCard = Pick<
  Card,
  'id' | 'name' | 'description' | 'image_url' | 'image_padding_color' | 'rarity'
>

interface KVNamespaceLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  get(key: string): Promise<string | null>
}

export interface OverlayDemoEvent {
  readonly id: string
  readonly eventId: string
  readonly redeemedAt: string
  readonly userTwitchUsername: string
  readonly rewardId: null
  readonly card: Readonly<OverlayDemoCard>
}

interface MemoryRecord {
  event: OverlayDemoEvent
  expiresAt: number
}

// `next dev` and unit tests have no Workers binding. A process-local fallback
// keeps the OBS demo functional in those environments without introducing a
// second external service. Production uses the shared RATE_LIMIT_KV namespace.
const memoryEvents = new Map<string, MemoryRecord>()

function buildKey(streamerId: string): string {
  return `${KEY_PREFIX}${streamerId}`
}

function requireLocalFallback(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[overlay-demo] RATE_LIMIT_KV is required in production; refusing process-local delivery'
    )
  }
}

async function getKvBinding(): Promise<KVNamespaceLike | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    const binding = (env as unknown as Record<string, unknown>)[KV_BINDING_NAME]
    return (binding as KVNamespaceLike | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Freeze both levels of the transport value so KV serialization and realtime
 * fanout cannot observe different card fields if a caller accidentally mutates
 * its object after either asynchronous delivery has started.
 */
function freezeOverlayDemoEvent(event: OverlayDemoEvent): OverlayDemoEvent {
  return Object.freeze({
    ...event,
    card: Object.freeze({ ...event.card }),
  })
}

function parseEvent(value: string | null): OverlayDemoEvent | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<OverlayDemoEvent>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.eventId !== 'string' ||
      typeof parsed.redeemedAt !== 'string' ||
      typeof parsed.userTwitchUsername !== 'string' ||
      !parsed.card ||
      typeof parsed.card.id !== 'string' ||
      typeof parsed.card.name !== 'string' ||
      typeof parsed.card.rarity !== 'string'
    ) {
      return null
    }
    return freezeOverlayDemoEvent({
      id: parsed.id,
      eventId: parsed.eventId,
      redeemedAt: parsed.redeemedAt,
      userTwitchUsername: parsed.userTwitchUsername,
      rewardId: null,
      card: {
        id: parsed.card.id,
        name: parsed.card.name,
        description: parsed.card.description ?? null,
        image_url: parsed.card.image_url ?? null,
        image_padding_color: parsed.card.image_padding_color ?? null,
        rarity: parsed.card.rarity,
      },
    })
  } catch {
    return null
  }
}

/**
 * Create the single immutable value shared by fallback and realtime delivery.
 * Identity and timestamp are sampled exactly once so both transports can be
 * deduplicated and reconciled as representations of the same operator action.
 */
export function createOverlayDemoEvent(card: OverlayDemoCard): OverlayDemoEvent {
  const id = `demo:${crypto.randomUUID()}`
  return freezeOverlayDemoEvent({
    id,
    eventId: id,
    redeemedAt: new Date().toISOString(),
    userTwitchUsername: 'DemoUser',
    rewardId: null,
    card: {
      id: card.id,
      name: card.name,
      description: card.description,
      image_url: card.image_url,
      image_padding_color: card.image_padding_color ?? null,
      rarity: card.rarity,
    },
  })
}

/**
 * Store an already-created OBS demo as the streamer's bounded fallback.
 *
 * One latest-value key per streamer is intentional: OBS demo is an operator UI
 * action, not an auditable business event. It avoids unbounded key creation and
 * preserves all real gacha history exclusively in PostgreSQL. The existing
 * endpoint rate limit prevents abusive overwrite loops.
 */
export async function storeOverlayDemoEvent(
  streamerId: string,
  event: OverlayDemoEvent
): Promise<void> {
  const kv = await getKvBinding()
  if (kv) {
    await kv.put(buildKey(streamerId), JSON.stringify(event), {
      expirationTtl: DEMO_EVENT_TTL_SECONDS,
    })
  } else {
    // A process-local write is valid for next dev/tests only. In Workers it
    // would often be read by another isolate and make a successful demo request
    // disappear silently, so production fails visibly when the binding is lost.
    requireLocalFallback()
    memoryEvents.set(buildKey(streamerId), {
      event,
      expiresAt: Date.now() + DEMO_EVENT_TTL_SECONDS * 1000,
    })
  }
}

/**
 * Backward-compatible convenience API for callers that still expect creation
 * and fallback persistence to be one operation.
 */
export async function publishOverlayDemoEvent(
  streamerId: string,
  card: OverlayDemoCard
): Promise<OverlayDemoEvent> {
  const event = createOverlayDemoEvent(card)
  await storeOverlayDemoEvent(streamerId, event)
  return event
}

/** Return a demo only when it is newer than this overlay client's cursor. */
export async function getOverlayDemoEvent(
  streamerId: string,
  since: string
): Promise<OverlayDemoEvent | null> {
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) return null

  const key = buildKey(streamerId)
  const kv = await getKvBinding()
  let event: OverlayDemoEvent | null

  if (kv) {
    event = parseEvent(await kv.get(key))
  } else {
    requireLocalFallback()
    const record = memoryEvents.get(key)
    if (!record) return null
    if (record.expiresAt <= Date.now()) {
      memoryEvents.delete(key)
      return null
    }
    event = record.event
  }

  if (!event) return null
  const eventMs = Date.parse(event.redeemedAt)
  return Number.isFinite(eventMs) && eventMs > sinceMs ? event : null
}

/** Unit-test cleanup; not used by application code. */
export function __clearOverlayDemoEventsForTests(): void {
  memoryEvents.clear()
}
