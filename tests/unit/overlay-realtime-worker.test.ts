import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/overlay-realtime/src/index'
import { buildPollingRealtimeEvents } from '@/lib/overlay-realtime/contract'
import { createPublishSignature } from '@/lib/overlay-realtime/signature'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECRET = 'worker-test-secret-with-sufficient-entropy'

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
    expect(roomFetch).toHaveBeenCalledWith(
      'https://room.internal/publish',
      expect.objectContaining({ method: 'POST', body })
    )
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
        OVERLAY_REALTIME_PUBLISH_SECRET: SECRET,
        OVERLAY_ROOMS: { get },
      } as unknown as Parameters<typeof worker.fetch>[1]
    )

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })
})
