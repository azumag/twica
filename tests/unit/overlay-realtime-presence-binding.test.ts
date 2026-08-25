import { describe, expect, it } from 'vitest'
import worker from '../../workers/overlay-realtime/src/index'

describe('overlay realtime presence binding', () => {
  it('returns 503 when OVERLAY_PRESENCE is not bound', async () => {
    const env = {
      OVERLAY_ROOMS: {} as Parameters<typeof worker.fetch>[1]['OVERLAY_ROOMS'],
      OVERLAY_REALTIME_PUBLISH_SECRET: 'test-secret',
      OVERLAY_REALTIME_MODE: 'do-primary',
      OVERLAY_REALTIME_STREAMER_ALLOWLIST: '*',
    } as Parameters<typeof worker.fetch>[1]

    const response = await worker.fetch(
      new Request('https://worker.example/presence'),
      env,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Presence unavailable' })
  })
})
