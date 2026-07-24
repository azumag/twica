import 'server-only'

import { logger } from '@/lib/logger.server'

/**
 * Register an already-started task with Cloudflare's request lifetime.
 *
 * The caller passes a Promise rather than a callback so DB/publish work starts
 * immediately. Production uses `ctx.waitUntil()` and can return the HTTP
 * response without waiting; local/Node runtimes fall back to awaiting so tests
 * and development never create an unhandled, abruptly-terminated task.
 */
export async function runInBackground(
  label: string,
  task: Promise<unknown>
): Promise<void> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { ctx } = await getCloudflareContext({ async: true })
    ctx.waitUntil(task)
  } catch (error) {
    logger.warn(
      `[background-task] waitUntil unavailable (${label}), falling back to sync`,
      { error: error instanceof Error ? error.message : String(error) }
    )
    await task
  }
}
