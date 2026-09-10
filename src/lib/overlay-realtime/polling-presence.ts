import 'server-only'
import { isValidStreamerId, OVERLAY_REALTIME_PRESENCE_TOKEN_MAX_LENGTH } from './contract'

/**
 * Forward a capability carried by an existing, rate-limited history request.
 * No DB/Helix calls, public token issuance, or independent browser heartbeat.
 * The realtime Worker verifies the capability and coalesces reports per room;
 * this optional task must never delay or fail committed event delivery.
 */
export async function reportOverlayPollingPresence(streamerId: string, token: string | null): Promise<void> {
  if (!isValidStreamerId(streamerId) || !token || token.length > OVERLAY_REALTIME_PRESENCE_TOKEN_MAX_LENGTH) return
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env, ctx } = await getCloudflareContext({ async: true })
    const service = (env as unknown as {
      OVERLAY_REALTIME_SERVICE?: { fetch(request: Request): Promise<Response> }
    }).OVERLAY_REALTIME_SERVICE
    if (!service) return
    const task = (async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2_000)
      try {
        const response = await service.fetch(new Request(
          `https://overlay-realtime/internal/v1/rooms/${streamerId}/presence`,
          { method: 'POST', headers: { 'x-twica-presence': token }, signal: controller.signal },
        ))
        await response.body?.cancel()
      } catch {
        // Presence failures are auxiliary. Do not log capability-bearing requests.
      } finally {
        clearTimeout(timeout)
      }
    })()
    ctx.waitUntil(task)
  } catch {
    // No Cloudflare binding during local development or a staged rollout.
  }
}
