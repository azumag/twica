import { NextRequest, NextResponse } from 'next/server'
import { getOverlayDemoEvent } from '@/lib/overlay/demo-event-store'
import { ERROR_MESSAGES } from '@/lib/constants'

interface RouteParams {
  params: Promise<{ streamerId: string }>
}

function normalizeSince(value: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

/**
 * Poll the latest short-lived OBS demo event.
 *
 * Real gacha events continue to come from the PlanetScale-backed `/events`
 * endpoint. Keeping demos separate prevents their current timestamp from
 * advancing the authoritative gacha_history cursor and skipping a concurrent
 * real redemption.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { streamerId } = await params
  if (!streamerId) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
      { status: 400 }
    )
  }

  const since = normalizeSince(new URL(request.url).searchParams.get('since'))
  if (!since) {
    return NextResponse.json({ error: 'Invalid since parameter' }, { status: 400 })
  }

  const event = await getOverlayDemoEvent(streamerId, since)
  return NextResponse.json({ event })
}
