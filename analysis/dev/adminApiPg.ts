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

/**
 * analysis 専用の Postgres 接続文字列を解決する。
 * `DASHBOARD_DATABASE_URL` が未設定の場合、無関係な値へ黙ってフォールバック
 * させず明示的に失敗させる（#570 の DATABASE_URL 解決と同じ「未設定は安全側で
 * throw」方針）。退役済み Supabase 経路撤去後はこのURLが唯一のDB接続設定である。
 *
 * 接続ロールの権限要件: `get_analysis_*()` (00073_add_analysis_dashboard_rpcs.sql) は
 * `REVOKE ALL FROM PUBLIC; GRANT EXECUTE ... TO service_role` のため、
 * `DASHBOARD_DATABASE_URL` のロールは `docs/db-driver-migration.md` と同じ要領で
 * `grant service_role to <role>` 済みである必要がある（未付与だと接続自体は成功し、
 * 呼び出し時に "permission denied for function" で失敗する）。
 *
 * `getGachaChartPg` 以下の関数群は SQL 関数を経由せず対象テーブル（gacha_history/
 * cards/streamers/users/user_cards/support_codes/user_licenses/support_inquiries/
 * support_inquiry_messages 等、増分が進むごとに増える）を直接 SELECT/INSERT/UPDATE
 * するため、上記の EXECUTE 権限に加えてこれらテーブルへの DML 権限も必要
 * （`grant service_role to <role>` なら service_role が持つテーブル権限・RLS
 * ポリシー（`TO service_role`）も継承されるため、通常は追加のGRANT操作は不要。
 * 個別テーブルを都度列挙すると増分ごとに陳腐化するため、今後は一般論のみ記載する）。
 */
function resolveDashboardDatabaseUrl(env: Record<string, string>): string {
  const url = env.DASHBOARD_DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      'DASHBOARD_DATABASE_URL の設定が必要です（analysis/.env.local 等）。'
    )
  }
  return url
}

/**
 * postgres.js が接続文字列内で認識しない `sslrootcert` クエリパラメータを取り除き、
 * 必要なら `sslmode=verify-full` を補う純粋関数。
 *
 * 詳細な背景・postgres.js 内部の行番号根拠・Major-1（sslrootcert のみ除去すると
 * sslmode未指定URLが平文接続へサイレントダウングレードする問題とその対策）の
 * 設計根拠は、正本である `scripts/lib/db-migrate-core.js` の同名関数の JSDoc を
 * 参照。ロジックは常にそちらと同期させること。
 *
 * `analysis/` は root とは別の npm パッケージ（独自の node_modules、npm
 * workspaces 未使用）であり、root のソースを import すると暗黙のディレクトリ
 * 遡り解決に頼ることになり壊れやすいため、意図的に同ロジックの独立コピーを
 * ここへ置く（Fableレビューで妥当性を確認済み）。
 *
 * export しているのはテストのため（gachaHistoryFromWhere と同じ理由。本番コードからの
 * 利用は同一ファイル内の getAnalysisSql() のみを想定）。
 */
export function stripPostgresJsIncompatibleSslParams(connectionString: string): string {
  if (!connectionString) return connectionString
  try {
    const url = new URL(connectionString)
    const hadSslRootCert = url.searchParams.has('sslrootcert')
    url.searchParams.delete('sslrootcert')
    // Major-1: sslrootcert が実際に存在し、かつ sslmode が空文字列も含めて
    // 未指定の場合のみ verify-full を補う（既存の明示的な sslmode 指定は
    // 上書きしない。`.has()`だけだと`sslmode=`という空文字列を「指定済み」と
    // みなし平文接続になる病的ケースが残るため`.get()`の真偽値も見る。
    // 正本は scripts/lib/db-migrate-core.js のJSDoc参照）。
    if (hadSslRootCert && !url.searchParams.get('sslmode')) {
      url.searchParams.set('sslmode', 'verify-full')
    }
    return url.toString()
  } catch {
    return connectionString
  }
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
    // PlanetScale接続文字列が付与する sslrootcert パラメータは postgres.js が
    // 未知の接続オプションとしてサーバーへ送りつけてしまい接続失敗する
    // （stripPostgresJsIncompatibleSslParams のdocコメント参照。実機確認済み）。
    sqlClient = postgres(stripPostgresJsIncompatibleSslParams(resolveDashboardDatabaseUrl(env)), {
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
 * ストリーマー1件をidで取得する（`GET /streamers/:id` 相当、#701向けに新規追加。
 * `StreamerCards`/`StreamerGachaHistory`ページがブラウザから直接Supabaseへ
 * `.from('streamers').select('*').eq('id', id).single()` していた箇所を置き換える）。
 * 対象0件時は明示的に404を投げる。直接SQLのSELECT 0件はDBエラーではなく空の
 * 行集合であり、postgres.jsからSQLSTATEは返らない。そのため、DB例外のcodeを
 * 推測するのではなく`callAnalysisJsonFunction()`が返す`result === undefined`
 * という実際のcardinalityをHTTP 404へ写像する。SQLSTATEは接続・権限・構文など
 * 本物のDB障害にだけ使い、0件という正常な問い合わせ結果と混同しない。
 *
 * `to_jsonb(s.*)` で全列を返す。`streamers`テーブルには`users`テーブルの
 * twitch_access_token/twitch_refresh_tokenのような秘匿列が無い（BOTのOAuth
 * トークンは`twitch_bot_accounts`テーブルに分離済み、00040_add_bot_account_settings.sql
 * 参照）ため、`USER_SAFE_COLUMNS`のような列制限は不要と判断した。将来streamersに
 * 秘匿列が追加された場合はこのエンドポイントも見直すこと。
 */
export async function getStreamerByIdPg(
  env: Record<string, string>,
  id: string
): Promise<unknown> {
  const result = await callAnalysisJsonFunction(
    env,
    (sql) => sql`SELECT to_jsonb(s.*) AS result FROM streamers s WHERE s.id = ${id}`
  )
  if (result === undefined) {
    throw Object.assign(new Error('Streamer not found'), { statusCode: 404 })
  }
  return result
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
    // SELECT 0件はSQLSTATEを伴う例外ではないため、結果cardinalityから404へ写像する。
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

/**
 * サポートコード一覧を作成日降順で返す（`GET /support-codes` 相当）。
 *
 * PostgREST版は `.range()` を指定しない単発 `select()` のため、Supabase の
 * max-rows API 設定（既定1000件、`getGachaChartPg` のコメント参照）で
 * 実際には最大1000件に打ち切られている可能性があるが、pg直結にはこの制約が
 * 適用されないためLIMITなしで全件返す。support_codes/user_licenses/
 * twitch_has_sub ユーザーはいずれも管理対象データとして現実的には
 * 1000件を大きく超えない規模を想定しており（gacha_historyのような
 * 高頻度書き込みテーブルとは性質が異なる）、`listLicensesPg`/
 * `listTwitchSubsPg` も同様の判断。
 */
export async function listSupportCodesPg(env: Record<string, string>): Promise<unknown[]> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      SELECT COALESCE(jsonb_agg(to_jsonb(sc.*) ORDER BY sc.created_at DESC), '[]'::jsonb) AS result
      FROM support_codes sc
    `
  ) as Promise<unknown[]>
}

/**
 * サポートコードを新規作成する（`POST /support-codes` 相当）。PostgREST版と同じく
 * `code_hash`/`plan_type`/`memo` は呼び出し元（route handler）でのバリデーションなしで
 * そのまま渡す（不正な値は `support_codes` の CHECK 制約違反として SQL エラーになり、
 * 両経路とも同じ挙動でエラーになる）。`status` は常に `'active'` 固定（PostgREST版と同じ）。
 */
export async function createSupportCodePg(
  env: Record<string, string>,
  payload: { codeHash: string; planType: unknown; memo: unknown }
): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      WITH inserted AS (
        INSERT INTO support_codes (code_hash, plan_type, status, memo)
        VALUES (${payload.codeHash}, ${payload.planType as never}, 'active', ${payload.memo as never})
        RETURNING *
      )
      SELECT to_jsonb(inserted.*) AS result FROM inserted
    `
  )
}

/**
 * サポートコードのステータスを更新する（`PATCH /support-codes/:id` 相当）。
 *
 * PostgreSQLのUPDATE 0件はエラーではなく、SQLSTATEを伴わない正常終了である。
 * `RETURNING`も0行になるため、`rows[0]?.result === undefined`を明示的に検知して
 * HTTP 404へ写像する。権限違反（42501）や制約違反（23xxx）など実際のDB障害は
 * postgres.jsがthrowするので、この分岐では握り潰さず呼び出し元へそのまま伝わる。
 * UI（analysis/src/pages/Licenses.tsx）はこのエラーをconsole出力するだけだが、
 * APIとしては「対象なし」と「DB障害」を分離するほうが正しい。
 *
 * 【もう1つの既知の非対称性】PATCH body に `status` が無い場合（`params.status`
 * が `undefined`）、退役済み Supabase 経路は JSON.stringify で `status` キー自体が
 * 消えるため実質 `updated_at` のみの更新として 200 成功する。pg直結側は
 * postgres.js が `undefined` バインドを UNDEFINED_VALUE で即 throw するため
 * 500 になる。UIは常に `status` を送るため実害はないが、`getGachaSummaryPg`
 * の `?? null` 変換（streamerId向け）とは異なり、ここで `status` を
 * `?? null` しても NOT NULL 制約違反の500になるだけで真の parity にはならない
 * （そもそも「statusキー自体を省略してUPDATE文から除外する」動的SQLが必要になり
 * 過剰実装のため見送った）。
 */
export async function updateSupportCodeStatusPg(
  env: Record<string, string>,
  params: { id: string; status: unknown }
): Promise<unknown> {
  const result = await callAnalysisJsonFunction(
    env,
    (sql) => sql`
      WITH updated AS (
        UPDATE support_codes
        SET status = ${params.status as never}, updated_at = now()
        WHERE id = ${params.id}
        RETURNING *
      )
      SELECT to_jsonb(updated.*) AS result FROM updated
    `
  )
  if (result === undefined) {
    throw Object.assign(new Error('Support code not found'), { statusCode: 404 })
  }
  return result
}

/**
 * サポートコードを無効化する（`POST /support-codes/:id/revoke` 相当）。
 *
 * 【既知の挙動（本移植でも意図的に維持する）】
 * `revoke_support_code()`（00017_add_support_plans.sql）は対象コードが
 * 見つからない場合もSQLエラーにはせず `{error: 'CODE_NOT_FOUND'}` というJSONBを
 * 返すだけで正常終了する。PostgREST版のこのルートはこの戻り値を一切検査せず
 * SQLエラーの有無だけを見て常に `{ok: true}` を返しているため、実在しない
 * code_id を渡しても「revokeに成功した」という応答になる（実害は限定的:
 * `support_codes` 行は物理削除されないため対象取り違えは起きず、通常のUI操作
 * （一覧に表示されているidのみrevokeし、成功後に一覧を再取得する）では
 * この分岐に到達しない。手動でAPIを直接叩いた場合のみ顕在化する）。
 *
 * pg直結側は既存挙動を変えない方針のためこの「成功偽装」を意図的に踏襲するが、
 * 有償アクセスの剥奪に関わる応答がRPCの戻り値本体を検査しないという契約自体は
 * 本来望ましくない。この関数の変更を機に修正するのは本移植の増分スコープを
 * 超えるため、別issueとして起票しRPC戻り値の`error`キーを検査する改修を
 * 検討することを推奨する（本コメントはその検討のための記録）。
 */
export async function revokeSupportCodePg(
  env: Record<string, string>,
  codeId: string
): Promise<{ ok: true }> {
  const sql = getAnalysisSql(env)
  await sql`select revoke_support_code(${codeId})`
  return { ok: true }
}

/**
 * ライセンス一覧をactivated_at降順で返す（`listLicenses()` 相当）。
 * `user_licenses.twitch_user_id` は `users` への外部キーではない単なるTEXT列
 * （ユーザーが未登録でもライセンスは存在しうる）ため、PostgREST版も
 * `Map.get(...) || license.twitch_user_id` で「該当usersが無ければtwitch_user_id
 * そのものを表示名として使う」フォールバックをしている。pg直結では
 * LEFT JOIN + COALESCE で同じフォールバックを1クエリに統合する。
 */
export async function listLicensesPg(env: Record<string, string>): Promise<unknown[]> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_activated_at DESC), '[]'::jsonb) AS result
      FROM (
        SELECT
          to_jsonb(ul.*) || jsonb_build_object(
            'twitch_username', COALESCE(u.twitch_display_name, ul.twitch_user_id)
          ) AS row_json,
          ul.activated_at AS sort_activated_at
        FROM user_licenses ul
        LEFT JOIN users u ON u.twitch_user_id = ul.twitch_user_id
      ) page
    `
  ) as Promise<unknown[]>
}

/**
 * Twitchサブスク保有ユーザー一覧を返す（`GET /twitch-subs` 相当）。
 * count/dataは`getGachaTablePg`と同じく別クエリ2本（`Promise.all`）に分離しており、
 * 同時書き込み（サブスク状態変化）が挟まるとcountとrowsがわずかにずれうる
 * （PostgREST版の `{ count: 'exact' }` は単一クエリで一貫していた）。
 * twitch_has_subの更新頻度は低くgacha_historyほどのトラフィックはないため
 * 実害は小さいと判断し、`countGachaHistory` と同じトレードオフを踏襲する。
 */
export async function listTwitchSubsPg(
  env: Record<string, string>
): Promise<{ rows: unknown[]; count: number }> {
  const sql = getAnalysisSql(env)

  const [countRows, rows] = await Promise.all([
    sql`SELECT count(*)::int AS count FROM users u WHERE u.twitch_has_sub = true`,
    callAnalysisJsonFunction(env, () => sql`
      SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_verified_at DESC), '[]'::jsonb) AS result
      FROM (
        SELECT
          jsonb_build_object(
            'twitch_user_id', u.twitch_user_id,
            'twitch_display_name', u.twitch_display_name,
            'twitch_sub_verified_at', u.twitch_sub_verified_at
          ) AS row_json,
          u.twitch_sub_verified_at AS sort_verified_at
        FROM users u
        WHERE u.twitch_has_sub = true
      ) page
    `) as Promise<unknown[]>,
  ])

  return { rows, count: countRows[0]?.count ?? 0 }
}

/**
 * 問い合わせ一覧を作成日降順で返す（`GET /support-inquiries` 相当）。
 * `status` が `'all'` なら絞り込まない。PostgREST版と同じく
 * `status` の値バリデーションは行わない（CHECK制約に合致しない値は
 * 単に0件ヒットになるだけで実害がないため、既存挙動を維持）。
 *
 * 条件は `status !== 'all'`（退役済み Supabase 経路と厳密に同一）で判定する。
 * `status &&` のような truthy ガードは付けない: ルート側
 * （`localAdminApi.ts`, `url.searchParams.get('status') || 'all'`）では
 * 空文字が渡る経路は存在しないため実害はないが、`status=''` が渡った場合に
 * 退役済み Supabase 経路は絞り込みを適用（0件）する一方 truthy ガードだと pg経路だけ
 * 絞り込みを適用しない（全件を返す）fail-open な非対称になり得るため、
 * 将来の呼び出し元追加に備えて条件式そのものを揃えておく。
 */
export async function getSupportInquiriesPg(
  env: Record<string, string>,
  status: string
): Promise<unknown[]> {
  return callAnalysisJsonFunction(env, (sql) => sql`
    SELECT COALESCE(jsonb_agg(to_jsonb(si.*) ORDER BY si.created_at DESC), '[]'::jsonb) AS result
    FROM support_inquiries si
    WHERE TRUE
    ${status !== 'all' ? sql`AND si.status = ${status}` : sql``}
  `) as Promise<unknown[]>
}

/**
 * 問い合わせのステータスを更新する（`PATCH /support-inquiries/:id` 相当）。
 * `updateSupportCodeStatusPg` と同様、UPDATE 0件はSQLSTATEを伴わないため
 * `RETURNING`の空行を明示的に404へ写像し、本物のDB例外とは分離する。
 * PATCH bodyに`status`キー自体が無い場合、postgres.jsはUNDEFINED_VALUEで
 * 失敗させる。この入力契約は`updateSupportCodeStatusPg`のdocコメントを参照。
 */
export async function updateSupportInquiryStatusPg(
  env: Record<string, string>,
  params: { id: string; status: unknown }
): Promise<unknown> {
  const result = await callAnalysisJsonFunction(
    env,
    (sql) => sql`
      WITH updated AS (
        UPDATE support_inquiries
        SET status = ${params.status as never}, updated_at = now()
        WHERE id = ${params.id}
        RETURNING *
      )
      SELECT to_jsonb(updated.*) AS result FROM updated
    `
  )
  if (result === undefined) {
    throw Object.assign(new Error('Support inquiry not found'), { statusCode: 404 })
  }
  return result
}

/** 問い合わせに紐づくメッセージ一覧を作成日昇順で返す（`GET .../messages` 相当）。 */
export async function listSupportInquiryMessagesPg(
  env: Record<string, string>,
  inquiryId: string
): Promise<unknown[]> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      SELECT COALESCE(
        jsonb_agg(to_jsonb(sim.*) ORDER BY sim.created_at ASC), '[]'::jsonb
      ) AS result
      FROM support_inquiry_messages sim
      WHERE sim.inquiry_id = ${inquiryId}
    `
  ) as Promise<unknown[]>
}

/**
 * 管理者からの返信メッセージを作成する（`POST .../messages` 相当）。
 * `sender_type`/`sender_id` はPostgREST版と同じく常に `'admin'` 固定
 * （管理ダッシュボードからの投稿は常に管理者本人という前提）。
 */
export async function createSupportInquiryMessagePg(
  env: Record<string, string>,
  params: { inquiryId: string; body: string }
): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      WITH inserted AS (
        INSERT INTO support_inquiry_messages (inquiry_id, sender_type, sender_id, body)
        VALUES (${params.inquiryId}, 'admin', 'admin', ${params.body})
        RETURNING *
      )
      SELECT to_jsonb(inserted.*) AS result FROM inserted
    `
  )
}

/** `localAdminApi.ts` の `announcementPayload()` の戻り値と同じ形状。severityの値バリデーションは
 * 行わない（`announcements` テーブルのCHECK制約に委ねる。既存挙動と同じ）。 */
export interface AnnouncementFieldsPayload {
  title: string
  body: string
  severity: unknown
  is_published: boolean
  published_at: string | null
  expires_at: string | null
  updated_at: string
}

/**
 * お知らせ一覧を作成日降順で返す（`GET /announcements` 相当）。PostgREST版は
 * `announcement_reads(count)` のネスト埋め込みcount集約（`listAnnouncements`の
 * コメント参照）で1クエリに収めているが、pg直結側では素直に相関サブクエリで
 * `read_count` を計算し `to_jsonb(a.*) || jsonb_build_object(...)` で行本体に
 * マージする（`listLicensesPg` と同じ「row_json + sort列」パターン）。
 *
 * 件数は `count(*)` ではなく `count(ar.announcement_id)` で数える。理由は2つ:
 * 1) `announcement_id` は NOT NULL かつ `idx_announcement_reads_announcement_id`
 *    に含まれるため index-only scan の対象になり得る（`id`だと対象外でheap
 *    フェッチが要る）。2) テスト側の `fakeSqlTag`（`tests/unit/analysis-admin-db-driver.test.ts`）
 *    は `text.includes('count(*)')` を「独立したcount専用クエリ（`getGachaTablePg`等）」
 *    の目印にしており、`result`列を返すこのクエリに `count(*)` を書くと誤って
 *    `count`列を返す形で解決されテストが壊れる。`updateAnnouncementPg` の
 *    read_countサブクエリも同じ理由で揃えてある。
 */
export async function listAnnouncementsPg(env: Record<string, string>): Promise<unknown[]> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_created_at DESC), '[]'::jsonb) AS result
      FROM (
        SELECT
          to_jsonb(a.*) || jsonb_build_object(
            'read_count',
            (SELECT count(ar.announcement_id) FROM announcement_reads ar WHERE ar.announcement_id = a.id)
          ) AS row_json,
          a.created_at AS sort_created_at
        FROM announcements a
      ) page
    `
  ) as Promise<unknown[]>
}

/**
 * お知らせを新規作成する（`POST /announcements` 相当）。新規作成直後は
 * `announcement_reads` に紐づく行が存在し得ないため、PostgREST版と同じく
 * `read_count` はDBに問い合わせず `0` 固定でマージする。
 */
export async function createAnnouncementPg(
  env: Record<string, string>,
  payload: AnnouncementFieldsPayload
): Promise<unknown> {
  return callAnalysisJsonFunction(
    env,
    (sql) => sql`
      WITH inserted AS (
        INSERT INTO announcements (title, body, severity, is_published, published_at, expires_at, updated_at)
        VALUES (
          ${payload.title}, ${payload.body}, ${payload.severity as never},
          ${payload.is_published}, ${payload.published_at}, ${payload.expires_at}, ${payload.updated_at}
        )
        RETURNING *
      )
      SELECT to_jsonb(inserted.*) || jsonb_build_object('read_count', 0) AS result FROM inserted
    `
  )
}

interface AnnouncementPublishToggleUpdate {
  is_published: boolean
  updated_at: string
}

/**
 * お知らせを更新する（`PATCH /announcements/:id` 相当）。
 *
 * PostgREST版のルートは呼び出し元のPATCH bodyの内容によってSET句が変わる:
 * `title`/`body`/`severity` のいずれかを含む場合は全フィールド更新
 * （`announcementPayload()` 相当）、それ以外（公開状態トグルのみのUI操作）は
 * `is_published`/`updated_at` のみの部分更新。この分岐は呼び出し元
 * （`localAdminApi.ts` の `updateAnnouncement`）に残し、ここでは分岐後の
 * 具体的なSET句を `gachaHistoryFromWhere` と同じくフラグメント合成で組み立てる
 * （postgres.jsの `sql(obj)` 動的ヘルパーは使わない: 既存のfragment合成の仕組みを
 * 再利用でき、テストのfakeSqlTagもタグ付きテンプレートのfragment合成のみ対応済み
 * のため、新しいAPI表面を増やさずに済む）。
 *
 * 対象0件時は `updateSupportCodeStatusPg`/`updateSupportInquiryStatusPg` と同じ。
 * UPDATE 0件はSQLSTATEを伴わない正常終了なので、`RETURNING`の空行をHTTP 404へ
 * 明示的に写像する。DB例外は別経路でthrowされ、この判定に混入しない。
 */
export async function updateAnnouncementPg(
  env: Record<string, string>,
  id: string,
  update: AnnouncementFieldsPayload | AnnouncementPublishToggleUpdate
): Promise<unknown> {
  const result = await callAnalysisJsonFunction(env, (sql) => {
    const setFragment =
      'title' in update
        ? sql`
            title = ${update.title}, body = ${update.body}, severity = ${update.severity as never},
            is_published = ${update.is_published}, published_at = ${update.published_at},
            expires_at = ${update.expires_at}, updated_at = ${update.updated_at}
          `
        : sql`is_published = ${update.is_published}, updated_at = ${update.updated_at}`

    return sql`
      WITH updated AS (
        UPDATE announcements
        SET ${setFragment}
        WHERE id = ${id}
        RETURNING *
      )
      -- 集約関数の選定理由はlistAnnouncementsPgのdocコメント参照
      SELECT to_jsonb(updated.*) || jsonb_build_object(
        'read_count',
        (SELECT count(ar.announcement_id) FROM announcement_reads ar WHERE ar.announcement_id = updated.id)
      ) AS result
      FROM updated
    `
  })
  if (result === undefined) {
    throw Object.assign(new Error('Announcement not found'), { statusCode: 404 })
  }
  return result
}

/**
 * お知らせを削除する（`DELETE /announcements/:id` 相当）。PostgREST版は
 * `.delete().eq('id', id)` の結果件数を検査しない（`error` の有無しか見ない）ため、
 * 存在しないidを渡してもSQLエラーにならない限り `{ok: true}` を返す。この
 * 「削除0件でも成功扱い」という既存挙動をそのまま踏襲し、更新系（404を返す）とは
 * 意図的に非対称にする（`revokeSupportCodePg`の「成功偽装」コメントと同種の既存
 * 挙動維持であり、新たな仕様変更ではない）。
 */
export async function deleteAnnouncementPg(
  env: Record<string, string>,
  id: string
): Promise<{ ok: true }> {
  const sql = getAnalysisSql(env)
  await sql`DELETE FROM announcements WHERE id = ${id}`
  return { ok: true }
}
