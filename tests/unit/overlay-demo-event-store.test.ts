import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  __clearOverlayDemoEventsForTests,
  getOverlayDemoEvent,
  publishOverlayDemoEvent,
} from '@/lib/overlay/demo-event-store'
import { GET } from '@/app/api/overlay/[streamerId]/demo-events/route'

const CARD = {
  id: 'card-1',
  name: 'Demo card',
  description: null,
  image_url: null,
  image_padding_color: null,
  rarity: 'common',
}

beforeEach(() => {
  __clearOverlayDemoEventsForTests()
  vi.useRealTimers()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('overlay demo event store', () => {
  it('returns a published event only to clients with an older cursor', async () => {
    const before = new Date(Date.now() - 1000).toISOString()
    const event = await publishOverlayDemoEvent('streamer-1', CARD)

    expect(await getOverlayDemoEvent('streamer-1', before)).toEqual(event)
    expect(await getOverlayDemoEvent('streamer-1', event.redeemedAt)).toBeNull()
  })

  it('keeps only the latest demo value per streamer', async () => {
    const first = await publishOverlayDemoEvent('streamer-1', CARD)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await publishOverlayDemoEvent('streamer-1', {
      ...CARD,
      id: 'card-2',
      name: 'Second',
    })

    expect(second.id).not.toBe(first.id)
    expect(await getOverlayDemoEvent('streamer-1', first.redeemedAt)).toEqual(second)
  })

  it('exposes the latest event through the overlay polling route', async () => {
    const since = new Date(Date.now() - 1000).toISOString()
    const event = await publishOverlayDemoEvent('streamer-1', CARD)
    const request = new NextRequest(
      `http://localhost/api/overlay/streamer-1/demo-events?since=${encodeURIComponent(since)}`
    )

    const response = await GET(request, {
      params: Promise.resolve({ streamerId: 'streamer-1' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ event })
  })

  it('rejects an invalid cursor without reading external services', async () => {
    const request = new NextRequest(
      'http://localhost/api/overlay/streamer-1/demo-events?since=invalid'
    )
    const response = await GET(request, {
      params: Promise.resolve({ streamerId: 'streamer-1' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid since parameter' })
  })

  it('refuses unreliable process-local delivery when production loses its KV binding', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    await expect(publishOverlayDemoEvent('streamer-1', CARD)).rejects.toThrow(
      'RATE_LIMIT_KV is required in production'
    )
  })
})
