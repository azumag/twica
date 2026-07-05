/**
 * postgres.js + Drizzle 接続管理 (#570, #568 Phase 1)
 *
 * Hyperdrive（Supabase 直結）経由で PostgreSQL に接続するクライアントの生成・
 * ライフサイクル管理。PostgREST(supabase-js) 経路の置き換え先となる新経路。
 * DB_DRIVER フラグが未設定の間は誰もこのモジュールの getDb() を呼ばないため、
 * 存在するだけでは挙動に一切影響しない（src/lib/db/flags.ts 参照）。
 *
 * 接続ライフサイクルの設計根拠:
 *
 * - Workers 環境: 「リクエストスコープ」でクライアントを生成する。
 *   Workers の TCP ソケットはそれを開いたリクエストに束縛され、リクエストを
 *   跨いで再利用すると 'Cannot perform I/O on behalf of a different request' で
 *   失敗する。そのためモジュールレベルのシングルトンは使えない。Cloudflare 公式も
 *   per-request 生成を推奨しており、Hyperdrive が上流（Cloudflare エッジ側）で
 *   実接続をプールするため、リクエストごとの接続確立は高速（プール済み接続への
 *   ハンドシェイクのみ）。同一リクエスト内の複数クエリでクライアントを再生成
 *   しないよう、リクエスト識別子（ExecutionContext）をキーにした WeakMap で再利用する。
 *
 * - 接続の後始末: 明示的な sql.end() は行わない。Workers ランタイムはリクエスト
 *   コンテキスト終了時にそのリクエストが開いた I/O（TCP ソケット）を破棄し、
 *   Hyperdrive 側は実接続をプールしたまま維持するため、リークは発生しない
 *   （Cloudflare 公式の postgres.js / Drizzle 例、OpenNext の DB ガイドも
 *   per-request 生成のみで明示クローズしない現行パターン）。
 *   注意: 「作成直後に ctx.waitUntil(sql.end()) を登録する」方式は採用できない。
 *   postgres.js の end() は呼び出した時点（1 マイクロタスク後）で ending フラグを
 *   立て、以後の新規クエリをすべて CONNECTION_ENDED で拒否するため、リクエスト内の
 *   後続クエリが全滅する（waitUntil は Promise の「完了を待つ」だけで、実行開始を
 *   レスポンス後まで遅延させるものではない）。
 *
 * - Node 環境（next dev）フォールバック: getCloudflareContext() が throw した場合は
 *   モジュールレベルのシングルトンにフォールバックする。Node では TCP ソケットの
 *   リクエスト跨ぎ再利用が安全であり、毎回の接続確立（こちらは Hyperdrive を
 *   経由しない実接続）を避けられる。idle_timeout で放置接続は自動クローズされる。
 *
 * - ビルド時評価の回避: 環境判定・接続文字列解決・クライアント生成はすべて
 *   getDb() 呼び出し時に遅延実行する。モジュールトップで評価すると next build
 *   （env 未注入・Cloudflare コンテキスト外）で壊れるため。
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/** getDb() が返すハンドル。db は Drizzle、sql は生 SQL 実行用の postgres.js クライアント */
export interface DbHandle {
  db: PostgresJsDatabase<typeof schema>
  sql: postgres.Sql
}

/**
 * Hyperdrive バインディングの最小インターフェース。
 * r2-client.ts の R2BucketLike と同様、tsconfig に @cloudflare/workers-types を
 * 要求しないためにここで最小限だけ定義する。
 */
interface HyperdriveBindingLike {
  connectionString: string
}

/**
 * Workers 環境: ExecutionContext（リクエストごとに一意）をキーにしたハンドルの
 * キャッシュ。WeakMap なのでリクエスト終了とともに ctx ごと GC され、リークしない。
 */
const requestScopedHandles = new WeakMap<object, DbHandle>()

/** Node 環境（next dev）用のシングルトン（supabase/admin.ts と同じパターン） */
let nodeSingletonHandle: DbHandle | null = null

/**
 * postgres.js クライアントと Drizzle インスタンスを生成する。
 *
 * オプションの根拠:
 * - max: 5
 *   Workers の同時外部接続数制限とのバランス（Cloudflare 公式ガイドの推奨値）。
 *   クライアントはリクエストスコープなので「1 リクエストあたり最大 5 接続」。
 * - fetch_types: false
 *   postgres.js は既定で接続時に pg_catalog から型情報（配列型 OID 等）を
 *   フェッチする。この往復を省いてレイテンシを削る（公式ガイド推奨）。
 *   ※制約: この設定では array 型（text[] 等）の列は postgres.js 側で
 *   パースされない。array 列（users.twitch_scopes / twitch_bot_accounts.scopes）は
 *   必ず Drizzle スキーマ経由（db.select 等）で読むこと。Drizzle が schema 定義に
 *   基づいて配列をパースする。生 SQL（sql`...` / db.execute）で array 列を
 *   SELECT すると '{a,b}' の生文字列が返り、値の形状が壊れる。
 *   ※補足: drizzle() はこのクライアントの timestamp/timestamptz/date パーサを
 *   透過（文字列パススルー）に上書きするため、日時列は Date ではなく PG テキスト
 *   形式の文字列で返る（schema.ts の mode: 'string' が期待する入力）。プロセスの
 *   タイムゾーンに依存する Date 変換は発生しない（drizzle-orm/postgres-js/driver の
 *   construct() を実測確認済み）。
 * - prepare は指定しない（デフォルト true）
 *   Hyperdrive は prepared statements をサポートし、キャッシュもする。
 *   false にすると Hyperdrive 側で追加の往復が発生する。
 * - connect_timeout: 10（秒）
 *   接続確立のハング防止。Hyperdrive 経由ではプール済みのため通常は瞬時。
 * - idle_timeout: 20（秒）
 *   アイドル接続の自動クローズ。主に Node シングルトン（next dev）で
 *   放置接続が溜まらないようにするため。Workers ではリクエスト終了時に
 *   ランタイムがソケットを破棄するため実質影響しない。
 */
function createHandle(connectionString: string): DbHandle {
  const sql = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 20,
  })
  const db = drizzle(sql, { schema })
  return { db, sql }
}

/**
 * 接続文字列の解決。優先順:
 *   (1) Cloudflare env の HYPERDRIVE バインディング（wrangler.toml の [[hyperdrive]]）
 *   (2) process.env.DATABASE_URL（next dev などローカル開発用）
 *   (3) どちらも無ければ throw
 * (3) は新経路（DB_DRIVER=pg-read/pg）を呼んだときにのみ到達する。フラグ未設定の
 * postgrest 経路はこのモジュールを呼ばないため、Hyperdrive 未設定のままデプロイ
 * しても既存機能には影響しない。
 */
function resolveConnectionString(cfEnv: Record<string, unknown> | null): string {
  const hyperdrive = cfEnv?.HYPERDRIVE as HyperdriveBindingLike | undefined
  if (hyperdrive?.connectionString) {
    return hyperdrive.connectionString
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) {
    return databaseUrl
  }

  throw new Error(
    '[db:pg] No database connection configured: bind HYPERDRIVE in wrangler.toml ' +
      '(Workers) or set DATABASE_URL (local dev). This is only reached when ' +
      'DB_DRIVER=pg-read/pg is set; unset DB_DRIVER to fall back to PostgREST.',
  )
}

/**
 * Drizzle クライアントを取得する。
 * - Workers: リクエストごとに生成し、同一リクエスト内では WeakMap で再利用
 * - Node（next dev）: モジュールシングルトン
 *
 * 使用側の規約: withDbRetry() でラップする場合は queryFn の中で getDb() を
 * 呼ぶこと（リクエストスコープ破棄からの回復にはクライアント再取得が必要。
 * src/lib/db/retry.ts 参照）。
 */
export async function getDb(): Promise<DbHandle> {
  // Cloudflare コンテキストの取得を試みる。r2-client.ts と同じく動的 import に
  // して、Workers 外（テスト・素の Node 実行）でのバンドル/評価問題を避ける。
  // next dev では initOpenNextCloudflareForDev 未設定のため throw し、
  // Node フォールバックに落ちる。
  let cfCtx: object | null = null
  let cfEnv: Record<string, unknown> | null = null
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env, ctx } = await getCloudflareContext({ async: true })
    cfCtx = ctx as unknown as object
    cfEnv = env as unknown as Record<string, unknown>
  } catch {
    // Cloudflare Workers 環境ではない（next dev / Node）
    cfCtx = null
    cfEnv = null
  }

  if (cfCtx) {
    // Workers: 同一リクエスト（= 同一 ExecutionContext）内はハンドルを再利用する。
    // OpenNext は AsyncLocalStorage でリクエストごとに同一の ctx を返すため、
    // ctx がそのままリクエスト識別子として機能する。
    //
    // 注意: 以下の get → create → set の間に await を挟まないこと。
    // createHandle() は同期（postgres() は遅延接続でコンストラクトは同期）なので
    // このブロックは原子的に実行され、同一リクエスト内で getDb() が並列に
    // 呼ばれても（Promise.all 等）ハンドルが二重生成されることはない。
    // ここに await を追加すると、その保証が壊れる。
    const existing = requestScopedHandles.get(cfCtx)
    if (existing) {
      return existing
    }
    const handle = createHandle(resolveConnectionString(cfEnv))
    requestScopedHandles.set(cfCtx, handle)
    return handle
  }

  // Node（next dev）: シングルトンで TCP 接続を再利用
  // （上と同じく判定〜代入は同期ブロックなので並列呼び出しでも二重生成されない）
  if (!nodeSingletonHandle) {
    nodeSingletonHandle = createHandle(resolveConnectionString(null))
  }
  return nodeSingletonHandle
}
