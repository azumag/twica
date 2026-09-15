import { type NextRequest, NextResponse } from 'next/server'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'
import {
  DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE,
  DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE,
  MAX_MULTI_DRAW_CHAT_CHUNK_SIZE,
  MIN_MULTI_DRAW_CHAT_CHUNK_SIZE,
  MULTI_DRAW_CHAT_DELIVERY_MODES,
  type MultiDrawChatDeliveryMode,
} from '@/lib/twitch/multi-draw-chat'

type SettingsRow = {
  streamer_id: string
  delivery_mode: MultiDrawChatDeliveryMode | null
  chunk_size: number | null
}

async function getOwnedSettings(twitchUserId: string): Promise<SettingsRow | null> {
  return withDbRetry(async () => {
    const { sql } = await getDb()
    const rows = await sql<SettingsRow[]>`
      select
        s.id as streamer_id,
        settings.delivery_mode,
        settings.chunk_size
      from streamers s
      left join streamer_chat_multi_delivery_settings settings
        on settings.streamer_id = s.id
      where s.twitch_user_id = ${twitchUserId}
      limit 1
    `
    return rows[0] ?? null
  }, 'chat multi delivery settings lookup', { idempotent: true })
}

async function saveOwnedSettings(
  streamerId: string,
  deliveryMode: MultiDrawChatDeliveryMode,
  chunkSize: number,
): Promise<void> {
  await withDbRetry(async () => {
    const { sql } = await getDb()
    await sql`
      insert into streamer_chat_multi_delivery_settings (
        streamer_id, delivery_mode, chunk_size, updated_at
      ) values (
        ${streamerId}::uuid, ${deliveryMode}, ${chunkSize}::integer, now()
      )
      on conflict (streamer_id) do update
      set delivery_mode = excluded.delivery_mode,
          chunk_size = excluded.chunk_size,
          updated_at = now()
    `
  }, 'chat multi delivery settings upsert', { idempotent: true })
}

async function authorizeAndRateLimit(request: NextRequest) {
  const session = await getSession()
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
  const limit = await checkRateLimit(rateLimits.streamerSettings, identifier)
  if (!limit.success) {
    return {
      response: NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(limit.limit),
            'X-RateLimit-Remaining': String(limit.remaining),
            'X-RateLimit-Reset': String(limit.reset),
          },
        },
      ),
      session: null,
    }
  }
  if (!session || !canUseStreamerFeatures(session)) {
    return {
      response: NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 }),
      session: null,
    }
  }
  return { response: null, session }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeAndRateLimit(request)
  if (auth.response || !auth.session) return auth.response

  try {
    const row = await getOwnedSettings(auth.session.twitchUserId)
    if (!row) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 })
    }
    return NextResponse.json({
      deliveryMode: row.delivery_mode ?? DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE,
      chunkSize: row.chunk_size ?? DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE,
      intervalMs: 1600,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) return contentTypeValidation

  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
  }

  const auth = await authorizeAndRateLimit(request)
  if (auth.response || !auth.session) return auth.response

  try {
    const body = await request.json() as { deliveryMode?: unknown; chunkSize?: unknown }
    if (
      typeof body.deliveryMode !== 'string'
      || !(MULTI_DRAW_CHAT_DELIVERY_MODES as readonly string[]).includes(body.deliveryMode)
    ) {
      return NextResponse.json({ error: 'Invalid deliveryMode' }, { status: 400 })
    }
    if (
      !Number.isInteger(body.chunkSize)
      || Number(body.chunkSize) < MIN_MULTI_DRAW_CHAT_CHUNK_SIZE
      || Number(body.chunkSize) > MAX_MULTI_DRAW_CHAT_CHUNK_SIZE
    ) {
      return NextResponse.json({ error: 'Invalid chunkSize' }, { status: 400 })
    }

    const row = await getOwnedSettings(auth.session.twitchUserId)
    if (!row) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 })
    }
    const deliveryMode = body.deliveryMode as MultiDrawChatDeliveryMode
    const chunkSize = Number(body.chunkSize)
    await saveOwnedSettings(row.streamer_id, deliveryMode, chunkSize)
    return NextResponse.json({ success: true, deliveryMode, chunkSize, intervalMs: 1600 })
  } catch {
    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
  }
}
