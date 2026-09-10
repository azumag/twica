import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportOverlayPollingPresence } from '@/lib/overlay-realtime/polling-presence'

const mocks = vi.hoisted(() => ({ context: vi.fn(), fetch: vi.fn(), waitUntil: vi.fn() }))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: mocks.context }))
const streamerId = '123e4567-e89b-42d3-a456-426614174000'

describe('polling presence forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetch.mockResolvedValue(Response.json({ accepted: true }, { status: 202 }))
    mocks.context.mockResolvedValue({ env: { OVERLAY_REALTIME_SERVICE: { fetch: mocks.fetch } }, ctx: { waitUntil: mocks.waitUntil } })
  })

  it('does no extra work for tokenless previews or oversized capabilities', async () => {
    await reportOverlayPollingPresence(streamerId, null)
    await reportOverlayPollingPresence(streamerId, 'a'.repeat(257))
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('uses the binding in the background and keeps capabilities out of URLs', async () => {
    await reportOverlayPollingPresence(streamerId, 'test-capability')
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1)
    await mocks.waitUntil.mock.calls[0][0]
    const request = mocks.fetch.mock.calls[0][0] as Request
    expect(request.url).toBe(`https://overlay-realtime/internal/v1/rooms/${streamerId}/presence`)
    expect(request.headers.get('x-twica-presence')).toBe('test-capability')
    expect(request.signal).toBeDefined()
  })

  it('returns while a presence report is still pending', async () => {
    let finish!: (response: Response) => void
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    await reportOverlayPollingPresence(streamerId, 'test-capability')
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1)
    finish(Response.json({ accepted: true }))
    await mocks.waitUntil.mock.calls[0][0]
  })

  it('does not block history on a missing binding or rejected report', async () => {
    mocks.context.mockResolvedValueOnce({ env: {}, ctx: {} })
    await expect(reportOverlayPollingPresence(streamerId, 'test-capability')).resolves.toBeUndefined()
    mocks.fetch.mockRejectedValueOnce(new Error('unavailable'))
    await reportOverlayPollingPresence(streamerId, 'test-capability')
    await expect(mocks.waitUntil.mock.calls[0][0]).resolves.toBeUndefined()
  })
})
