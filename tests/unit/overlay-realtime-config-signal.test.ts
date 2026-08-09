import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as getRealtimeConfig } from '@/app/api/overlay/[streamerId]/realtime-config/route'
import {
  resolveOverlayRealtimeConfig,
  resolveOverlayRealtimeConfigVersion,
  resolveOverlayRealtimeEnabled,
} from '@/lib/overlay-realtime/resolve-config'

const STREAMER_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_STREAMER_ID = '223e4567-e89b-42d3-a456-426614174000'

function params(streamerId = STREAMER_ID) {
  return { params: Promise.resolve({ streamerId }) }
}

/**
 * The overlay stopped polling the config endpoint on its own timer and instead
 * reacts to the `realtimeConfigVersion` echoed by the events endpoint.
 *
 * That only works if the version the events endpoint reports is always exactly
 * the version the config endpoint would return. If the two could disagree, a
 * connected overlay would refetch the config on every polling pass forever, so
 * the invariant is fixed here rather than left to review.
 */
describe('overlay realtime config change signal', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function enableFor(streamerId: string) {
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', streamerId)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime.example')
  }

  it('reports the same version from the events signal resolver and config route', async () => {
    enableFor(STREAMER_ID)
    const eventsSignalVersion = resolveOverlayRealtimeConfigVersion(STREAMER_ID)
    const response = await getRealtimeConfig(
      new Request('https://app.example/config'),
      params()
    )
    const config = await response.json()

    expect(config.configVersion).toBe(eventsSignalVersion)
    // Pin the canonical tuple and FNV generation format so an unchanged public
    // config remains stable across independently deployed Worker processes.
    expect(eventsSignalVersion).toBe('do-primary-v2-338ed91465e81b6b')
  })

  it('reports the same version the full config carries when not allowlisted', () => {
    enableFor(OTHER_STREAMER_ID)
    expect(resolveOverlayRealtimeConfigVersion(STREAMER_ID)).toBe(
      resolveOverlayRealtimeConfig(STREAMER_ID).configVersion
    )
    expect(resolveOverlayRealtimeConfigVersion(STREAMER_ID)).toBe('polling-only-v1')
  })

  it('changes version when the operator flips the allowlist', () => {
    enableFor(STREAMER_ID)
    const enabled = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    // Kill switch: the streamer is dropped from the allowlist.
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', OTHER_STREAMER_ID)
    const disabled = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    expect(enabled).not.toBe(disabled)
    expect(disabled).toBe('polling-only-v1')
  })

  it('changes version when only the effective WebSocket base URL changes', () => {
    enableFor(STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-a.example/path')
    const urlA = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-b.example/path')
    const urlB = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    expect(urlA).not.toBe(urlB)
  })

  it('keeps the same version for the same normalized public config', () => {
    enableFor(STREAMER_ID)
    vi.stubEnv(
      'OVERLAY_REALTIME_WS_URL',
      'https://REALTIME.example:443/first?ignored=one#fragment'
    )
    const first = resolveOverlayRealtimeConfig(STREAMER_ID)

    vi.stubEnv(
      'OVERLAY_REALTIME_WS_URL',
      'https://realtime.example/second?ignored=two'
    )
    const second = resolveOverlayRealtimeConfig(STREAMER_ID)

    expect(first.webSocketUrl).toBe('https://realtime.example')
    expect(second.webSocketUrl).toBe(first.webSocketUrl)
    expect(second.configVersion).toBe(first.configVersion)
  })

  it('keeps the legacy polling-only version across ineffective URL changes', () => {
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'polling-only')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-a.example')
    const urlA = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'https://realtime-b.example')
    const urlB = resolveOverlayRealtimeConfigVersion(STREAMER_ID)

    expect(urlA).toBe('polling-only-v1')
    expect(urlB).toBe(urlA)
  })

  it('degrades to polling-only when the WebSocket URL is missing or insecure', () => {
    vi.stubEnv('OVERLAY_REALTIME_MODE', 'do-primary')
    vi.stubEnv('OVERLAY_REALTIME_STREAMER_ALLOWLIST', STREAMER_ID)

    vi.stubEnv('OVERLAY_REALTIME_WS_URL', '')
    expect(resolveOverlayRealtimeEnabled(STREAMER_ID)).toBe(false)
    expect(resolveOverlayRealtimeConfigVersion(STREAMER_ID)).toBe('polling-only-v1')

    // Telling a client `do-primary` over an insecure endpoint would strand it
    // on the reconnect path, so the resolver must reject it as well.
    vi.stubEnv('OVERLAY_REALTIME_WS_URL', 'http://realtime.example')
    expect(resolveOverlayRealtimeEnabled(STREAMER_ID)).toBe(false)
    expect(resolveOverlayRealtimeConfigVersion(STREAMER_ID)).toBe('polling-only-v1')
  })

  it('never leaks the publish secret through the version signal', () => {
    enableFor(STREAMER_ID)
    vi.stubEnv('OVERLAY_REALTIME_PUBLISH_SECRET', 'must-never-leak')
    expect(resolveOverlayRealtimeConfigVersion(STREAMER_ID)).not.toContain(
      'must-never-leak'
    )
  })
})
