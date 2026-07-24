import { NextRequest, NextResponse } from 'next/server'
import { getOverlayDemoEvent } from '@/lib/overlay/demo-event-store'
import { ERROR_MESSAGES } from '@/lib/constants'
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from '@/lib/rate-limit'
import type { ApiRateLimitResponse } from '@/types/api'

interface RouteParams {
  params: Promise<{ streamerId: string }>
}

function normalizeSince(value: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
}

/**
 * Poll the latest short-lived OBS demo event.
 *
 * Real gacha events continue to come from the PlanetScale-backed `/events`
 * endpoint. Keeping demos separate prevents their current timestamp from
 * advancing the authoritative gacha_history cursor and skipping a concurrent
 * real redemption. It shares the overlay event limiter, so the two 3-second
 * polling requests remain inside one bounded per-IP budget.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const identifier = await getRateLimitIdentifier(request)
  const rateLimitResult = await checkRateLimit(rateLimits.overlayEventsGet, identifier)
  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
      },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        },
      }
    )
  }

  const { streamerId } = await params
  if (!streamerId) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
      { status: 400, headers: NO_STORE_HEADERS }
    )
  }

  const since = normalizeSince(new URL(request.url).searchParams.get('since'))
  if (!since) {
    return NextResponse.json(
      { error: 'Invalid since parameter' },
      { status: 400, headers: NO_STORE_HEADERS }
    )
  }

  const event = await getOverlayDemoEvent(streamerId, since)
  return NextResponse.json({ event }, { headers: NO_STORE_HEADERS })
}
