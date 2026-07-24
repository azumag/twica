/**
 * pg ドライバ (postgres.js + Drizzle) 用リトライユーティリティ (#570)
 *
 * postgres.js はエラーを throw するため、throw されたエラーを分類して
 * リトライする。既定のバックオフ遅延は [100, 300, 1000] ms。
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

import { logger } from '@/lib/logger.server'
import { getErrorChain, getSqlState } from './errors'

interface DbRetryOptions {
  /**
   * この文が冪等（何度実行しても結果が同じ: 読み取り・ON CONFLICT DO NOTHING 等）
   * であることの呼び出し元による明示宣言。既定は false。
   */
  idempotent?: boolean
  maxRetries?: number
  /** バックオフ遅延（ミリ秒）: 既定 [100, 300, 1000] */
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
 *
 * cause チェーン対応 (2026-07 本番障害の恒久対応): Drizzle は postgres.js の
 * エラーを DrizzleQueryError で1段ラップする（SQLSTATE・接続断コードは
 * cause 側にしか無い）。トップレベルの code/message だけを見ていると、pg
 * 経路のリトライ機構全体が機能しなくなる（接続断からの回復リトライが
 * 一度も発火しない）。getErrorChain でトップレベル→cause と辿り、各階層に
 * 同じ判定を適用する。
 */
export function isRetryableDbError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) {
    return false
  }

  for (const layer of getErrorChain(e)) {
    if (typeof layer !== 'object' || layer === null) continue

    const code = (layer as { code?: unknown }).code
    if (typeof code === 'string') {
      if (
        RETRYABLE_DRIVER_CODES.has(code) ||
        RETRYABLE_NODE_CODES.has(code) ||
        RETRYABLE_SQLSTATES.has(code)
      ) {
        return true
      }
    }

    const message = (layer as { message?: unknown }).message
    if (typeof message === 'string' && message.includes(CROSS_REQUEST_IO_MESSAGE)) {
      return true
    }
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
        // 最終 throw の直前に必ず [db:pg] タグ付き warn を1行出す（SRE レビュー指摘）。
        // リトライ中の warn だけでは、非冪等（既定）の即 throw・非リトライ対象エラー・
        // リトライ上限到達という「最も重要な失敗モード」が一切ログに残らず、
        // docs/db-driver-migration.md の監視手順（wrangler tail で [db:pg] を検索）が
        // 機能しない。この warn により pg 経路の全失敗がタグ検索可能になる
        // （監視手順の実効性確保）。エラー自体は呼び出し元へそのまま伝播するため、
        // 外部挙動（throw されるエラー）は変えない。
        const reason = !idempotent
          ? 'non-idempotent'
          : !isRetryableDbError(error)
            ? 'non-retryable'
            : 'max-retries-exhausted'
        // ログの code は getSqlState でチェーン全体（トップレベル→cause）から
        // 拾う（Fable厳格レビュー指摘・低6）。トップレベルの code のみだと
        // Drizzle にラップされたエラーで常に undefined になり、[db:pg] タグの
        // wrangler tail 監視で実際の SQLSTATE が見えなくなる（観測性の欠落）。
        logger.warn(`[DB Retry] [db:pg] ${context} failed (no retry: ${reason})`, {
          code: getSqlState(error) ?? undefined,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      const delay = delays[Math.min(attempt, delays.length - 1)]
      // context の [db:pg] プレフィックスは PlanetScale 経路のログだけを
      // wrangler tail 等で抽出するための観測用タグ。
      logger.warn(
        `[DB Retry] [db:pg] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        {
          code: getSqlState(error) ?? undefined,
          error: error instanceof Error ? error.message : String(error),
        },
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}
