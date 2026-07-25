import { describe, expect, it, vi } from 'vitest'
import worker, {
  OverlayRoom,
} from '../../workers/overlay-realtime/src/index'
import { buildPollingRealtimeEvents } from '@/lib/overlay-realtime/contract'
import { createPublishSignature } from '@/lib/overlay-realtime/signature'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECRET = 'worker-test-secret-with-sufficient-entropy'
const ROLLOUT_ENV = {
  OVERLAY_REALTIME_MODE: 'do-primary',
  OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
}

function eventFixture() {
  return buildPollingRealtimeEvents(STREAMER_ID, [{
    id: 'history-1',
    eventId: 'batch-1',
    redeemedAt: '2026-07-24T00:00:00.000Z',
    userTwitchUsername: 'viewer',
    rewardId: null,
    card: {
      id: 'card-1',
      name: 'Card',
      description: null,
      image_url: null,
      rarity: 'rare',
    },
  }])[0]
}

describe('overlay realtime Worker router', () => {
  it('exposes a no-secret health response and rejects non-upgrade subscribe', async () => {
    const env = {
      ...ROLLOUT_ENV,
      OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
      OVERLAY_ROOMS: {} as Parameters<typeof worker.fetch>[1]['OVERLAY_ROOMS'],
    }
    const health = await worker.fetch(
      new Request('https://worker.example/health'),
      env
    )
    await expect(health.json()).resolves.toEqual({
      ok: true,
      protocolVersion: 1,
    })

    const connect = await worker.fetch(
      new Request(`https://worker.example/v1/rooms/${STREAMER_ID}/connect`),
      env
    )
    expect(connect.status).toBe(426)
  })

  it('forwards a valid signed event to only the named room', async () => {
    const body = JSON.stringify(eventFixture())
    const pathname = `/internal/v1/rooms/${STREAMER_ID}/publish`
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    const signature = await createPublishSignature(
      SECRET,
      pathname,
      body,
      timestamp,
      nonce
    )
    const roomFetch = vi.fn().mockResolvedValue(
      Response.json({ accepted: true }, { status: 202 })
    )
    const idFromName = vi.fn(() => ({ room: STREAMER_ID }))
    const env = {
      ...ROLLOUT_ENV,
      OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
      OVERLAY_ROOMS: {
        idFromName,
        get: vi.fn(() => ({ fetch: roomFetch })),
      },
    }

    const response = await worker.fetch(
      new Request(`https://worker.example${pathname}`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-twica-timestamp': timestamp,
          'x-twica-nonce': nonce,
          'x-twica-signature': signature,
        },
      }),
      env as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(202)
    expect(idFromName).toHaveBeenCalledWith(STREAMER_ID)
    expect(roomFetch).toHaveBeenCalledTimes(1)
    const roomRequest = roomFetch.mock.calls[0][0] as Request
    expect(roomRequest).toBeInstanceOf(Request)
    expect(roomRequest.method).toBe('POST')
    expect(new URL(roomRequest.url).pathname).toBe('/publish')
    expect(roomRequest.headers.get('x-internal-streamer-id')).toBe(STREAMER_ID)
    expect(roomRequest.headers.get('x-internal-nonce')).toBe(nonce)
    expect(roomRequest.headers.get('x-internal-timestamp')).toBe(timestamp)
    expect(await roomRequest.text()).toBe(body)
  })

  it('does not touch a room when the signature is invalid', async () => {
    const get = vi.fn()
    const response = await worker.fetch(
      new Request(
        `https://worker.example/internal/v1/rooms/${STREAMER_ID}/publish`,
        {
          method: 'POST',
          body: JSON.stringify(eventFixture()),
          headers: {
            'x-twica-timestamp': String(Date.now()),
            'x-twica-nonce': crypto.randomUUID(),
            'x-twica-signature': '0'.repeat(64),
          },
        }
      ),
      {
        ...ROLLOUT_ENV,
        OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
        OVERLAY_ROOMS: { get },
      } as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(401)
    expect(get).not.toHaveBeenCalled()
  })

  it('does not expose publish on the public room prefix', async () => {
    const body = JSON.stringify(eventFixture())
    const pathname = `/v1/rooms/${STREAMER_ID}/publish`
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    const signature = await createPublishSignature(
      SECRET,
      pathname,
      body,
      timestamp,
      nonce
    )
    const get = vi.fn()
    const response = await worker.fetch(
      new Request(`https://worker.example${pathname}`, {
        method: 'POST',
        body,
        headers: {
          'x-twica-timestamp': timestamp,
          'x-twica-nonce': nonce,
          'x-twica-signature': signature,
        },
      }),
      {
        ...ROLLOUT_ENV,
        OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
        OVERLAY_ROOMS: { get },
      } as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(404)
    expect(get).not.toHaveBeenCalled()
  })

  it('cancels a chunked publish body as soon as it exceeds 64 KiB', async () => {
    let pullCount = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1
        controller.enqueue(new Uint8Array(pullCount === 1 ? 32 * 1024 : 32 * 1024 + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const get = vi.fn()
    const response = await worker.fetch(
      new Request(
        `https://worker.example/internal/v1/rooms/${STREAMER_ID}/publish`,
        {
          method: 'POST',
          body,
          // Node requires duplex for streamed request bodies. Workers ignores
          // this Node-only test option; it is not part of the deployed request.
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }
      ),
      {
        ...ROLLOUT_ENV,
        OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
        OVERLAY_ROOMS: { get },
      } as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it('enforces polling-only and the allowlist before touching any room', async () => {
    const get = vi.fn()
    const baseEnv = {
      OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
      OVERLAY_ROOMS: { get },
    } as unknown as Parameters<typeof worker.fetch>[1]

    const pollingOnly = await worker.fetch(
      new Request(`https://worker.example/v1/rooms/${STREAMER_ID}/connect`, {
        headers: { upgrade: 'websocket' },
      }),
      {
        ...baseEnv,
        OVERLAY_REALTIME_MODE: 'polling-only',
        OVERLAY_REALTIME_STREAMER_ALLOWLIST: '*',
      }
    )
    const notAllowlisted = await worker.fetch(
      new Request(`https://worker.example/v1/rooms/${STREAMER_ID}/connect`, {
        headers: { upgrade: 'websocket' },
      }),
      {
        ...baseEnv,
        OVERLAY_REALTIME_MODE: 'do-primary',
        OVERLAY_REALTIME_STREAMER_ALLOWLIST:
          '123e4567-e89b-42d3-a456-426614174001',
      }
    )

    expect(pollingOnly.status).toBe(503)
    expect(notAllowlisted.status).toBe(503)
    expect(get).not.toHaveBeenCalled()
  })
})

interface StorageTransaction {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

function createRoomHarness(socketCount = 0) {
  const records = new Map<string, unknown>()
  const transaction = async <T>(
    callback: (tx: StorageTransaction) => Promise<T>
  ): Promise<T> => callback({
    get: async <V>(key: string) => records.get(key) as V | undefined,
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value))
    },
  })
  const sockets = Array.from({ length: socketCount }, () => ({
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn(),
  }))
  // The kill-switch alarm reads and writes storage directly rather than through
  // a transaction, and schedules itself, so the harness models those too.
  let alarmAt: number | null = null
  const state = {
    storage: {
      transaction,
      get: async <V>(key: string) => records.get(key) as V | undefined,
      put: async (key: string, value: unknown) => {
        records.set(key, structuredClone(value))
      },
      delete: async (key: string) => {
        records.delete(key)
      },
      getAlarm: async () => alarmAt,
      setAlarm: async (time: number) => {
        alarmAt = time
      },
    },
    getWebSockets: vi.fn(() => sockets),
    acceptWebSocket: vi.fn(),
  }
  const env = {
    ...ROLLOUT_ENV,
    OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
    MAX_ROOM_CONNECTIONS: '100',
    MAX_ROOM_CONNECTS_PER_MINUTE: '60',
    MAX_CLIENT_CONNECTS_PER_MINUTE: '10',
    MAX_ROOM_PUBLISHES_PER_MINUTE: '120',
  }
  return {
    records,
    sockets,
    state,
    env,
    getAlarmAt: () => alarmAt,
    room: new OverlayRoom(
      state as unknown as ConstructorParameters<typeof OverlayRoom>[0],
      env as unknown as ConstructorParameters<typeof OverlayRoom>[1]
    ),
  }
}

function internalPublishRequest(event: unknown, nonce = crypto.randomUUID()) {
  return new Request('https://room.internal/publish', {
    method: 'POST',
    body: JSON.stringify(event),
    headers: {
      'content-type': 'application/json',
      'x-internal-streamer-id': STREAMER_ID,
      'x-internal-nonce': nonce,
      'x-internal-timestamp': String(Date.now()),
    },
  })
}

describe('OverlayRoom Durable Object', () => {
  it('persists room and per-client rate limits across object reconstruction', async () => {
    const harness = createRoomHarness()
    const first = harness.room as unknown as {
      consumeRoomRateLimit(
        kind: 'connect' | 'publish',
        clientBucket?: string
      ): Promise<boolean>
    }
    harness.env.MAX_ROOM_CONNECTS_PER_MINUTE = '1'
    const secondRoom = new OverlayRoom(
      harness.state as unknown as ConstructorParameters<typeof OverlayRoom>[0],
      harness.env as unknown as ConstructorParameters<typeof OverlayRoom>[1]
    ) as unknown as typeof first

    await expect(first.consumeRoomRateLimit('connect', 'client-a')).resolves.toBe(true)
    await expect(secondRoom.consumeRoomRateLimit('connect', 'client-a')).resolves.toBe(false)
    expect(harness.records.has('rate-limit-ledger')).toBe(true)
  })

  it('accepts a publisher retry but fans out one stable event only once', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const harness = createRoomHarness(1)
    const event = eventFixture()

    const first = await harness.room.fetch(internalPublishRequest(event))
    const retry = await harness.room.fetch(internalPublishRequest(event))

    expect(first.status).toBe(202)
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      fanoutCount: 0,
    })
    expect(harness.sockets[0].send).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('rejects a replayed nonce before a second fanout', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const harness = createRoomHarness(1)
    const nonce = crypto.randomUUID()

    const first = await harness.room.fetch(
      internalPublishRequest(eventFixture(), nonce)
    )
    const replay = await harness.room.fetch(
      internalPublishRequest(eventFixture(), nonce)
    )

    expect(first.status).toBe(202)
    expect(replay.status).toBe(409)
    expect(harness.sockets[0].send).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('isolates one socket send failure from the rest of the room', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const harness = createRoomHarness(2)
    harness.sockets[0].send.mockImplementation(() => {
      throw new Error('stale socket')
    })

    const response = await harness.room.fetch(
      internalPublishRequest(eventFixture())
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      fanoutCount: 1,
      failedCount: 1,
    })
    expect(harness.sockets[0].close).toHaveBeenCalledWith(1011, 'Send failed')
    expect(harness.sockets[1].send).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('rejects capacity before constructing another WebSocket pair', async () => {
    const harness = createRoomHarness(1)
    harness.env.MAX_ROOM_CONNECTIONS = '1'
    const response = await harness.room.fetch(
      new Request(`https://room.internal/room/connect/${STREAMER_ID}`, {
        headers: { 'cf-connecting-ip': '203.0.113.10' },
      })
    )
    expect(response.status).toBe(503)
  })

  it('closes malformed client messages without affecting other sockets', () => {
    const harness = createRoomHarness()
    const socket = {
      close: vi.fn(),
      serializeAttachment: vi.fn(),
      deserializeAttachment: vi.fn(() => ({
        connectionId: 'connection-1',
        connectedAt: Date.now(),
        messageWindowStartedAt: Date.now(),
        messageCount: 0,
      })),
    }

    harness.room.webSocketMessage(socket as never, '{')
    expect(socket.close).toHaveBeenCalledWith(1007, 'Invalid JSON')
  })
})

/**
 * Operator kill switch over the socket.
 *
 * The allowlist lives in a Worker secret, so a hibernating socket never learns
 * that its room was disabled. Before this alarm existed the client would keep a
 * healthy-looking socket open against a room that no longer receives publishes,
 * and simply stop showing gacha — the user-visible failure #803 was about.
 */
describe('OverlayRoom kill switch alarm', () => {
  const OTHER_STREAMER_ID = '223e4567-e89b-42d3-a456-426614174000'

  it('arms the alarm and records room identity when a client connects', async () => {
    // WebSocketPair is a Workers runtime global with no Node equivalent; the
    // room only needs the pair's two ends and the accept/attach calls, which
    // the harness already records.
    const makeSocket = () => ({
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
      deserializeAttachment: vi.fn(),
    })
    vi.stubGlobal('WebSocketPair', class {
      0 = makeSocket()
      1 = makeSocket()
    })

    const harness = createRoomHarness()
    const response = await harness.room.fetch(
      new Request(`https://room.internal/room/connect/${STREAMER_ID}`)
    )

    expect(response.status).toBe(101)
    // alarm() receives no request, so the room must persist its own identity.
    expect(harness.records.get('room-streamer-id')).toBe(STREAMER_ID)
    expect(harness.getAlarmAt()).not.toBeNull()
  })

  it('keeps sockets and reschedules while the room is still allowlisted', async () => {
    const harness = createRoomHarness(2)
    harness.records.set('room-streamer-id', STREAMER_ID)

    await harness.room.alarm()

    for (const socket of harness.sockets) {
      expect(socket.close).not.toHaveBeenCalled()
    }
    expect(harness.getAlarmAt()).not.toBeNull()
  })

  it('notifies and disconnects every socket once the room is removed', async () => {
    const harness = createRoomHarness(2)
    harness.records.set('room-streamer-id', STREAMER_ID)
    // Operator kill switch: this streamer is no longer allowlisted.
    harness.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST = OTHER_STREAMER_ID

    await harness.room.alarm()

    for (const socket of harness.sockets) {
      const sent = socket.send.mock.calls.map((args) => JSON.parse(String(args[0])))
      expect(sent).toContainEqual({
        type: 'server_notice',
        code: 'transport_disabled',
      })
      // 1008 is in the client's no-reconnect list, so a disabled room cannot
      // turn into a reconnect storm against a Worker that would reject it.
      expect(socket.close).toHaveBeenCalledWith(1008, 'Realtime transport disabled')
    }
    // Nothing left to police: the room must not keep paying for wakeups.
    expect(harness.records.has('room-streamer-id')).toBe(false)
  })

  it('stops rescheduling once the room has no sockets left', async () => {
    const harness = createRoomHarness(0)
    harness.records.set('room-streamer-id', STREAMER_ID)

    await harness.room.alarm()

    expect(harness.getAlarmAt()).toBeNull()
    expect(harness.records.has('room-streamer-id')).toBe(false)
  })

  it('never disconnects a healthy room just because its identity is missing', async () => {
    // A storage miss must not be mistaken for "operator disabled this room".
    // Polling still recovers every committed event, so retrying is strictly
    // safer than dropping live sockets.
    const harness = createRoomHarness(1)
    harness.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST = OTHER_STREAMER_ID

    await harness.room.alarm()

    expect(harness.sockets[0].close).not.toHaveBeenCalled()
    expect(harness.getAlarmAt()).not.toBeNull()
  })
})
