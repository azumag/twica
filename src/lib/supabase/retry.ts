/**
 * Supabase Query Retry Utility
 * Supabaseクエリのリトライユーティリティ (Issue #339, #326, #325, #645, #646)
 *
 * Supabase PostgREST が一時的な5xxを返す場合に指数バックオフでリトライする。
 * Cloudflare Workers 環境でのネットワーク・SSLハンドシェイク一時障害に対応。
 */

import { logger } from '@/lib/logger'

interface RetryOptions {
  maxRetries?: number
  /** バックオフ遅延（ミリ秒）: [100, 300, 1000] */
  delays?: number[]
}

const DEFAULT_DELAYS = [100, 300, 1000]

// 500/502/503 は上流インフラ障害、522 は接続タイムアウト、525 はSSL handshake失敗のためリトライ対象
const RETRYABLE_STATUS_CODES = [500, 502, 503, 522, 525]

// Supabase/PostgREST/Cloudflare が返すエラーメッセージのテキストパターン
// ステータスコード数字が含まれない場合にも対応
const RETRYABLE_MESSAGE_PATTERNS = [
  'internal server error',
  'bad gateway',
  'service unavailable',
  'connection timed out',
  'ssl handshake failed',
]

/**
 * Supabase クエリ結果に対するリトライラッパー
 * { data, error } 形式のレスポンスで一時的な5xx相当のエラーの場合にリトライする。
 * ステータスコード数字・テキストメッセージの両方でマッチする。
 *
 * @param queryFn - Supabase クエリを返す関数（await前のPromiseを返す）
 * @param context - ログ用コンテキスト文字列
 * @param options - リトライオプション
 */
export async function withRetry<T extends { status?: number; statusText?: string; error: { message: string; code?: string } | null }>(
  queryFn: () => PromiseLike<T>,
  context: string,
  options?: RetryOptions,
): Promise<T> {
  const delays = options?.delays ?? DEFAULT_DELAYS
  const maxRetries = options?.maxRetries ?? delays.length

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await queryFn()

    if (!result.error) {
      return result
    }

    // HTTPステータスコード（PostgrestResponseBase.status）を最優先でチェック
    // error.message/code のテキストパターンはフォールバックとして残す
    const hasRetryableStatus = typeof result.status === 'number' && RETRYABLE_STATUS_CODES.includes(result.status)
    const msg = result.error.message.toLowerCase()
    const hasRetryableMessage =
      RETRYABLE_STATUS_CODES.some(code =>
        msg.includes(`${code}`) || result.error!.code === `${code}`
      ) ||
      RETRYABLE_MESSAGE_PATTERNS.some(pattern => msg.includes(pattern))
    const isRetryable = hasRetryableStatus || hasRetryableMessage

    if (!isRetryable || attempt === maxRetries) {
      return result
    }

    const delay = delays[Math.min(attempt, delays.length - 1)]
    logger.warn(`[Supabase Retry] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
      status: result.status,
      error: result.error.message,
    })
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  // 到達しないが型安全のため
  return queryFn() as Promise<T>
}
