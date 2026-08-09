import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import {
  __clearOverlayDemoEventsForTests,
  createOverlayDemoEvent,
  getOverlayDemoEvent,
  publishOverlayDemoEvent,
  storeOverlayDemoEvent,
} from '@/lib/overlay/demo-event-store'
import { GET } from '@/app/api/overlay/[streamerId]/demo-events/route'

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn(),
}))

const mockGetCloudflareContext = vi.mocked(getCloudflareContext)

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
  mockGetCloudflareContext.mockReset()
  mockGetCloudflareContext.mockRejectedValue(new Error('not in Workers'))
})

afterEach(() => {
  vi.useRealTimers()
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

  it('creates a deeply immutable event before either transport receives it', () => {
    const event = createOverlayDemoEvent(CARD)

    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.card)).toBe(true)
    expect(event.eventId).toBe(event.id)
  })

  it('retains the fallback through reconciliation and retry grace, then expires it', async () => {
    const startedAt = Date.parse('2026-08-09T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    const cursor = new Date(startedAt - 1).toISOString()
    const event = await publishOverlayDemoEvent('streamer-1', CARD)

    // The healthy socket's periodic full reconciliation occurs at 10 minutes.
    vi.setSystemTime(startedAt + 10 * 60 * 1000)
    expect(await getOverlayDemoEvent('streamer-1', cursor)).toEqual(event)

    // Liveness detection and bounded reconnect retries may add another 150s.
    vi.setSystemTime(startedAt + (10 * 60 + 150) * 1000)
    expect(await getOverlayDemoEvent('streamer-1', cursor)).toEqual(event)

    // The latest-value fallback remains bounded and disappears after 15m.
    vi.setSystemTime(startedAt + 15 * 60 * 1000 + 1)
    expect(await getOverlayDemoEvent('streamer-1', cursor)).toBeNull()
  })

  it('configures the shared KV fallback with the same bounded 15-minute TTL', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mockGetCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    } as never)
    const event = createOverlayDemoEvent(CARD)

    await storeOverlayDemoEvent('streamer-1', event)

    expect(put).toHaveBeenCalledWith(
      'overlay:demo:streamer-1',
      JSON.stringify(event),
      { expirationTtl: 15 * 60 }
    )
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
