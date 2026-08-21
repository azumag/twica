import { createPublishSignature } from '@/lib/overlay-realtime/signature'

const PRESENCE_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000

/**
 * Mint the capability embedded in an authenticated streamer's OBS overlay URL.
 *
 * The realtime Worker and the app Worker share the publish secret at runtime.
 * Reading the binding first keeps secret rotation effective without a rebuild;
 * process.env is retained only for local development and tests. A missing
 * secret deliberately disables presence reporting while leaving the overlay's
 * existing polling/DO delivery path available.
 */
export async function createOverlayPresenceToken(
  streamerId: string
): Promise<string | null> {
  let secret: string | undefined
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    const runtimeSecret = (env as unknown as Record<string, unknown>)
      .OVERLAY_REALTIME_PUBLISH_SECRET
    secret = typeof runtimeSecret === 'string' && runtimeSecret.length > 0
      ? runtimeSecret
      : undefined
  } catch {
    if (process.env.NODE_ENV === 'production') return null
    secret = process.env.OVERLAY_REALTIME_PUBLISH_SECRET
  }
  if (!secret) return null

  const expiresAt = Date.now() + PRESENCE_TOKEN_TTL_MS
  const expiresAtRaw = String(expiresAt)
  const nonce = crypto.randomUUID()
  const signature = await createPublishSignature(
    secret,
    `/v1/rooms/${streamerId}/connect`,
    '',
    expiresAtRaw,
    nonce
  )
  return `${expiresAtRaw}.${nonce}.${signature}`
}
