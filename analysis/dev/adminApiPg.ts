/**
 * analysis ダッシュボード admin backend の pg 直結クエリ (#700, #574, #568 Phase 1-5)
 *
 * `analysis/dev/localAdminApi.ts` は Vite dev plugin として Node プロセス上で動く
 * ローカル専用の admin backend であり、Cloudflare Workers ではない。`analysis/` は
 * root とは別の npm パッケージ（独自の package.json / package-lock.json、npm
 * workspaces 未使用）のため、root の `src/lib/db/client.ts`（drizzle-orm 依存）を
 * import すると依存解決が analysis 側の package.json に現れない暗黙のディレクトリ
 * 遡り解決に頼ることになり壊れやすい。このファイルは `postgres` パッケージのみを
 * analysis 自身の依存として追加し、完全に自己完結させる。
 *
 * Drizzle を使わない理由: ここで呼ぶ `get_analysis_*`（`00073_add_analysis_dashboard_rpcs.sql`）
 * はいずれも単一の JSONB を返す SQL 関数で、複雑な集計は関数側に既にある。
 * また JSONB の中に埋め込まれた timestamp/timestamptz は PostgreSQL の
 * `to_jsonb()`/`to_char()` が自前で ISO 8601（'T'区切り）にシリアライズするため、
 * `src/lib/db/client.ts` の `installIsoTimestampParsers()`（生の timestamp/timestamptz
 * "列" 型を受け取る場合の PG テキスト形式→ISO 8601 変換）はそもそも対象外
 * （このモジュールは jsonb 列 1本しか SELECT しない）。よって Drizzle + 型正規化の
 * 仕組みを丸ごと持ち込む必要がない。
 *
 * 関数名は SQL インジェクション対策として動的に組み立てず、呼び出す関数ごとに
 * 個別のリテラル SQL を書く（4関数のみなので汎用ヘルパーで動的合成する必要もない）。
 */

import postgres from 'postgres'

export type AnalysisDbDriver = 'supabase' | 'pg'

/**
 * analysis ダッシュボード backend が使う DB 経路を判定する。
 * `src/lib/db/flags.ts` の `getDbDriverMode` と同じ「毎回呼び出し時に読む・trim する・
 * 未設定/不正値は安全側（既存動作である 'supabase'）に倒す」パターンに揃える。
 * root app の `DB_DRIVER` とは別軸（analysis 管理ダッシュボード専用）のため名前を分ける。
 */
export function getAnalysisDbDriver(env: Record<string, string>): AnalysisDbDriver {
  return env.ANALYSIS_DB_DRIVER?.trim() === 'pg' ? 'pg' : 'supabase'
}

/**
 * analysis 専用の Postgres 接続文字列を解決する。
 * `ANALYSIS_DB_DRIVER=pg` なのに `DASHBOARD_DATABASE_URL` が未設定の場合、無関係な
 * 値へ黙ってフォールバックさせず明示的に失敗させる（#570 の DATABASE_URL 解決と
 * 同じ「未設定は安全側で throw」方針）。
 *
 * 接続ロールの権限要件: `get_analysis_*()` (00073_add_analysis_dashboard_rpcs.sql) は
 * `REVOKE ALL FROM PUBLIC; GRANT EXECUTE ... TO service_role` のため、
 * `DASHBOARD_DATABASE_URL` のロールは `docs/db-driver-migration.md` と同じ要領で
 * `grant service_role to <role>` 済みである必要がある（未付与だと接続自体は成功し、
 * 呼び出し時に "permission denied for function" で失敗する）。
 */
function resolveDashboardDatabaseUrl(env: Record<string, string>): string {
  const url = env.DASHBOARD_DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      'ANALYSIS_DB_DRIVER=pg には DASHBOARD_DATABASE_URL の設定が必要です（analysis/.env.local 等）。'
    )
  }
  return url
}

/** Node シングルトン。analysis dev server は単一 Node プロセスなので TCP 接続を使い回す。 */
let sqlClient: postgres.Sql | null = null

/**
 * テスト専用の postgres.js クライアント差し替えフック。`analysis/` は root とは
 * 別 npm パッケージで独自の node_modules を持つため、root の `tests/unit/` から
 * `vi.mock('postgres', ...)` を当てても、このファイルが実際に解決する
 * `analysis/node_modules/postgres`（root のものとは別の物理パッケージ）には
 * 効かない。そのため bare specifier のモックではなく、この明示的な注入フックで
 * 差し替える。本番コード（localAdminApi.ts 含む）からは呼ばないこと。
 */
let sqlClientFactoryOverride: ((env: Record<string, string>) => postgres.Sql) | null = null

export function __setAnalysisSqlFactoryForTests(
  factory: ((env: Record<string, string>) => postgres.Sql) | null
): void {
  sqlClientFactoryOverride = factory
  sqlClient = null
}

/**
 * postgres.js クライアントを取得する（初回呼び出し時に遅延生成）。
 * オプションは `src/lib/db/client.ts` の createHandle() と揃える:
 * - max: 5 / connect_timeout: 10 / idle_timeout: 20 — 同じ根拠（接続確立ハング防止・
 *   放置接続の自動クローズ）がここにもそのまま当てはまる。
 * - fetch_types: false — pg_catalog への型情報取得ラウンドトリップを省く。
 *   ここでは常に `jsonb` 列1本しか SELECT しないため、fetch_types 無効化の制約
 *   （array 型が生文字列のままになる）は影響しない。
 */
function getAnalysisSql(env: Record<string, string>): postgres.Sql {
  if (sqlClientFactoryOverride) {
    return sqlClientFactoryOverride(env)
  }
  if (!sqlClient) {
    sqlClient = postgres(resolveDashboardDatabaseUrl(env), {
      max: 5,
      fetch_types: false,
      connect_timeout: 10,
      idle_timeout: 20,
    })
  }
  return sqlClient
}

/**
 * `get_analysis_*()` 系 SQL 関数（JSONB 単一列を返す）を呼び、`result` 列を返す。
 * PostgREST 版（`tryJsonbRpc`、localAdminApi.ts）と異なり、関数が存在しない場合の
 * silent fallback はしない。missing RPC を隠さず明示エラーにする方針は #700 issue
 * 本文のとおり（PlanetScale 移行後のスキーマ不備を隠さないため）。
 */
async function callAnalysisJsonFunction<T>(
  env: Record<string, string>,
  query: (sql: postgres.Sql) => Promise<{ result: T }[]>
): Promise<T> {
  const sql = getAnalysisSql(env)
  const rows = await query(sql)
  return rows[0]?.result as T
}

export async function getOverviewPg(env: Record<string, string>): Promise<unknown> {
  return callAnalysisJsonFunction(env, (sql) => sql`select get_analysis_overview() as result`)
}

export async function getStreamerLeaderboardPg(env: Record<string, string>): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`select get_analysis_streamer_leaderboard() as result`
  )
}

export async function listUsersPg(env: Record<string, string>): Promise<unknown> {
  return callAnalysisJsonFunction(env, (sql) => sql`select get_analysis_users() as result`)
}

export async function listStreamersWithStatsPg(env: Record<string, string>): Promise<unknown> {
  return callAnalysisJsonFunction(env, (sql) => sql`select get_analysis_streamers() as result`)
}
