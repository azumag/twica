/**
 * Supabase Query Retry Utility
 * Supabaseクエリのリトライユーティリティ (Issue #339, #326, #325)
 *
 * Supabase PostgREST が一時的に 502/503 を返す場合に指数バックオフでリトライする。
 * Cloudflare Workers 環境でのネットワーク一時障害に対応。
 */

import { logger } from '@/lib/logger'

interface RetryOptions {
  maxRetries?: number
  /** バックオフ遅延（ミリ秒）: [100, 300, 1000] */
  delays?: number[]
}

const DEFAULT_DELAYS = [100, 300, 1000]

// 502/503 はインフラ一時障害のためリトライ対象
const RETRYABLE_STATUS_CODES = [502, 503]

// Supabase/PostgREST が返すエラーメッセージのテキストパターン
// ステータスコード数字が含まれない場合（"Bad Gateway" 等）にも対応
const RETRYABLE_MESSAGE_PATTERNS = ['bad gateway', 'service unavailable']

/**
 * Supabase クエリ結果に対するリトライラッパー
 * { data, error } 形式のレスポンスで 502/503 相当のエラーの場合にリトライする。
 * ステータスコード数字・テキストメッセージの両方でマッチする。
 *
 * @param queryFn - Supabase クエリを返す関数（await前のPromiseを返す）
 * @param context - ログ用コンテキスト文字列
 * @param options - リトライオプション
 */
export async function withRetry<T extends { error: { message: string; code?: string } | null }>(
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

    // ステータスコード数字またはテキストパターンでリトライ判定
    const msg = result.error!.message.toLowerCase()
    const isRetryable =
      RETRYABLE_STATUS_CODES.some(code =>
        msg.includes(`${code}`) || result.error!.code === `${code}`
      ) ||
      RETRYABLE_MESSAGE_PATTERNS.some(pattern => msg.includes(pattern))

    if (!isRetryable || attempt === maxRetries) {
      return result
    }

    const delay = delays[Math.min(attempt, delays.length - 1)]
    logger.warn(`[Supabase Retry] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
      error: result.error.message,
    })
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  // 到達しないが型安全のため
  return queryFn() as Promise<T>
}
