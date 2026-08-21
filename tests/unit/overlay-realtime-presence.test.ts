/**
 * #1114: overlay presence（推定配信チャネル数）のWorker側テスト。
 *
 * PresenceRegistry DO（room重複排除・lease期限切れ・room ID非公開）/
 * 署名付き /internal/v1/presence-count 経路 / OverlayRoom の状態変化報告と
 * 数分おきrefreshのスロットルを検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, {
  OverlayRoom,
  PresenceRegistry,
} from '../../workers/overlay-realtime/src/index'
import { createPublishSignature } from '@/lib/overlay-realtime/signature'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_STREAMER_ID = '223e4567-e89b-42d3-a456-426614174999'
const SECRET = 'worker-test-secret-with-sufficient-entropy'

vi.stubGlobal('WebSocket', { OPEN: 1 })

class FakeWebSocketPair {
  [key: number]: Record<string, unknown>
  constructor() {
    const server = {
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
    }
    this[0] = {}
    this[1] = server
  }
}

vi.stubGlobal('WebSocketPair', FakeWebSocketPair)

interface StorageTransaction {
  get<V>(key: string): Promise<V | undefined>
  put(key: string, value: unknown): Promise<void>
}

function createStorageHarness() {
  const records = new Map<string, unknown>()
  const transaction = async <T>(
    callback: (tx: StorageTransaction) => Promise<T>
  ): Promise<T> =>
    callback({
      get: async <V>(key: string) => records.get(key) as V | undefined,
      put: async (key: string, value: unknown) => {
        records.set(key, structuredClone(value))
      },
    })
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
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  }
  return { records, state }
}

function createRoomHarness(socketCount = 0, registryFetch?: ReturnType<typeof vi.fn>) {
  const base = createStorageHarness()
  const sockets = Array.from({ length: socketCount }, () => ({
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn(),
  }))
  let alarmAt: number | null = null
  ;(base.state as { storage: Record<string, unknown> }).storage.getAlarm =
    async () => alarmAt
  ;(base.state as { storage: Record<string, unknown> }).storage.setAlarm =
    async (time: number) => {
      alarmAt = time
    }
  const state = Object.assign(base.state, {
    getWebSockets: vi.fn(() => sockets),
    acceptWebSocket: vi.fn(),
  })
  const env = {
    OVERLAY_REALTIME_MODE: 'do-primary',
    OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
    OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
    MAX_ROOM_CONNECTIONS: '100',
    MAX_ROOM_CONNECTS_PER_MINUTE: '60',
    MAX_CLIENT_CONNECTS_PER_MINUTE: '10',
    MAX_ROOM_PUBLISHES_PER_MINUTE: '120',
    ...(registryFetch
      ? {
          PRESENCE_REGISTRY: {
            idFromName: vi.fn(() => 'global'),
            get: vi.fn(() => ({ fetch: registryFetch })),
          },
        }
      : {}),
  }
  return {
    records: base.records,
    sockets,
    state,
    env,
    registryFetch,
    getAlarmAt: () => alarmAt,
    room: new OverlayRoom(
      state as unknown as ConstructorParameters<typeof OverlayRoom>[0],
      env as unknown as ConstructorParameters<typeof OverlayRoom>[1]
    ),
  }
}

function connect(harness: ReturnType<typeof createRoomHarness>, streamerId = STREAMER_ID) {
  return harness.room.fetch(
    new Request(`https://room.internal/room/connect/${streamerId}`)
  )
}

describe('OverlayRoom presence hooks (#1114)', () => {
  it('registers presence on the zero-to-one socket transition and throttles reconnects', async () => {
    const registryFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const harness = createRoomHarness(0, registryFetch)

    await connect(harness)

    expect(registryFetch).toHaveBeenCalledTimes(1)
    const request = registryFetch.mock.calls[0][0] as Request
    expect(new URL(request.url).pathname).toBe('/registry/presence/upsert')
    await expect(request.json()).resolves.toEqual({ roomId: STREAMER_ID })
    // 初回報告時刻が記録され、alarm側の数分おきrefreshの起点になる。
    expect(harness.records.get('presence-last-sent-at')).toEqual(
      expect.any(Number)
    )
  })

  it('does not report again when additional sources join an active room', async () => {
    const registryFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const harness = createRoomHarness(1, registryFetch)

    await connect(harness)

    expect(registryFetch).not.toHaveBeenCalled()
  })

  it('deregisters immediately when the alarm finds no sockets left', async () => {
    const registryFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const harness = createRoomHarness(0, registryFetch)
    harness.records.set('room-streamer-id', STREAMER_ID)
    harness.records.set('presence-last-sent-at', Date.now())

    await harness.room.alarm()

    expect(registryFetch).toHaveBeenCalledTimes(1)
    const request = registryFetch.mock.calls[0][0] as Request
    expect(new URL(request.url).pathname).toBe('/registry/presence/remove')
    await expect(request.json()).resolves.toEqual({ roomId: STREAMER_ID })
    expect(harness.records.has('presence-last-sent-at')).toBe(false)
    expect(harness.getAlarmAt()).toBeNull()
  })

  it('refreshes the lease on the alarm only after the few-minute throttle window', async () => {
    const registryFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const harness = createRoomHarness(1, registryFetch)
    harness.records.set('room-streamer-id', STREAMER_ID)

    // 直近で報告済み: refreshは行わない。
    harness.records.set('presence-last-sent-at', Date.now())
    await harness.room.alarm()
    expect(registryFetch).not.toHaveBeenCalled()
    expect(harness.getAlarmAt()).not.toBeNull()

    // スロットル窓（180秒）を過ぎた翌wakeでだけ再報告する。
    harness.records.set('presence-last-sent-at', Date.now() - 181_000)
    await harness.room.alarm()
    expect(registryFetch).toHaveBeenCalledTimes(1)
    expect(new URL((registryFetch.mock.calls[0][0] as Request).url).pathname).toBe(
      '/registry/presence/upsert'
    )
  })

  it('removes presence when the kill switch disables the room', async () => {
    const registryFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const harness = createRoomHarness(1, registryFetch)
    harness.records.set('room-streamer-id', STREAMER_ID)
    harness.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST = OTHER_STREAMER_ID

    await harness.room.alarm()

    expect(registryFetch).toHaveBeenCalledTimes(1)
    expect(new URL((registryFetch.mock.calls[0][0] as Request).url).pathname).toBe(
      '/registry/presence/remove'
    )
  })

  it('keeps rooms working when no registry binding exists', async () => {
    const harness = createRoomHarness(1)
    harness.records.set('room-streamer-id', STREAMER_ID)

    // binding未設定のデプロイ窓・旧テストでもroomは壊れない。
    await expect(harness.room.alarm()).resolves.toBeUndefined()
    expect(harness.sockets[0].send).toHaveBeenCalled()
  })
})

describe('presence-count endpoint (#1114)', () => {
  function makeRouterEnv(registryFetch?: ReturnType<typeof vi.fn>) {
    return {
      OVERLAY_REALTIME_MODE: 'do-primary',
      OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
      OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
      OVERLAY_ROOMS: {
        idFromName: vi.fn(() => ({})),
        get: vi.fn(() => ({ fetch: vi.fn() })),
      },
      ...(registryFetch
        ? {
            PRESENCE_REGISTRY: {
              idFromName: vi.fn(() => 'global'),
              get: vi.fn(() => ({ fetch: registryFetch })),
            },
          }
        : {}),
    }
  }

  it('requires the same HMAC authentication as publish', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example/internal/v1/presence-count'),
      makeRouterEnv() as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(401)
  })

  it('relays a registry snapshot that carries no room identifiers', async () => {
    const registryFetch = vi.fn().mockResolvedValue(
      Response.json({
        estimatedRooms: 4,
        generatedAt: '2026-08-21T00:00:00Z',
        secretInternalField: 'must-not-leak',
      })
    )
    const pathname = '/internal/v1/presence-count'
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    const signature = await createPublishSignature(SECRET, pathname, '', timestamp, nonce)

    const response = await worker.fetch(
      new Request(`https://worker.example${pathname}`, {
        headers: {
          'x-twica-timestamp': timestamp,
          'x-twica-nonce': nonce,
          'x-twica-signature': signature,
        },
      }),
      makeRouterEnv(registryFetch) as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toHaveProperty('estimatedRooms', 4)
    const request = registryFetch.mock.calls[0][0] as Request
    expect(new URL(request.url).pathname).toBe('/count')
  })

  it('answers 503 instead of leaking an error when the registry fails', async () => {
    const registryFetch = vi.fn().mockRejectedValue(new Error('boom'))
    const pathname = '/internal/v1/presence-count'
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    const signature = await createPublishSignature(SECRET, pathname, '', timestamp, nonce)

    const response = await worker.fetch(
      new Request(`https://worker.example${pathname}`, {
        headers: {
          'x-twica-timestamp': timestamp,
          'x-twica-nonce': nonce,
          'x-twica-signature': signature,
        },
      }),
      makeRouterEnv(registryFetch) as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(503)
  })

  it('answers 503 when the registry binding is missing entirely', async () => {
    const pathname = '/internal/v1/presence-count'
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    const signature = await createPublishSignature(SECRET, pathname, '', timestamp, nonce)

    const response = await worker.fetch(
      new Request(`https://worker.example${pathname}`, {
        headers: {
          'x-twica-timestamp': timestamp,
          'x-twica-nonce': nonce,
          'x-twica-signature': signature,
        },
      }),
      makeRouterEnv() as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(503)
  })
})

describe('PresenceRegistry Durable Object (#1114)', () => {
  function createRegistryHarness() {
    const { records, state } = createStorageHarness()
    const registry = new PresenceRegistry(
      state as unknown as ConstructorParameters<typeof PresenceRegistry>[0],
      {} as ConstructorParameters<typeof PresenceRegistry>[1]
    )
    return { records, registry }
  }

  function upsertRequest(roomId: string) {
    return new Request('https://registry.internal/registry/presence/upsert', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
      headers: { 'content-type': 'application/json' },
    })
  }

  function removeRequest(roomId: string) {
    return new Request('https://registry.internal/registry/presence/remove', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('deduplicates by room and exposes a bare count only', async () => {
    const { registry } = createRegistryHarness()
    await registry.fetch(upsertRequest(STREAMER_ID))
    await registry.fetch(upsertRequest(STREAMER_ID))
    await registry.fetch(upsertRequest(OTHER_STREAMER_ID))

    const response = await registry.fetch(
      new Request('https://registry.internal/count')
    )
    await expect(response.json()).resolves.toEqual({
      estimatedRooms: 2,
      generatedAt: expect.any(String),
    })
  })

  it('drops a room from the estimate after deregistration or lease expiry', async () => {
    const { records, registry } = createRegistryHarness()
    await registry.fetch(upsertRequest(STREAMER_ID))
    await registry.fetch(upsertRequest(OTHER_STREAMER_ID))

    await registry.fetch(removeRequest(STREAMER_ID))
    let response = await registry.fetch(new Request('https://registry.internal/count'))
    await expect(response.json()).resolves.toMatchObject({ estimatedRooms: 1 })

    // 明示的なremoveを逃したroom（クラッシュ等）もlease期限で外れる。
    records.set(
      'presence-leases',
      [[OTHER_STREAMER_ID, Date.now() - 11 * 60_000]]
    )
    response = await registry.fetch(new Request('https://registry.internal/count'))
    await expect(response.json()).resolves.toMatchObject({ estimatedRooms: 0 })
  })

  it('rejects malformed rooms and oversized bodies without storing them', async () => {
    const { records, registry } = createRegistryHarness()

    const invalid = await registry.fetch(upsertRequest('not-a-uuid'))
    expect(invalid.status).toBe(400)

    const oversize = await registry.fetch(
      new Request('https://registry.internal/registry/presence/upsert', {
        method: 'POST',
        body: JSON.stringify({ roomId: STREAMER_ID, padding: 'x'.repeat(300) }),
        headers: { 'content-type': 'application/json' },
      })
    )
    expect(oversize.status).toBe(413)

    expect(records.has('presence-leases')).toBe(false)
  })
})
