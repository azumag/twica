import { NextResponse } from 'next/server'
import {
  OVERLAY_REALTIME_PROTOCOL_VERSION,
  type OverlayRealtimeConfigV1,
  isOverlayRealtimeStreamerEnabled,
  isValidStreamerId,
} from '@/lib/overlay-realtime/contract'

interface RouteParams {
  params: Promise<{ streamerId: string }>
}

function websocketBaseUrl(): string | null {
  const raw = process.env.OVERLAY_REALTIME_WS_URL
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return null
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Public runtime configuration for an OBS browser source.
 *
 * The endpoint contains no token or stable viewer identity. Operators can
 * change mode/allowlist through Worker secrets without rebuilding old OBS
 * pages, which is the kill switch required to fall back to polling-only during
 * a Durable Objects incident.
 */
export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  const { streamerId } = await params
  if (!isValidStreamerId(streamerId)) {
    return NextResponse.json({ error: 'Invalid streamer ID' }, { status: 400 })
  }

  const baseUrl = websocketBaseUrl()
  const doEnabled =
    isOverlayRealtimeStreamerEnabled(
      process.env.OVERLAY_REALTIME_MODE,
      process.env.OVERLAY_REALTIME_STREAMER_ALLOWLIST,
      streamerId
    )
    && baseUrl !== null

  const config: OverlayRealtimeConfigV1 = {
    schemaVersion: 1,
    mode: doEnabled ? 'do-primary' : 'polling-only',
    ...(doEnabled ? { webSocketUrl: baseUrl } : {}),
    protocolVersion: OVERLAY_REALTIME_PROTOCOL_VERSION,
    retryPolicy: {
      baseDelayMs: 500,
      maxDelayMs: 30_000,
    },
    // This value changes with the effective public config and is deliberately
    // free of secret material. Clients use it only for diagnostics/reload.
    configVersion: doEnabled ? 'do-primary-v1' : 'polling-only-v1',
  }

  return NextResponse.json(config, {
    headers: {
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=15',
    },
  })
}
