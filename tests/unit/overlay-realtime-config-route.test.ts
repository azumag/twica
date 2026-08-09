import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/overlay/[streamerId]/realtime-config/route'
import { MAX_OVERLAY_VERSION_LENGTH } from '@/lib/overlay-realtime/contract'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'

function params(streamerId = STREAMER_ID) {
  return { params: Promise.resolve({ streamerId }) }
}

describe('overlay realtime runtime config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults safely to polling-only without exposing configuration secrets', async () => {
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', '')
    vi.stubEnv('OVERLAY_REALTIME_PUBLISH_SECRET', 'must-never-leak')
    const response = await GET(new Request('https://app.example/config'), params())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.mode).toBe('polling-only')
    expect(JSON.stringify(body)).not.toContain('must-never-leak')
    expect(response.headers.get('cache-control')).toContain('max-age=15')
  })

  it('enables only an allowlisted room with a secure WebSocket endpoint', async () => {
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime.example/base?secret=no')
    vi.stubEnv('NEXT_PUBLIC_OVERLAY_VERSION', 'build-abc123')
    const response = await GET(new Request('https://app.example/config'), params())
    const body = await response.json()

    expect(body).toMatchObject({
      schemaVersion: 1,
      mode: 'do-primary',
      webSocketUrl: 'https://realtime.example',
      protocolVersion: 1,
      overlayVersion: 'build-abc123',
    })
  })

  it('omits an oversized overlay version instead of reflecting unbounded config', async () => {
    vi.stubEnv(
      'NEXT_PUBLIC_OVERLAY_VERSION',
      'v'.repeat(MAX_OVERLAY_VERSION_LENGTH + 1)
    )

    const response = await GET(new Request('https://app.example/config'), params())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).not.toHaveProperty('overlayVersion')
  })

  it('rejects an invalid public room ID', async () => {
    const response = await GET(
      new Request('https://app.example/config'),
      params('not-a-uuid')
    )
    expect(response.status).toBe(400)
  })
})
