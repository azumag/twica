/**
 * pg ドライバ (postgres.js + Drizzle) 用リトライユーティリティ (#570)
 *
 * 既存の src/lib/supabase/retry.ts（PostgREST の { data, error } 応答向け）の
 * pg ドライバ版。postgres.js はエラーを throw するため、こちらは throw された
 * エラーを分類してリトライする。バックオフ遅延は既存 retry.ts と同じ
 * [100, 300, 1000] ms に揃える（両経路で障害時の挙動を比較しやすくするため）。
 *
 * 重要な規約: リトライ対象の queryFn は「中で getDb() を呼ぶ」こと。
 * Cloudflare Workers ではクライアント（TCP ソケット）がリクエストスコープに
 * 束縛されるため、スコープ破棄由来のエラー（下記 CROSS_REQUEST_IO_MESSAGE）から
 * 回復するにはクライアントの再取得が必要になる。queryFn の外で getDb() した
 * ハンドルを閉じ込めると、リトライしても壊れた同一クライアントを使い続けてしまう。
 *
 *   // OK: リトライごとに getDb() が評価される
 *   await withDbRetry(async () => {
 *     const { db } = await getDb()
 *     return db.select()...
 *   }, 'context', { idempotent: true })
 */

import { logger } from '@/lib/logger'

interface DbRetryOptions {
  /**
   * この文が冪等（何度実行しても結果が同じ: 読み取り・ON CONFLICT DO NOTHING 等）
   * であることの呼び出し元による明示宣言。既定は false。
   */
  idempotent?: boolean
  maxRetries?: number
  /** バックオフ遅延（ミリ秒）: 既定 [100, 300, 1000]（supabase/retry.ts と同一） */
  delays?: number[]
}

const DEFAULT_DELAYS = [100, 300, 1000]

// postgres.js の接続断系エラーコード（err.code）。
// いずれも「クエリが PostgreSQL に到達したか不明」な接続レイヤの障害。
const RETRYABLE_DRIVER_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
])

// Node.js のソケットレイヤのエラーコード（next dev ローカル実行時に発生しうる）。
const RETRYABLE_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
])

// PostgreSQL の一時障害系 SQLSTATE（サーバー側が返す。時間をおけば回復が見込める）。
//   57P01 admin_shutdown / 57P02 crash_shutdown / 57P03 cannot_connect_now
//   53300 too_many_connections
//   08006 connection_failure / 08001 sqlclient_unable_to_establish_sqlconnection /
//   08003 connection_does_not_exist
const RETRYABLE_SQLSTATES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08006',
  '08001',
  '08003',
])

// Cloudflare Workers のリクエストスコープ破棄エラー。
// リクエスト A で作った TCP ソケットをリクエスト B で使うと runtime がこの
// メッセージで throw する。エラーコードは無くメッセージ文字列でしか識別できない。
// クライアント再取得（queryFn 内の getDb() 呼び直し）で回復するためリトライ対象。
const CROSS_REQUEST_IO_MESSAGE = 'Cannot perform I/O on behalf of a different request'

/**
 * throw されたエラーがリトライに値する一時障害かを判定する。
 * 制約違反（23505 等）や構文エラーなどの恒久的エラーは false（リトライ無意味）。
 */
export function isRetryableDbError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) {
    return false
  }

  const code = (e as { code?: unknown }).code
  if (typeof code === 'string') {
    if (
      RETRYABLE_DRIVER_CODES.has(code) ||
      RETRYABLE_NODE_CODES.has(code) ||
      RETRYABLE_SQLSTATES.has(code)
    ) {
      return true
    }
  }

  const message = (e as { message?: unknown }).message
  if (typeof message === 'string' && message.includes(CROSS_REQUEST_IO_MESSAGE)) {
    return true
  }

  return false
}

/**
 * pg ドライバのクエリに対するリトライラッパー。
 *
 * 既定（idempotent: false）ではリトライせず即 throw する。
 * 理由: 接続断は「クエリの結果不明」を意味する（サーバーに届いて COMMIT された後に
 * 応答だけ失われた可能性がある）。非冪等な書き込みを自動リトライすると二重実行
 * （ガチャ二重排出・ポイント二重加算等）のリスクがあるため、読み取り・
 * ON CONFLICT 等で冪等であることを呼び出し元が保証できる文のみ opt-in で
 * リトライする。
 *
 * @param queryFn - 実行するクエリ（規約: この関数の中で getDb() を呼ぶこと）
 * @param context - ログ用コンテキスト文字列
 * @param options - リトライオプション
 */
export async function withDbRetry<T>(
  queryFn: () => Promise<T>,
  context: string,
  options?: DbRetryOptions,
): Promise<T> {
  const delays = options?.delays ?? DEFAULT_DELAYS
  const maxRetries = options?.maxRetries ?? delays.length
  const idempotent = options?.idempotent ?? false

  for (let attempt = 0; ; attempt++) {
    try {
      return await queryFn()
    } catch (error) {
      // 非冪等（既定）は分類すらせず即 throw（上記の二重実行リスク回避）。
      // 恒久的エラー・リトライ回数到達時もそのまま呼び出し元へ伝播する。
      if (!idempotent || !isRetryableDbError(error) || attempt >= maxRetries) {
        throw error
      }

      const delay = delays[Math.min(attempt, delays.length - 1)]
      // ログ形式は supabase/retry.ts に合わせる。context の [db:pg] プレフィックスは
      // 新経路（pg 直結）のログだけを wrangler tail 等で抽出するための観測用タグ。
      logger.warn(
        `[DB Retry] [db:pg] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        {
          code: (error as { code?: unknown })?.code,
          error: error instanceof Error ? error.message : String(error),
        },
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}
