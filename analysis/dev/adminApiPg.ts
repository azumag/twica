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
 * "列" 型を受け取る場合の PG テキスト形式→ISO 8601 変換）はそもそも対象外。
 * よって Drizzle + 型正規化の仕組みを丸ごと持ち込む必要がない
 * （`getUserCardsSummaryPg` が例外的に `twitch_user_id` を生の TEXT 列として
 * SELECT するが、text/int4 等は postgres.js の既定パーサでそのまま安全に
 * 扱える型であり、timestamp/timestamptz のような変換問題は生じない）。
 *
 * 関数名は SQL インジェクション対策として動的に組み立てず、呼び出す関数ごとに
 * 個別のリテラル SQL を書く。
 *
 * gacha chart/table/export（`getGachaChartPg` 以下）は上記と異なり、対応する
 * `get_analysis_*()` SQL 関数が存在しない（絞り込み条件が可変で、既存の
 * `00073_add_analysis_dashboard_rpcs.sql` のような固定引数のRPC化に馴染まないため）。
 * そのため、この3関数のみ postgres.js のフラグメント合成（`sql`` を `${}` でネスト、
 * postgres.js README「nesting sql`` fragments」参照）で動的 WHERE 句を組み立てる。
 * 値は必ずバインドパラメータとして渡され文字列連結は一切行わないため、
 * 条件の有無を動的に変えてもインジェクションの余地はない。
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
 *
 * gacha chart/table/export・user-cards・streamer-cards（`getGachaChartPg` 以下）は
 * SQL 関数を経由せず `gacha_history`/`cards`/`streamers`/`users`/`user_cards` を
 * 直接 SELECT するため、上記の EXECUTE 権限に加えてこれらテーブルへの SELECT 権限も
 * 必要（`grant service_role to <role>` なら service_role が持つテーブル権限も
 * 継承されるため、通常は追加のGRANT操作は不要）。
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

/**
 * `get_analysis_gacha_summary(p_from_date, p_streamer_id)` を呼ぶ。他の `*Pg` 関数と
 * 異なり引数を取る唯一の関数。値は postgres.js のタグ付きテンプレート経由でバインド
 * パラメータとして渡す（文字列連結ではないため SQL インジェクションの余地はない）。
 * `p_streamer_id` 省略時は SQL 関数側の `DEFAULT NULL` に委ねず明示的に `null` を渡す
 * （呼び出し元の `params.streamerId ?? null` で undefined を吸収するため、この関数
 * 自体は常に2引数で呼ぶ）。
 */
export async function getGachaSummaryPg(
  env: Record<string, string>,
  params: { fromDate: string | null; streamerId: string | null }
): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) =>
      sql`select get_analysis_gacha_summary(${params.fromDate}, ${params.streamerId}) as result`
  )
}

/** getGachaChartPg/getGachaTablePg/getGachaExportRowsPg が共有する絞り込み条件。 */
export interface GachaHistoryFilters {
  streamerId?: string
  /** ISO文字列。範囲の下限（含む）。未指定なら絞り込まない。 */
  fromDate?: string | null
  /** ISO文字列。範囲の上限（含まない、exclusive）。未指定なら絞り込まない。 */
  toDateExclusive?: string | null
  /** ILIKE パターン文字列（`%`/`_` エスケープ済みの状態で呼び出し元から渡すこと）。 */
  usernameIlike?: string
  rarity?: string
}

/**
 * gacha_history + cards + streamers の共通 FROM/JOIN/WHERE フラグメント。
 * card_id/streamer_id は `gacha_history` の NOT NULL 外部キー
 * （00001_initial_schema.sql）のため INNER JOIN で常に正しい
 * （PostgREST 版が rarity フィルタ時だけ `cards!inner` を使い分けていたのは
 * PostgREST 埋め込みの仕様に起因するもので、素の SQL では区別不要）。
 *
 * データ取得クエリと件数取得クエリの両方からこの関数を呼び、FROM/JOIN/WHERE を
 * 完全に共有する（件数と行データで条件がずれるバグを構造的に防ぐ）。
 *
 * export しているのはテストのため（動的に組み立てたSQLフラグメントは、外側の
 * クエリ全体を検証するより、この関数単体でフィルタの組み合わせごとに検証する
 * 方がテストしやすいため個別に公開する。本番コードからの利用は同一ファイル内
 * の3関数のみを想定）。
 */
export function gachaHistoryFromWhere(sql: postgres.Sql, filters: GachaHistoryFilters) {
  return sql`
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    JOIN streamers s ON s.id = gh.streamer_id
    WHERE TRUE
    ${filters.streamerId ? sql`AND gh.streamer_id = ${filters.streamerId}` : sql``}
    ${filters.fromDate ? sql`AND gh.redeemed_at >= ${filters.fromDate}` : sql``}
    ${filters.toDateExclusive ? sql`AND gh.redeemed_at < ${filters.toDateExclusive}` : sql``}
    ${filters.usernameIlike ? sql`AND gh.user_twitch_username ILIKE ${filters.usernameIlike}` : sql``}
    ${filters.rarity ? sql`AND c.rarity = ${filters.rarity}` : sql``}
  `
}

/**
 * ダッシュボードのガチャチャートが期待する行を返す（GachaChartRow 相当）。
 * `getGachaChart()`（PostgREST版）は `.limit(10000)` を指定しているが、
 * Supabase の max-rows API 設定（既定 1000）により実際には最大1000件しか
 * 返っていない（`docs/db-driver-migration.md` 参照、`getGachaExportRows` の
 * fetchAllPaged 導入理由と同じ制約）。pg 直結には PostgREST の max-rows は
 * 適用されないため、ここではコードが本来意図している10000件の上限をそのまま使う
 * （既存の実挙動＝1000件を人為的に再現するのではなく、コードの記述どおりの
 * 上限に揃える。管理者用の内部チャートであり、より完全なデータが出ることは
 * リスクではない）。
 *
 * timestamp/timestamptz を生列として SELECT すると postgres.js が JS Date
 * オブジェクトへ変換してしまい、呼び出し元が期待する ISO 文字列と型が
 * 食い違う（かつファイル冒頭の「jsonb 列1本しかSELECTしない」前提も崩れる）。
 * そのため jsonb_build_object() で個々の値を明示的に組み立てる
 * （timestamptz を jsonb_build_object の値として渡すと to_jsonb() と同じ
 * ISO 8601 変換が適用される）。
 */
export async function getGachaChartPg(
  env: Record<string, string>,
  filters: Pick<GachaHistoryFilters, 'streamerId' | 'fromDate'>
): Promise<unknown> {
  return callAnalysisJsonFunction(env, (sql) => sql`
    SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_redeemed_at DESC), '[]'::jsonb) AS result
    FROM (
      SELECT
        jsonb_build_object(
          'id', gh.id,
          'redeemed_at', gh.redeemed_at,
          'card_id', gh.card_id,
          'user_twitch_id', gh.user_twitch_id,
          'streamer_id', gh.streamer_id,
          'cards', jsonb_build_object(
            'id', c.id, 'name', c.name, 'rarity', c.rarity, 'image_url', c.image_url
          ),
          'streamers', to_jsonb(s.*)
        ) AS row_json,
        gh.redeemed_at AS sort_redeemed_at
      ${gachaHistoryFromWhere(sql, filters)}
      ORDER BY gh.redeemed_at DESC
      LIMIT 10000
    ) chart
  `)
}

/**
 * 件数のみを取得する（`getGachaTablePg` 専用）。`count(*) OVER()` ウィンドウ関数で
 * 1クエリに統合する案もあったが、要求ページが最終ページを超えて0行になった場合に
 * 件数自体も取れなくなる（ウィンドウ関数は結果行にしか付与されないため）。
 * PostgREST版（`{ count: 'exact' }`）は常に正確な件数を返すため、その挙動に
 * 合わせて素直に別クエリにする。
 *
 * 既知のトレードオフ: この件数クエリと `getGachaTablePg` のデータクエリは
 * `Promise.all` で並行実行される別クエリ（別スナップショット）のため、
 * 両者の間に同時書き込みが挟まると件数と実際の行データがわずかにずれうる
 * （PostgREST版は単一クエリのため常に一貫していた）。`gacha_history` は
 * INSERT/SELECT のみの追記専用テーブルであり、ズレても「直近の並行insert数件分
 * だけ件数が古い」程度に留まる。内部管理ダッシュボードでの許容範囲と判断し、
 * 単一クエリ化（ウィンドウ関数）よりも「最終ページでも件数が必ず取れる」正しさを
 * 優先した。
 */
async function countGachaHistory(
  sql: postgres.Sql,
  filters: GachaHistoryFilters
): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count ${gachaHistoryFromWhere(sql, filters)}`
  return rows[0]?.count ?? 0
}

/**
 * ダッシュボードのガチャ履歴テーブル（ページネーション付き）が期待する
 * `{ rows, count }` を返す（`getGachaTable()` 相当）。
 */
export async function getGachaTablePg(
  env: Record<string, string>,
  filters: GachaHistoryFilters,
  pagination: { offset: number; pageSize: number }
): Promise<{ rows: unknown[]; count: number }> {
  const sql = getAnalysisSql(env)

  const [count, rows] = await Promise.all([
    countGachaHistory(sql, filters),
    callAnalysisJsonFunction(env, () => sql`
      SELECT COALESCE(
        jsonb_agg(row_json ORDER BY sort_redeemed_at DESC, sort_id DESC), '[]'::jsonb
      ) AS result
      FROM (
        SELECT
          to_jsonb(gh.*) || jsonb_build_object(
            'cards', to_jsonb(c.*),
            'streamers', to_jsonb(s.*)
          ) AS row_json,
          gh.redeemed_at AS sort_redeemed_at,
          gh.id AS sort_id
        ${gachaHistoryFromWhere(sql, filters)}
        ORDER BY gh.redeemed_at DESC, gh.id DESC
        LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
      ) page
    `) as Promise<unknown[]>,
  ])

  return { rows, count }
}

// CSVエクスポートの安全上限。PostgREST経路側にも同値の上限 GACHA_EXPORT_ROW_LIMIT
// （localAdminApi.ts）が独立定義されている。import循環を避けるため定数を共有して
// いない。上限値を変更する場合は両方揃えること
const GACHA_EXPORT_ROW_LIMIT_PG = 50000

/**
 * CSVエクスポート用の行を返す（`getGachaExportRows()` 相当）。PostgREST版は
 * max-rows制約により `fetchAllPaged` で1000件ずつバッチ取得しているが、
 * pg直結にはその制約がないため単発の `LIMIT` クエリで完結する。
 */
export async function getGachaExportRowsPg(
  env: Record<string, string>,
  filters: GachaHistoryFilters
): Promise<unknown[]> {
  return callAnalysisJsonFunction(env, (sql) => sql`
    SELECT COALESCE(
      jsonb_agg(row_json ORDER BY sort_redeemed_at DESC, sort_id DESC), '[]'::jsonb
    ) AS result
    FROM (
      SELECT
        jsonb_build_object(
          'redeemed_at', gh.redeemed_at,
          'user_twitch_username', gh.user_twitch_username,
          'cards', jsonb_build_object('name', c.name, 'rarity', c.rarity),
          'streamers', jsonb_build_object('twitch_display_name', s.twitch_display_name)
        ) AS row_json,
        gh.redeemed_at AS sort_redeemed_at,
        gh.id AS sort_id
      ${gachaHistoryFromWhere(sql, filters)}
      ORDER BY gh.redeemed_at DESC, gh.id DESC
      LIMIT ${GACHA_EXPORT_ROW_LIMIT_PG}
    ) exported
  `) as Promise<unknown[]>
}

/**
 * `get_gacha_drop_stats(p_streamer_id, p_from_date, p_limit_per_card)` を呼ぶ
 * （`getDropRateStats()` 相当）。`00038`〜`00052` で拡張済みの既存 SQL 関数を
 * そのまま呼ぶだけで、gacha summary と同じパラメータ化 RPC 呼び出しパターン。
 */
export async function getDropRateStatsPg(
  env: Record<string, string>,
  params: { streamerId: string; fromDate: string; limitPerCard: number }
): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) =>
      sql`select get_gacha_drop_stats(${params.streamerId}, ${params.fromDate}, ${params.limitPerCard}) as result`
  )
}

/**
 * ユーザー詳細（`USER_SAFE_COLUMNS` 相当の狭い列。localAdminApi.ts の同名定数と
 * 同じ列集合を維持すること — OAuth トークン等の秘匿列を誤って jsonb に含めない）
 * と、`get_user_card_counts()` RPC によるカード所持サマリーを返す
 * （`getUserCardsSummary()` 相当）。
 *
 * user_id（analysis内部ID）→ twitch_user_id の変換が必要なため、
 * 他の *Pg 関数と異なり2ステップになる（1クエリでユーザー行を取得し、その
 * twitch_user_id を使って2つ目のRPCを呼ぶ）。
 */
export async function getUserCardsSummaryPg(
  env: Record<string, string>,
  userId: string
): Promise<{ user: unknown; cardCounts: unknown }> {
  const sql = getAnalysisSql(env)

  const userRows = await sql<{ twitch_user_id: string; user_json: unknown }[]>`
    SELECT
      u.twitch_user_id AS twitch_user_id,
      jsonb_build_object(
        'id', u.id,
        'twitch_user_id', u.twitch_user_id,
        'twitch_username', u.twitch_username,
        'twitch_display_name', u.twitch_display_name,
        'twitch_profile_image_url', u.twitch_profile_image_url,
        'tos_accepted_at', u.tos_accepted_at,
        'twitch_scopes', u.twitch_scopes,
        'created_at', u.created_at,
        'updated_at', u.updated_at
      ) AS user_json
    FROM users u
    WHERE u.id = ${userId}
  `
  const userRow = userRows[0]
  if (!userRow) {
    // PostgREST版（PGRST116）と同じ 404 契約に揃える
    throw Object.assign(new Error('User not found'), { statusCode: 404 })
  }

  const cardCounts = await callAnalysisJsonFunction(
    env,
    () => sql`select get_user_card_counts(${userRow.twitch_user_id}) as result`
  )

  return { user: userRow.user_json, cardCounts }
}

/**
 * ユーザーのカード所持一覧（ページネーション付き、cards/streamersを埋め込み）を
 * 返す（`getUserCardsTable()` 相当）。`user_cards.card_id`/`cards.streamer_id` は
 * ともに NOT NULL 外部キー（00001_initial_schema.sql）のため、PostgREST版が
 * streamerを別クエリで後引きしていたのとは異なり、pg直結では単純な INNER JOIN
 * 3段で1クエリに統合できる。
 */
export async function getUserCardsTablePg(
  env: Record<string, string>,
  params: { userId: string; offset: number; pageSize: number }
): Promise<{ rows: unknown[]; count: number }> {
  const sql = getAnalysisSql(env)

  const [countRows, rows] = await Promise.all([
    sql`
      SELECT count(*)::int AS count
      FROM user_cards uc
      WHERE uc.user_id = ${params.userId}
    `,
    callAnalysisJsonFunction(env, () => sql`
      SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_obtained_at DESC), '[]'::jsonb) AS result
      FROM (
        SELECT
          jsonb_build_object(
            'id', uc.id,
            'card_id', uc.card_id,
            'obtained_at', uc.obtained_at,
            'cards', jsonb_build_object(
              'id', c.id,
              'streamer_id', c.streamer_id,
              'name', c.name,
              'description', c.description,
              'image_url', c.image_url,
              'rarity', c.rarity,
              'drop_rate', c.drop_rate,
              'is_active', c.is_active,
              'created_at', c.created_at,
              'updated_at', c.updated_at
            ),
            'streamer', to_jsonb(s.*)
          ) AS row_json,
          uc.obtained_at AS sort_obtained_at
        FROM user_cards uc
        JOIN cards c ON c.id = uc.card_id
        JOIN streamers s ON s.id = c.streamer_id
        WHERE uc.user_id = ${params.userId}
        ORDER BY uc.obtained_at DESC
        LIMIT ${params.pageSize} OFFSET ${params.offset}
      ) page
    `) as Promise<unknown[]>,
  ])

  return { rows, count: countRows[0]?.count ?? 0 }
}

/**
 * 配信者のカード一覧（ページネーション付き）を返す（`getStreamerCardsPage()` 相当）。
 * 並び順は PostgREST 版 `.order('rarity', { ascending: false })` と同じ、
 * rarity列（TEXT）のアルファベット降順（tier順ではない、既存挙動をそのまま維持）。
 */
export async function getStreamerCardsPagePg(
  env: Record<string, string>,
  params: { streamerId: string; offset: number; pageSize: number }
): Promise<{ rows: unknown[]; count: number }> {
  const sql = getAnalysisSql(env)

  const [countRows, rows] = await Promise.all([
    sql`
      SELECT count(*)::int AS count
      FROM cards c
      WHERE c.streamer_id = ${params.streamerId}
    `,
    callAnalysisJsonFunction(env, () => sql`
      SELECT COALESCE(
        jsonb_agg(row_json ORDER BY sort_rarity DESC, sort_created_at DESC), '[]'::jsonb
      ) AS result
      FROM (
        SELECT
          to_jsonb(c.*) AS row_json,
          c.rarity AS sort_rarity,
          c.created_at AS sort_created_at
        FROM cards c
        WHERE c.streamer_id = ${params.streamerId}
        ORDER BY c.rarity DESC, c.created_at DESC
        LIMIT ${params.pageSize} OFFSET ${params.offset}
      ) page
    `) as Promise<unknown[]>,
  ])

  return { rows, count: countRows[0]?.count ?? 0 }
}
