import { NextResponse } from 'next/server'
import { isValidStreamerId } from '@/lib/overlay-realtime/contract'
import { resolveOverlayRealtimeConfig } from '@/lib/overlay-realtime/resolve-config'

interface RouteParams {
  params: Promise<{ streamerId: string }>
}

/**
 * Public runtime configuration for an OBS browser source.
 *
 * The endpoint contains no token or stable viewer identity. Operators can
 * change mode/allowlist through Worker secrets without rebuilding old OBS
 * pages, which is the kill switch required to fall back to polling-only during
 * a Durable Objects incident.
 *
 * Connected overlays no longer poll this endpoint on their own timer: the
 * events endpoint echoes `realtimeConfigVersion` on every pass a client already
 * makes, and the client refetches here only when that value changes. This
 * endpoint is therefore a startup + change-triggered read.
 *
 * The short cache TTL is deliberately kept. A longer TTL would risk serving a
 * pre-change config to the very refetch that a detected change triggered; the
 * traffic saving comes from removing the timer, not from caching.
 */
export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  const { streamerId } = await params
  if (!isValidStreamerId(streamerId)) {
    return NextResponse.json({ error: 'Invalid streamer ID' }, { status: 400 })
  }

  return NextResponse.json(resolveOverlayRealtimeConfig(streamerId), {
    headers: {
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=15',
    },
  })
}
