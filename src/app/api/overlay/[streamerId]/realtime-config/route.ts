import { NextResponse } from 'next/server'
import {
  isValidOverlayVersion,
  isValidStreamerId,
} from '@/lib/overlay-realtime/contract'
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
 * Polling-only overlays and a DO-connected overlay's ten-minute reconciliation
 * learn transport/build changes from `/events`. This lightweight, DB-free
 * endpoint is therefore used at startup and for change-triggered refetches.
 *
 * The short cache TTL is deliberately kept. A longer TTL would risk serving a
 * pre-change config to the very refetch that a detected change triggered; the
 * traffic saving comes from the low reconciliation cadence and eliminating a
 * separate steady-state config poll, not from another application cache layer.
 */
export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  const { streamerId } = await params
  if (!isValidStreamerId(streamerId)) {
    return NextResponse.json({ error: 'Invalid streamer ID' }, { status: 400 })
  }

  const overlayVersion = process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? 'dev'

  return NextResponse.json({
    ...resolveOverlayRealtimeConfig(streamerId),
    // The field remains optional for rolling compatibility. Although this
    // value is build-controlled, apply the same public-contract bound as the
    // browser so a malformed deployment variable is never reflected verbatim.
    ...(isValidOverlayVersion(overlayVersion) ? { overlayVersion } : {}),
  }, {
    headers: {
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=15',
    },
  })
}
