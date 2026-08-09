import {
  MAX_REALTIME_EVENT_BYTES,
  OVERLAY_REALTIME_HEARTBEAT,
  OVERLAY_REALTIME_HEARTBEAT_MS,
  OVERLAY_REALTIME_TRANSPORT_DISABLED,
  isOverlayRealtimeStreamerEnabled,
  isValidStreamerId,
  validateGachaRealtimeEvent,
} from '../../../src/lib/overlay-realtime/contract'
import { verifyPublishSignature } from '../../../src/lib/overlay-realtime/signature'
import type {
  DurableObjectState as CloudflareDurableObjectState,
  WebSocket as CloudflareWebSocket,
} from '@cloudflare/workers-types'

/**
 * Only the binding operations used by this router are described here.
 *
 * The Worker is imported by browser-oriented Vitest files as well as compiled
 * with the dedicated Cloudflare tsconfig. Using the full namespace type at
 * this boundary would mix two incompatible Request/Response declaration sets
 * even though their runtime wire format is identical. Keeping the narrow
 * binding contract here preserves type checking for every operation we call
 * while the state and socket APIs below still use Cloudflare's official types.
 */
interface OverlayRoomNamespace {
  idFromName(name: string): unknown
  get(id: unknown): {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  }
}

interface Env {
  OVERLAY_ROOMS: OverlayRoomNamespace
  OVERLAY_REALTIME_PUBLISH_SECRET: string
  OVERLAY_REALTIME_MODE?: string
  OVERLAY_REALTIME_STREAMER_ALLOWLIST?: string
  MAX_ROOM_CONNECTIONS?: string
  MAX_ROOM_CONNECTS_PER_MINUTE?: string
  MAX_CLIENT_CONNECTS_PER_MINUTE?: string
  MAX_ROOM_PUBLISHES_PER_MINUTE?: string
}

interface SocketAttachment {
  connectionId: string
  connectedAt: number
  messageWindowStartedAt: number
  messageCount: number
}

const AUTH_WINDOW_MS = 60_000
const MAX_NONCE_RECORDS = 256
const NONCE_LEDGER_KEY = 'nonce-ledger'
const RATE_LIMIT_LEDGER_KEY = 'rate-limit-ledger'
const DELIVERY_LEDGER_KEY = 'delivery-ledger'
const MAX_DELIVERY_RECORDS = 512
const DELIVERY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024
const CLIENT_MESSAGES_PER_MINUTE = 30

/**
 * Room identity, needed only so the kill-switch alarm can re-evaluate the
 * allowlist. The Durable Object ID is derived from the streamer ID but is not
 * reversible, and `alarm()` receives no request to read it from.
 */
const ROOM_STREAMER_ID_KEY = 'room-streamer-id'
/**
 * How often a room with live sockets re-checks whether it is still allowed.
 *
 * The operator kill switch is a Worker secret change, which existing
 * hibernating sockets never observe on their own. Without this the client would
 * hold a socket open against a disabled room and simply stop seeing gacha —
 * exactly the user-visible failure #803 was about.
 *
 * One alarm per room per minute is far cheaper than the per-overlay config
 * polling it replaces: a room with several OBS browser sources costs one wake,
 * not one request per source.
 */
const KILL_SWITCH_CHECK_MS = OVERLAY_REALTIME_HEARTBEAT_MS
/**
 * Monotonic fanout counter for this room.
 *
 * Clients use gaps in it to decide when a healthy socket still needs to reload
 * history. It is deliberately per-room and not persisted anywhere else: it
 * identifies *deliveries*, while `eventId` identifies *events*, and only the
 * database is authoritative about the latter.
 */
const ROOM_SEQ_KEY = 'room-seq'

interface RoomRateLimitLedger {
  windowStartedAt: number
  connectCount: number
  publishCount: number
  clientConnectCounts: Record<string, number>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

function realtimeEnabled(env: Env, streamerId: string): boolean {
  return isOverlayRealtimeStreamerEnabled(
    env.OVERLAY_REALTIME_MODE,
    env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
    streamerId
  )
}

async function clientRateLimitBucket(request: Request): Promise<string> {
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
  // Store only a short-lived one-way bucket, never the client address. The
  // value exists for one minute in a streamer-scoped DO and is used solely to
  // stop one caller from consuming every OBS connection slot.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(address)
  )
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function roomPath(pathname: string, suffix: 'connect' | 'publish'): string | null {
  // Subscriptions are intentionally public, while publish is reachable only
  // through the internal path even when a caller happens to possess a valid
  // signature. Keeping the prefix tied to the operation avoids accidentally
  // expanding the public API surface when new room actions are added.
  const prefix = suffix === 'connect' ? '/v1' : '/internal/v1'
  const match = pathname.match(new RegExp(`^${prefix}/rooms/([^/]+)/${suffix}$`))
  if (!match) return null
  try {
    const streamerId = decodeURIComponent(match[1])
    return isValidStreamerId(streamerId) ? streamerId : null
  } catch {
    return null
  }
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REALTIME_EVENT_BYTES) return null
  if (!request.body) return ''

  // Content-Length is optional and cannot be trusted on its own. Reading the
  // stream incrementally bounds both memory use and work for chunked requests:
  // once byte 64 KiB + 1 arrives, cancel immediately instead of materializing
  // an attacker-controlled body with request.text().
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let byteLength = 0
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_REALTIME_EVENT_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // Cancellation is best-effort transport cleanup. A broken peer must
          // not turn an already-classified 413 into an internal server error.
        }
        return null
      }
      body += decoder.decode(value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function authenticatedPublishRequest(
  request: Request,
  env: Env,
  pathname: string,
  body: string
): Promise<{ ok: true; nonce: string; timestamp: number } | { ok: false }> {
  const timestampRaw = request.headers.get('x-twica-timestamp') ?? ''
  const nonce = request.headers.get('x-twica-nonce') ?? ''
  const signature = request.headers.get('x-twica-signature') ?? ''
  const timestamp = Number(timestampRaw)
  if (!env.OVERLAY_REALTIME_PUBLISH_SECRET) return { ok: false }
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > AUTH_WINDOW_MS) {
    return { ok: false }
  }
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) return { ok: false }
  const valid = await verifyPublishSignature(
    env.OVERLAY_REALTIME_PUBLISH_SECRET,
    pathname,
    body,
    timestampRaw,
    nonce,
    signature
  )
  return valid ? { ok: true, nonce, timestamp } : { ok: false }
}

/**
 * Public edge router.
 *
 * Subscribe is intentionally read-only and public, matching the existing OBS
 * URL model. Publish requires a short-lived HMAC and is forwarded to the room
 * only after authentication; clients can never reach the room's publish
 * operation through their WebSocket.
 */
const overlayRealtimeWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, protocolVersion: 1 })
    }

    const connectStreamerId = roomPath(url.pathname, 'connect')
    if (request.method === 'GET' && connectStreamerId) {
      if (!realtimeEnabled(env, connectStreamerId)) {
        return json({ error: 'Realtime transport disabled' }, 503)
      }
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'WebSocket upgrade required' }, 426)
      }
      const id = env.OVERLAY_ROOMS.idFromName(connectStreamerId)
      const roomUrl = new URL(request.url)
      roomUrl.pathname = `/room/connect/${connectStreamerId}`
      return env.OVERLAY_ROOMS.get(id).fetch(new Request(roomUrl, request))
    }

    const publishStreamerId = roomPath(url.pathname, 'publish')
    if (request.method === 'POST' && publishStreamerId) {
      if (!realtimeEnabled(env, publishStreamerId)) {
        return json({ error: 'Realtime transport disabled' }, 503)
      }
      const body = await readBoundedBody(request)
      if (body === null) return json({ error: 'Payload too large' }, 413)
      const auth = await authenticatedPublishRequest(request, env, url.pathname, body)
      if (!auth.ok) return json({ error: 'Unauthorized' }, 401)

      let event: unknown
      try {
        event = JSON.parse(body)
      } catch {
        return json({ error: 'Invalid JSON' }, 400)
      }
      const validation = validateGachaRealtimeEvent(event, publishStreamerId)
      if (!validation.ok) return json({ error: validation.error }, 400)

      const id = env.OVERLAY_ROOMS.idFromName(publishStreamerId)
      // Build one concrete Request before crossing the Durable Object binding.
      // Cloudflare accepts both fetch(url, init) and fetch(Request), but the
      // latter makes the exact method, internal pathname, headers, and body a
      // single immutable value. Keeping that boundary explicit removes
      // overload interpretation as a variable when diagnosing a runtime-only
      // room route miss.
      const roomRequest = new Request('https://room.internal/publish', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-internal-streamer-id': publishStreamerId,
          'x-internal-nonce': auth.nonce,
          'x-internal-timestamp': String(auth.timestamp),
        },
      })
      const roomResponse = await env.OVERLAY_ROOMS.get(id).fetch(roomRequest)
      if (!roomResponse.ok) {
        // Only non-secret routing metadata is logged. The signed request body,
        // nonce, username, and card fields remain excluded from observability.
        console.warn('[overlay-realtime] room publish rejected', {
          method: roomRequest.method,
          pathname: new URL(roomRequest.url).pathname,
          status: roomResponse.status,
        })
      }
      return roomResponse
    }

    return json({ error: 'Not found' }, 404)
  },
}

export default overlayRealtimeWorker

/**
 * One hibernatable room per streamer.
 *
 * Cards and usernames are never written to Durable Object storage. Storage is
 * limited to bounded nonce, rate-limit, and event-delivery ledgers so security
 * controls and idempotency survive hibernation. Socket metadata stays in the
 * runtime attachment (maximum 16 KiB, here under 200 bytes) and survives
 * hibernation without keeping the object billable while idle.
 */
export class OverlayRoom {
  private readonly state: CloudflareDurableObjectState
  private readonly env: Env
  constructor(state: CloudflareDurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  private async consumeRoomRateLimit(
    kind: 'connect' | 'publish',
    clientBucket?: string
  ): Promise<boolean> {
    const now = Date.now()
    return this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<RoomRateLimitLedger>(
        RATE_LIMIT_LEDGER_KEY
      )
      const ledger: RoomRateLimitLedger =
        !stored
        || !Number.isFinite(stored.windowStartedAt)
        || now - stored.windowStartedAt >= 60_000
          ? {
              windowStartedAt: now,
              connectCount: 0,
              publishCount: 0,
              clientConnectCounts: {},
            }
          : {
              windowStartedAt: stored.windowStartedAt,
              connectCount: Number(stored.connectCount) || 0,
              publishCount: Number(stored.publishCount) || 0,
              clientConnectCounts:
                stored.clientConnectCounts
                && typeof stored.clientConnectCounts === 'object'
                  ? stored.clientConnectCounts
                  : {},
            }

      let allowed: boolean
      if (kind === 'connect') {
        ledger.connectCount += 1
        const bucket = clientBucket ?? 'unknown'
        ledger.clientConnectCounts[bucket] =
          (ledger.clientConnectCounts[bucket] ?? 0) + 1
        allowed =
          ledger.connectCount <= boundedInteger(
            this.env.MAX_ROOM_CONNECTS_PER_MINUTE,
            60,
            600
          )
          && ledger.clientConnectCounts[bucket] <= boundedInteger(
            this.env.MAX_CLIENT_CONNECTS_PER_MINUTE,
            10,
            60
          )
      } else {
        ledger.publishCount += 1
        allowed = ledger.publishCount <= boundedInteger(
          this.env.MAX_ROOM_PUBLISHES_PER_MINUTE,
          120,
          1_200
        )
      }

      // Persist even a rejected attempt. Hibernation/eviction cannot reset the
      // window, and repeated rejected calls cannot remain free of accounting.
      await transaction.put(RATE_LIMIT_LEDGER_KEY, ledger)
      return allowed
    })
  }

  private async consumeNonce(nonce: string, timestamp: number): Promise<boolean> {
    return this.state.storage.transaction(async (transaction) => {
      const stored =
        await transaction.get<Array<[nonce: string, timestamp: number]>>(
          NONCE_LEDGER_KEY
        ) ?? []
      const cutoff = Date.now() - AUTH_WINDOW_MS
      const active = stored.filter(
        ([storedNonce, storedAt]) =>
          typeof storedNonce === 'string'
          && Number.isSafeInteger(storedAt)
          && storedAt >= cutoff
      )
      if (active.some(([storedNonce]) => storedNonce === nonce)) return false

      // Store one bounded ledger value instead of one key per nonce. A
      // key-prefix list on every publish would read up to 256 storage rows and
      // make replay protection the dominant DO cost; this performs one read
      // and one write while preserving atomic replay suppression.
      active.push([nonce, timestamp])
      await transaction.put(
        NONCE_LEDGER_KEY,
        active.slice(-MAX_NONCE_RECORDS)
      )
      return true
    })
  }

  /**
   * Take the next fanout number for this room.
   *
   * Allocated after replay/dedupe so a retried publish never burns a number,
   * and before fanout so a send failure leaves a visible gap. A gap is the
   * correct outcome there: the client reloads history and the database — not
   * this counter — decides what it actually missed.
   */
  private async allocateSeq(): Promise<number> {
    return this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<number>(ROOM_SEQ_KEY)
      const next = (Number.isSafeInteger(stored) ? (stored as number) : 0) + 1
      await transaction.put(ROOM_SEQ_KEY, next)
      return next
    })
  }

  private async consumeEventId(eventId: string): Promise<boolean> {
    return this.state.storage.transaction(async (transaction) => {
      const stored =
        await transaction.get<Array<[eventId: string, timestamp: number]>>(
          DELIVERY_LEDGER_KEY
        ) ?? []
      const now = Date.now()
      const cutoff = now - DELIVERY_DEDUPE_TTL_MS
      const active = stored.filter(
        ([storedEventId, storedAt]) =>
          typeof storedEventId === 'string'
          && Number.isFinite(storedAt)
          && storedAt >= cutoff
      )
      if (active.some(([storedEventId]) => storedEventId === eventId)) {
        return false
      }
      active.push([eventId, now])
      await transaction.put(
        DELIVERY_LEDGER_KEY,
        active.slice(-MAX_DELIVERY_RECORDS)
      )
      return true
    })
  }

  /**
   * Disconnect every socket once the operator has removed this room from the
   * allowlist, then stop rescheduling.
   *
   * Reads the allowlist from `this.env`, which the runtime supplies from the
   * currently deployed Worker version, so a secret change takes effect on the
   * next alarm without any client-side polling.
   */
  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets('protocol-v1')
    if (sockets.length === 0) {
      // No listeners: let the object go fully idle instead of paying for a
      // wake every minute for a room nobody is watching.
      await this.state.storage.delete(ROOM_STREAMER_ID_KEY)
      return
    }

    const streamerId = await this.state.storage.get<string>(ROOM_STREAMER_ID_KEY)
    // A room whose identity is missing cannot be re-evaluated. Keep the sockets
    // (polling still recovers every committed event) and retry on the next
    // alarm rather than disconnecting a healthy room on a storage miss.
    if (!streamerId || realtimeEnabled(this.env, streamerId)) {
      // Still allowed: prove liveness on the same wake. Clients reconcile
      // history only every ten minutes, so this distinguishes "no gacha
      // happened" from "this socket died" without waiting for that DB pass.
      const heartbeat = JSON.stringify({
        type: 'server_notice',
        code: OVERLAY_REALTIME_HEARTBEAT,
      })
      for (const socket of sockets) {
        try {
          socket.send(heartbeat)
        } catch {
          // A dead socket is exactly what the client-side deadline handles.
        }
      }
      await this.state.storage.setAlarm(Date.now() + KILL_SWITCH_CHECK_MS)
      return
    }

    const notice = JSON.stringify({
      type: 'server_notice',
      code: OVERLAY_REALTIME_TRANSPORT_DISABLED,
    })
    for (const socket of sockets) {
      try {
        socket.send(notice)
      } catch {
        // Best effort: the close below is what actually forces the fallback.
      }
      try {
        // 1008 (policy violation) is in the client's no-reconnect list, so a
        // disabled room does not turn into a reconnect storm against a Worker
        // that would reject every attempt with 503 anyway.
        socket.close(1008, 'Realtime transport disabled')
      } catch {
        // A failed close must never abort the rest of the room.
      }
    }
    await this.state.storage.delete(ROOM_STREAMER_ID_KEY)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.startsWith('/room/connect/')) {
      const bucket = await clientRateLimitBucket(request)
      if (!await this.consumeRoomRateLimit('connect', bucket)) {
        return json({ error: 'Connection rate exceeded' }, 429)
      }
      const maximum = boundedInteger(this.env.MAX_ROOM_CONNECTIONS, 100, 1_000)
      if (this.state.getWebSockets().length >= maximum) {
        return json({ error: 'Room capacity reached' }, 503)
      }

      // WebSocketPair is a Workers runtime global rather than a browser DOM
      // API. Resolve it through globalThis so the shared Next.js typecheck can
      // import this module without globally installing Workers-only ambient
      // declarations; the dedicated Worker tsconfig still validates its shape.
      const Pair = (globalThis as unknown as {
        WebSocketPair: new () => { 0: CloudflareWebSocket; 1: CloudflareWebSocket }
      }).WebSocketPair
      const pair = new Pair()
      const [client, server] = Object.values(pair)
      const attachment: SocketAttachment = {
        connectionId: crypto.randomUUID(),
        connectedAt: Date.now(),
        messageWindowStartedAt: Date.now(),
        messageCount: 0,
      }
      this.state.acceptWebSocket(server, ['protocol-v1'])
      // Cloudflare's Hibernation API registers the server socket first; the
      // attachment is then associated with that accepted socket and restored
      // after hibernation through deserializeAttachment().
      server.serializeAttachment(attachment)

      // Arm the kill-switch alarm. `alarm()` gets no request, so the room's own
      // identity has to be persisted here; the public router already rejected
      // any malformed ID before routing to this object.
      const roomStreamerId = decodeURIComponent(
        url.pathname.slice('/room/connect/'.length)
      )
      if (isValidStreamerId(roomStreamerId)) {
        await this.state.storage.put(ROOM_STREAMER_ID_KEY, roomStreamerId)
      }
      // Only arm when nothing is pending. Re-arming on every connect would push
      // the check out indefinitely for a room that OBS reconnects frequently.
      if (await this.state.storage.getAlarm() === null) {
        await this.state.storage.setAlarm(Date.now() + KILL_SWITCH_CHECK_MS)
      }
      server.send(JSON.stringify({
        type: 'welcome',
        protocolVersion: 1,
        connectionId: attachment.connectionId,
        serverTime: new Date().toISOString(),
        // Baseline so the first delivery after connecting is recognisably
        // contiguous instead of looking like a missed one.
        seq: await this.state.storage.get<number>(ROOM_SEQ_KEY) ?? 0,
      }))
      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit & { webSocket: CloudflareWebSocket })
    }

    if (request.method === 'POST' && url.pathname === '/publish') {
      if (!await this.consumeRoomRateLimit('publish')) {
        return json({ error: 'Publish rate exceeded' }, 429)
      }
      const streamerId = request.headers.get('x-internal-streamer-id') ?? ''
      const nonce = request.headers.get('x-internal-nonce') ?? ''
      const timestamp = Number(request.headers.get('x-internal-timestamp'))
      if (!isValidStreamerId(streamerId) || !nonce || !Number.isSafeInteger(timestamp)) {
        return json({ error: 'Invalid internal request' }, 400)
      }
      if (!await this.consumeNonce(nonce, timestamp)) {
        return json({ error: 'Replay rejected' }, 409)
      }

      const event = await request.json()
      const validation = validateGachaRealtimeEvent(event, streamerId)
      if (!validation.ok) return json({ error: validation.error }, 400)
      const eventId = (event as { eventId: string }).eventId
      if (!await this.consumeEventId(eventId)) {
        // A publisher retry may arrive after the first response was lost.
        // Treat it as accepted but never fan out twice; PlanetScale polling
        // remains the recovery path if a crash happened after this ledger
        // commit and before the first socket send.
        return json({
          accepted: true,
          duplicate: true,
          fanoutCount: 0,
          failedCount: 0,
        }, 202)
      }
      const seq = await this.allocateSeq()
      const message = JSON.stringify({ type: 'gacha_result', seq, event })

      let fanoutCount = 0
      let failedCount = 0
      for (const socket of this.state.getWebSockets('protocol-v1')) {
        try {
          if (socket.readyState !== WebSocket.OPEN) continue
          const bufferedAmount = (
            socket as CloudflareWebSocket & { readonly bufferedAmount?: number }
          ).bufferedAmount ?? 0
          if (bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
            socket.close(1013, 'Client is too slow')
            failedCount += 1
            continue
          }
          socket.send(message)
          fanoutCount += 1
        } catch {
          failedCount += 1
          try {
            socket.close(1011, 'Send failed')
          } catch {
            // A failed socket must never abort fanout to the rest of the room.
          }
        }
      }
      return json({ accepted: true, fanoutCount, failedCount }, 202)
    }

    // This fallback is reachable only through the Durable Object binding, not
    // from the public Worker router. Keep the method and normalized pathname in
    // observability logs so production-only routing differences can be
    // diagnosed without recording signed headers, card payloads, or usernames.
    console.warn('[overlay-realtime] room route miss', {
      method: request.method,
      pathname: url.pathname,
    })
    return json({ error: 'Not found' }, 404)
  }

  webSocketMessage(socket: CloudflareWebSocket, message: string | ArrayBuffer): void {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength
    if (bytes > MAX_CLIENT_MESSAGE_BYTES) {
      socket.close(1009, 'Message too large')
      return
    }

    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (!attachment) {
      socket.close(1011, 'Missing connection state')
      return
    }
    const now = Date.now()
    if (now - attachment.messageWindowStartedAt >= 60_000) {
      attachment.messageWindowStartedAt = now
      attachment.messageCount = 0
    }
    attachment.messageCount += 1
    socket.serializeAttachment(attachment)
    if (attachment.messageCount > CLIENT_MESSAGES_PER_MINUTE) {
      socket.close(1008, 'Message rate exceeded')
      return
    }

    try {
      const parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
      const validHello =
        parsed?.type === 'hello'
        && parsed.protocolVersion === 1
        && typeof parsed.clientVersion === 'string'
        && parsed.clientVersion.length <= 64
      const validAck =
        parsed?.type === 'ack'
        && typeof parsed.eventId === 'string'
        && parsed.eventId.length <= 256
      if (!validHello && !validAck) socket.close(1008, 'Invalid client message')
    } catch {
      socket.close(1007, 'Invalid JSON')
    }
  }

  webSocketClose(socket: CloudflareWebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason)
    } catch {
      // The peer may already have completed the close handshake.
    }
  }

  webSocketError(socket: CloudflareWebSocket): void {
    try {
      socket.close(1011, 'WebSocket error')
    } catch {
      // Nothing remains to clean up when the runtime has already dropped it.
    }
  }
}
