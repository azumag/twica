import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { logger } from './logger'
import { reportRealtimeError } from './sentry/error-handler'
import { getSupabaseElevatedKey, getSupabasePublicKey } from './supabase/keys'

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

const GACHA_CHANNEL_CONFIG = {
  config: {
    private: true,
  },
} as const

function getSupabaseRealtimeClient(): SupabaseClient {
  if (supabaseRealtime) {
    return supabaseRealtime
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const isBrowser = typeof window !== 'undefined'
  // Browser subscriptions must use public keys. Server-side broadcast can use
  // the elevated secret/service_role key, falling back to the public key for
  // local/dev environments where the server key is not configured.
  const supabaseKey = isBrowser
    ? getSupabasePublicKey()
    : getSupabaseElevatedKey() || getSupabasePublicKey()

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
  cards?: Array<{
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: string
  }>
  userTwitchUsername: string
  rewardId?: string | null
}

export interface RealtimeError {
  type: 'connection' | 'subscription' | 'broadcast' | 'unknown'
  message: string
  error: unknown
  isExpected?: boolean
}

// 接続中の一時的なステータス（エラーではない）
// Temporary statuses during connection (not errors)
const CONNECTING_STATUSES = ['SUBSCRIBING']

// 正常な切断ステータス（エラーではない）
// Expected close statuses (not errors)
const EXPECTED_CLOSE_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

export async function broadcastGachaResult(
  streamerId: string,
  payload: GachaBroadcastPayload,
  options: { maxRetries?: number; retryDelay?: number } = {}
): Promise<void> {
  const { maxRetries = 3, retryDelay = 1000 } = options

  // getSupabaseRealtimeClient() や client.channel() がリトライループ前に throw する可能性がある
  // （環境変数不正、クライアント初期化失敗など）。これらのエラーも try/catch 内に含め、
  // throw せずに warn ログに留めることで「ガチャ成功・ブロードキャスト失敗」の設計を維持する。
  // 呼び出し元の外側 catch がガチャ全体の致命的エラーと誤認するのを防止する。
  // Issue #359-#365: Codex review P2 "Restore local catch around broadcast call" 対応
  let client: ReturnType<typeof getSupabaseRealtimeClient>
  let channel: ReturnType<ReturnType<typeof getSupabaseRealtimeClient>['channel']>
  try {
    client = getSupabaseRealtimeClient()
    channel = client.channel(`gacha:${streamerId}`, GACHA_CHANNEL_CONFIG)
  } catch (initError) {
    logger.warn(`[Broadcast] Failed to initialize realtime client for streamer ${streamerId}`, {
      error: initError instanceof Error ? initError.message : String(initError),
    })
    // throw しない: ガチャ処理の成否に影響しない
    return
  }

  try {
    let attemptCount = 0
    while (attemptCount <= maxRetries) {
      try {
        // httpSend() を明示的に使用し REST API 経由で送信 (Issue #222)
        // サーバーサイド(Cloudflare Workers)ではWebSocket不要のため、
        // send() の自動フォールバック（deprecated）を回避する
        const result = await channel.httpSend('gacha_result', payload)
        if (!result.success) {
          throw new Error(`Broadcast HTTP send failed: ${result.status} ${result.error}`)
        }
        return
      } catch (error) {
        attemptCount++
        logger.warn(`Broadcast attempt ${attemptCount}/${maxRetries} failed:`, error)

        if (attemptCount > maxRetries) {
          // ブロードキャスト失敗はガチャ処理自体に影響しない（OBSオーバーレイへの通知のみ）
          // 一時的な502/タイムアウトで大量のGitHub Issueが作成されるのを防ぐため、
          // reportRealtimeError ではなく warn ログに留める (Issue #359-#365)
          logger.warn(`[Broadcast] Failed after ${maxRetries} retries for streamer ${streamerId}`, {
            error: error instanceof Error ? error.message : String(error),
            retryCount: attemptCount - 1,
          })
          // throw しない: 呼び出し元(eventsub/gacha API)でのreportErrorによる重複Issue化を防止
          return
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
  // Defaults to unlimited retries for long-lived OBS browser sources.
  // Pass a finite number only when the caller wants to stop reconnecting.
  maxRetries?: number
  retryDelay?: number
  onError?: (error: RealtimeError) => void
  onSuccess?: () => void
  // デバッグ用：接続ステータスの変化を追跡するコールバック
  // OBSブラウザソースでの接続問題を調査するために使用
  onStatusChange?: (status: string) => void
}

export function subscribeToGachaResults(
  streamerId: string,
  callback: (payload: GachaBroadcastPayload) => void,
  options: SubscribeOptions = {}
): () => void {
  const {
    maxRetries = Number.POSITIVE_INFINITY,
    retryDelay = 3000,
    onError,
    onSuccess,
    onStatusChange,
  } = options

  let client: SupabaseClient | null = null
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  let retryCount = 0
  let isDisposed = false
  let retryTimeout: ReturnType<typeof setTimeout> | null = null
  let subscriptionGeneration = 0

  const hasRetryLimit = Number.isFinite(maxRetries)

  const cleanup = () => {
    isDisposed = true
    subscriptionGeneration++
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    if (channel) {
      client?.removeChannel(channel)
      channel = null
    }
  }

  const subscribe = () => {
    if (isDisposed) {
      return
    }

    subscriptionGeneration++
    const currentGeneration = subscriptionGeneration

    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }

    // リトライ時に前回のチャネルをクリーンアップ
    // 古いチャネルのコールバックが残るとretryCountが想定より早く増加するため
    // Clean up previous channel before creating a new one to prevent
    // stale callbacks from incrementing retryCount unexpectedly
    if (channel && client) {
      try {
        client.removeChannel(channel)
      } catch {
        // クリーンアップ失敗は非致命的、ログのみ
        logger.info(`Previous channel cleanup for gacha:${streamerId}`)
      }
      channel = null
    }

    // デバッグ用：サブスクリプション開始を通知
    onStatusChange?.('INITIALIZING')

    try {
      client = getSupabaseRealtimeClient()
      onStatusChange?.('CLIENT_CREATED')
      channel = client.channel(`gacha:${streamerId}`, GACHA_CHANNEL_CONFIG)
      onStatusChange?.('CHANNEL_CREATED')

      channel
        .on('broadcast', { event: 'gacha_result' }, (payload) => {
          if (isDisposed || currentGeneration !== subscriptionGeneration) {
            return
          }

          try {
            callback(payload.payload as GachaBroadcastPayload)
          } catch (error) {
            logger.error(`Error processing gacha result payload:`, error)
            // クライアントサイドの同期コールバック内のため await 不可
            // .catch() でunhandled promise rejectionを防止
            void reportRealtimeError(error, {
              action: 'process_payload',
              streamerId,
            }).catch(e => console.warn('[Error Tracking] Failed to report:', e))
          }
        })
        .subscribe((status, err) => {
          // デバッグ用：すべてのステータス変化を通知
          // OBSブラウザソースでの接続問題を調査するために使用
          if (isDisposed || currentGeneration !== subscriptionGeneration) {
            return
          }

          onStatusChange?.(`SUBSCRIBE_STATUS: ${status}`)

          if (status === 'SUBSCRIBED') {
            retryCount = 0
            logger.info(`Successfully subscribed to gacha:${streamerId}`)
            onSuccess?.()
          } else if (CONNECTING_STATUSES.includes(status)) {
            // 接続中の一時的なステータス（リトライカウントを増やさない）
            // Temporary connecting status - don't count as error
            logger.info(`Connection in progress for gacha:${streamerId}, status: ${status}`)
            onStatusChange?.(`CONNECTING: ${status}`)
          } else {
            const isExpected = EXPECTED_CLOSE_STATUSES.includes(status)

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
              // クライアントサイドの同期コールバック内のため await 不可
              void reportRealtimeError(err, {
                action: 'subscribe',
                streamerId,
                status,
                retryCount,
              }).catch(e => console.warn('[Error Tracking] Failed to report:', e))
            }

            onError?.(error)

            if (!hasRetryLimit || retryCount < maxRetries) {
              retryCount++
              const delay = getRetryDelay(retryCount, retryDelay)
              const retryLabel = hasRetryLimit ? `${retryCount}/${maxRetries}` : `${retryCount}`
              logger.info(`Retrying connection (attempt ${retryLabel}) in ${Math.round(delay)}ms...`)
              retryTimeout = setTimeout(subscribe, delay)
            } else {
              logger.warn(`Max retries (${maxRetries}) reached for gacha:${streamerId}`)
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
      // 同期関数 subscribe() 内のため await 不可
      void reportRealtimeError(error, {
        action: 'subscribe',
        streamerId,
      }).catch(e => console.warn('[Error Tracking] Failed to report:', e))

      const realtimeError: RealtimeError = {
        type: 'subscription',
        message: 'Failed to subscribe to realtime channel',
        error,
      }

      onError?.(realtimeError)

      if (!hasRetryLimit || retryCount < maxRetries) {
        retryCount++
        const delay = getRetryDelay(retryCount, retryDelay)
        retryTimeout = setTimeout(subscribe, delay)
      }
    }
  }

  subscribe()

  return cleanup
}
