import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { logger } from './logger'
import { reportRealtimeError } from './sentry/error-handler'

/*
 * Supabase Realtime Connection Lifecycle
 * ========================================
 * 
 * Expected Connection Statuses (Normal, Not Errors):
 * - SUBSCRIBED: Successfully connected and subscribed
 * - CLOSED: Connection closed normally (cleanup, page navigation)
 * - TIMED_OUT: Connection timed out during idle periods
 * - CHANNEL_ERROR: Channel-specific errors (handled gracefully)
 *
 * These statuses are part of normal WebSocket lifecycle and do not indicate
 * application errors. They are logged at INFO level for debugging purposes.
 *
 * Actual Errors (Reported to Sentry):
 * - Repeated connection failures beyond max retries
 * - Unexpected error messages
 * - Subscription failures that prevent functionality
 *
 * Note: Browser console may show "Connection closed" messages during page
 * transitions or cleanup. This is expected behavior and does not affect
 * application functionality.
 */

let supabaseRealtime: SupabaseClient | null = null

function getSupabaseRealtimeClient(): SupabaseClient {
  if (supabaseRealtime) {
    return supabaseRealtime
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    if (process.env.CI || process.env.NODE_ENV === 'test') {
      throw new Error('Realtime not available in CI/test environment')
    } else {
      throw new Error('Missing Supabase environment variables for realtime')
    }
  }

  supabaseRealtime = createClient(supabaseUrl, supabaseKey, {
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  })

  return supabaseRealtime
}

export interface GachaBroadcastPayload {
  type: 'gacha'
  card: {
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: string
  }
  userTwitchUsername: string
}

export interface RealtimeError {
  type: 'connection' | 'subscription' | 'broadcast' | 'unknown'
  message: string
  error: unknown
  isExpected?: boolean
}

const EXPECTED_CLOSE_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

export async function broadcastGachaResult(
  streamerId: string,
  payload: GachaBroadcastPayload,
  options: { maxRetries?: number; retryDelay?: number } = {}
): Promise<void> {
  const { maxRetries = 3, retryDelay = 1000 } = options
  const client = getSupabaseRealtimeClient()
  const channel = client.channel(`gacha:${streamerId}`)

  try {
    let attemptCount = 0
    while (attemptCount <= maxRetries) {
      try {
        await channel.send({
          type: 'broadcast',
          event: 'gacha_result',
          payload,
        })
        return
      } catch (error) {
        attemptCount++
        logger.warn(`Broadcast attempt ${attemptCount}/${maxRetries} failed:`, error)

        if (attemptCount > maxRetries) {
          logger.error(`Failed to broadcast gacha result for streamer ${streamerId} after ${maxRetries} attempts:`, error)
          reportRealtimeError(error, {
            action: 'broadcast',
            streamerId,
            retryCount: attemptCount - 1,
          })
          throw error
        }

        const delay = attemptCount * retryDelay
        logger.info(`Retrying broadcast in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  } finally {
    try {
      client.removeChannel(channel)
    } catch {
      logger.info(`Channel cleanup completed for streamer ${streamerId}`)
    }
  }
}

const getRetryDelay = (retryCount: number, baseDelay: number): number => {
  const backoffDelay = Math.min(baseDelay * Math.pow(2, retryCount), 30000)
  const jitter = Math.random() * 1000
  return backoffDelay + jitter
}

export interface SubscribeOptions {
  maxRetries?: number
  retryDelay?: number
  onError?: (error: RealtimeError) => void
  onSuccess?: () => void
}

export function subscribeToGachaResults(
  streamerId: string,
  callback: (payload: GachaBroadcastPayload) => void,
  options: SubscribeOptions = {}
): () => void {
  const {
    maxRetries = 5,
    retryDelay = 3000,
    onError,
    onSuccess,
  } = options

  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  let retryCount = 0
  let isSubscribed = false
  let retryTimeout: ReturnType<typeof setTimeout> | null = null

  const cleanup = () => {
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    if (channel && isSubscribed) {
      client?.removeChannel(channel)
      isSubscribed = false
    }
  }

  const subscribe = () => {
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }

    try {
      client = getSupabaseRealtimeClient()
      channel = client.channel(`gacha:${streamerId}`)

      channel
        .on('broadcast', { event: 'gacha_result' }, (payload) => {
          try {
            callback(payload.payload as GachaBroadcastPayload)
          } catch (error) {
            logger.error(`Error processing gacha result payload:`, error)
            reportRealtimeError(error, {
              action: 'process_payload',
              streamerId,
            })
          }
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            isSubscribed = true
            retryCount = 0
            logger.info(`Successfully subscribed to gacha:${streamerId}`)
            onSuccess?.()
          } else {
            const isExpected = EXPECTED_CLOSE_STATUSES.includes(status)
            isSubscribed = false

            const error: RealtimeError = {
              type: 'connection',
              message: `Realtime connection issue: ${status}`,
              error: err,
              isExpected,
            }

            if (isExpected) {
              logger.info(`Expected connection closure for gacha:${streamerId}, status: ${status}`)
            } else {
              logger.warn(`Connection issue for gacha:${streamerId}, status: ${status}`)
              reportRealtimeError(err, {
                action: 'subscribe',
                streamerId,
                status,
                retryCount,
              })
            }

            onError?.(error)

            if (retryCount < maxRetries) {
              retryCount++
              const delay = getRetryDelay(retryCount, retryDelay)
              logger.info(`Retrying connection (attempt ${retryCount}/${maxRetries}) in ${Math.round(delay)}ms...`)
              retryTimeout = setTimeout(subscribe, delay)
            } else {
              logger.error(`Max retries (${maxRetries}) reached for gacha:${streamerId}`)
              const maxRetriesError: RealtimeError = {
                type: 'connection',
                message: 'Max retries reached. Please refresh the page to reconnect.',
                error: null,
                isExpected: false,
              }
              onError?.(maxRetriesError)
            }
          }
        })
    } catch (error) {
      logger.error(`Failed to subscribe to gacha:${streamerId}:`, error)
      reportRealtimeError(error, {
        action: 'subscribe',
        streamerId,
      })

      const realtimeError: RealtimeError = {
        type: 'subscription',
        message: 'Failed to subscribe to realtime channel',
        error,
      }

      onError?.(realtimeError)

      if (retryCount < maxRetries) {
        retryCount++
        const delay = getRetryDelay(retryCount, retryDelay)
        retryTimeout = setTimeout(subscribe, delay)
      }
    }
  }

  subscribe()

  return cleanup
}
