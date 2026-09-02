import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPublishSignature } from '@/lib/overlay-realtime/signature'
import { OverlayRoom } from '../../workers/overlay-realtime/src/index'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_STREAMER_ID = '223e4567-e89b-42d3-a456-426614174000'
const SECRET = 'presence-capability-test-secret-with-sufficient-entropy'

interface StorageTransaction {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn(),
  }
}

function createHarness() {
  const records = new Map<string, unknown>()
  const presenceTasks: Promise<unknown>[] = []
  let alarmAt: number | null = null
  const transaction = async <T>(
    callback: (tx: StorageTransaction) => Promise<T>,
  ): Promise<T> => callback({
    get: async <V>(key: string) => records.get(key) as V | undefined,
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value))
    },
  })
  const state = {
    waitUntil: (promise: Promise<unknown>) => {
      presenceTasks.push(promise)
    },
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
    getWebSockets: vi.fn(() => []),
    acceptWebSocket: vi.fn(),
  }
  const presenceFetch = vi.fn().mockResolvedValue(
    Response.json({ accepted: true }, { status: 202 }),
  )
  const env = {
    OVERLAY_REALTIME_MODE: 'do-primary',
    OVERLAY_REALTIME_STREAMER_ALLOWLIST: STREAMER_ID,
    OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
    OVERLAY_PRESENCE: {
      idFromName: vi.fn(() => ({ registry: 'all' })),
      get: vi.fn(() => ({ fetch: presenceFetch })),
    },
    MAX_ROOM_CONNECTIONS: '100',
    MAX_ROOM_CONNECTS_PER_MINUTE: '60',
    MAX_CLIENT_CONNECTS_PER_MINUTE: '10',
    MAX_ROOM_PUBLISHES_PER_MINUTE: '120',
  }
  return {
    room: new OverlayRoom(state as never, env as never),
    presenceFetch,
    presenceTasks,
  }
}

async function createPresenceToken(
  streamerId: string,
  expiresAt = Date.now() + 24 * 60 * 60_000,
): Promise<string> {
  const expiresAtRaw = String(expiresAt)
  const nonce = crypto.randomUUID()
  const signature = await createPublishSignature(
    SECRET,
    `/v1/rooms/${streamerId}/connect`,
    '',
    expiresAtRaw,
    nonce,
  )
  return `${expiresAtRaw}.${nonce}.${signature}`
}

function tamperSignature(token: string): string {
  const [expiresAt, nonce, signature] = token.split('.')
  const last = signature.at(-1)
  return `${expiresAt}.${nonce}.${signature.slice(0, -1)}${last === '0' ? '1' : '0'}`
}

describe('overlay presence capability rejection', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocketPair', class {
      0 = makeSocket()
      1 = makeSocket()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('別streamer・期限切れ・改竄・不正形式tokenでは公開presence leaseを作らない', async () => {
    const valid = await createPresenceToken(STREAMER_ID)
    const cases = [
      ['different streamer', await createPresenceToken(OTHER_STREAMER_ID)],
      ['expired', await createPresenceToken(STREAMER_ID, Date.now() - 2 * 60_000)],
      ['tampered signature', tamperSignature(valid)],
      ['malformed', 'not-a-presence-token'],
    ] as const

    for (const [label, token] of cases) {
      const harness = createHarness()
      const response = await harness.room.fetch(
        new Request(
          `https://room.internal/room/connect/${STREAMER_ID}?presence=${encodeURIComponent(token)}`,
        ),
      )
      await Promise.all(harness.presenceTasks)

      expect(response.status, label).toBe(101)
      expect(harness.presenceFetch, label).not.toHaveBeenCalled()
    }
  })
})
