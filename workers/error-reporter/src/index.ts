/**
 * Reporter Cron Worker (twica-error-reporter)
 * レポーター定期実行Worker
 *
 * 5分ごとに errors/support_inquiries をポーリングし、2種類の未処理レコードを
 * GitHub Issue 化する:
 *   1. errors           … アプリで捕捉した未処理エラー（シグネチャで重複排除）
 *   2. support_inquiries … 支援者からの新規問い合わせ（メンテナへの通知）
 *
 * いずれも同じ Transactional Outbox パターン（DB をアウトボックスとして使い、
 * 処理済みフラグでリトライ・重複を制御）。GitHub API の薄いラッパを共通ヘルパ
 * として両処理で共有する。単一 Worker に集約することで、secrets・cron・
 * デプロイを1組で済ませ運用を単純化する。
 *
 * DB アクセス方式 (#711 C, 2026-07): Supabase PostgREST（fetch 直叩き）から
 * Hyperdrive 経由の postgres.js 直結へ移行した。Phase2（Supabase→PlanetScale）で
 * PostgREST が権威でなくなるため、fetch ベースの経路のままだと cutover 後に
 * 例外も出さず無音停止するリスクがあった（issue #711 比較コメント参照）。
 * 詳細な設計根拠は createReporterDbClient のコメントを参照。GitHub Issues API
 * 呼び出し（search/create/comment）は引き続き fetch を直接使う（変更なし）。
 *
 * Tail Workers (有料プラン必須) の無料代替として実装。
 * Cloudflare Workers Free プランの Cron Triggers を使用。
 *
 * See: https://github.com/azumag/twica/issues/239 (errors)
 *      https://github.com/azumag/twica/issues/633 (inquiries)
 *      https://github.com/azumag/twica/issues/711 (Phase2 DB移行, C項)
 */

import postgres from 'postgres'

/** GitHub API 呼び出し時の User-Agent（GitHub は User-Agent 必須） */
const USER_AGENT = 'twica-error-reporter'

interface Env {
  /**
   * #711 C: errors/support_inquiries への直接クエリ用 Hyperdrive バインディング。
   * ルート wrangler.toml（メインアプリ）の [[hyperdrive]] binding = "HYPERDRIVE_PLANETSCALE"
   * と同じ Hyperdrive config ID を指す（このワーカーの wrangler.toml 参照）。
   * 同じconfigを共有することで、アプリとreporterが常に同じPlanetScale正本を参照し、
   * 片側だけ別DBへ接続する構成ドリフトを防ぐ。
   *
   * optional にしている理由: RATE_LIMIT_KV と同じく、wrangler.toml の設定漏れを
   * 型レベルでも許容し、scheduled() の起動時バリデーションと
   * createReporterDbClient 内の defensive throw の二段構えで安全に倒すため。
   */
  HYPERDRIVE_PLANETSCALE?: HyperdriveBindingLike
  GITHUB_TOKEN: string
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  /**
   * Issue #695 の代替として承認された KV ベース部分改善の1項目目
   * （EventSub 退避 backlog の監視）で使う KV namespace binding。
   * root wrangler.toml と同じ namespace（id は wrangler.toml 参照）を
   * binding 名 RATE_LIMIT_KV で共用する。このワーカーはキー名の一覧
   * （list）だけを読み、値（get）には触れない。
   *
   * 相互参照（ドリフト防止）: このバインディングで前提にしているキー形式
   * `maintenance:eventsub:<ISO8601受信時刻>:<messageId>` は
   * src/lib/maintenance/eventsub-park.ts の KEY_PREFIX 定義が唯一の
   * ソースであり、このファイルはそれを独立に再実装したものにすぎない
   * （このワーカーパッケージは @/lib/maintenance/eventsub-park.ts を
   * 直接 import できない構成のため）。片方のキー形式を変更したら、
   * 必ずもう片方（EVENTSUB_PARK_KEY_PATTERN 以下）も確認・追従すること。
   *
   * optional にしている理由: wrangler.toml の設定漏れ・古い環境等で binding が
   * 無いケースを型レベルでも許容し、processEventSubParkBacklog 内の defensive
   * チェック（他の secrets と違い早期 return せず個別に no-op する）と対応させる。
   */
  RATE_LIMIT_KV?: EventSubParkKVNamespace

  /**
   * Issue #695 の代替として承認された KV ベース部分改善の2項目目
   * （EventSub 退避 backlog の自動ドレイン）で使う設定・secrets。
   *
   * prod/preview 両方を対象にする理由: errors/inquiries 監視（このワーカー自体）は
   * 本番PlanetScaleのみを見る設計（`.github/workflows/deploy-cloudflare.yml` の
   * `legacy-app-deploy`/`auxiliary-workers` job コメント「Error Reporter Cron
   * Worker のデプロイ（本番のみ）」参照。このワーカー自体、preview 用の
   * デプロイ・secrets を持たない）。しかし EventSub 退避（KV への park）は
   * アプリ本体（Next.js Worker）の処理であり、`twica`（本番）と
   * `twica-preview`（preview）は別々の Cloudflare Workers デプロイ・別ドメイン・
   * 別 KV namespace（root wrangler.toml の [[kv_namespaces]] と
   * [env.preview.kv_namespaces] で id が異なる）を使う。そのため preview 側で
   * maintenance mode を使った検証作業（実績: deploy-architecture メモ参照）を
   * 行った場合、preview 側にも退避データが溜まりうる。errors/inquiries監視が
   * 本番のみで足りるのは、reporterのproduction Hyperdriveが
   * 本番PlanetScaleだけを指すという別の理由によるものであり、
   * EventSub 退避には同じ理由が当てはまらないため、ここでは prod/preview
   * 両方を明示的にドレイン対象にする。
   */
  /** 本番アプリ（`twica`）のベースURL。例: https://twica.bluemoon.works */
  APP_BASE_URL_PROD?: string
  /** preview アプリ（`twica-preview`）のベースURL。例: https://twica-preview.tsubasa-azumagakito.workers.dev */
  APP_BASE_URL_PREVIEW?: string
  /**
   * 本番アプリの `EVENTSUB_REPLAY_SECRET`（`src/app/api/admin/eventsub-replay/
   * route.ts` が検証する共有シークレット）と同じ値を、このワーカー用にも
   * `wrangler secret put EVENTSUB_REPLAY_SECRET_PROD` で設定する想定。
   * prod/preview で別々の secret 値を運用している前提のため（docs/
   * history/migration/DB_PHASE2_RUNBOOK.md 4.3節: 両環境で `openssl rand -hex 32` により
   * 個別に生成・設定済み）、_PROD/_PREVIEW を分けている。未設定の場合は
   * 該当ターゲットへのドレインのみを安全にスキップする
   * （processEventSubParkAutoDrain 参照）。
   */
  EVENTSUB_REPLAY_SECRET_PROD?: string
  /** preview アプリの `EVENTSUB_REPLAY_SECRET` と同じ値。上記コメント参照。 */
  EVENTSUB_REPLAY_SECRET_PREVIEW?: string

  /**
   * Issue #540: EventSub サブスクリプション健全性監視で使う共有シークレット。
   * 本番アプリの `EVENTSUB_HEALTH_SECRET`（`src/app/api/admin/eventsub-health/
   * route.ts` が検証する共有シークレット）と同じ値を、このワーカー用にも
   * `wrangler secret put EVENTSUB_HEALTH_SECRET_PROD` で設定する想定。
   * EVENTSUB_REPLAY_SECRET_PROD/PREVIEW と同じ理由で prod/preview を分ける。
   * 未設定の場合は該当ターゲットへのヘルスチェックのみを安全にスキップする
   * （processEventSubSubscriptionHealth 参照）。
   */
  EVENTSUB_HEALTH_SECRET_PROD?: string
  /** preview アプリの `EVENTSUB_HEALTH_SECRET` と同じ値。上記コメント参照。 */
  EVENTSUB_HEALTH_SECRET_PREVIEW?: string
}

/**
 * Cloudflare Workers KV namespace の最小インターフェース。
 * @cloudflare/workers-types のグローバル `KVNamespace` 型はあえて使わない
 * （src/lib/maintenance/eventsub-park.ts の KVNamespaceLike と同じ方針）。
 * 理由: このファイルはルート tsconfig.json の exclude 対象だが、
 * tests/unit/error-reporter-worker.test.ts からの import 経由でルートの
 * `tsc --noEmit` の型チェック対象グラフに入る。ルート側には
 * @cloudflare/workers-types が入っていないため、グローバル型に依存すると
 * ルートの typecheck が壊れる。実際に使う list() だけを最小定義することで
 * この依存を断ち切る。
 */
interface EventSubParkKVNamespace {
  /**
   * cursor は Major-1 対応（tombstone 追従の cursor ページネーション）で追加。
   * 戻り値の cursor は list_complete=false の場合に次回呼び出しへ渡す
   * （Cloudflare Workers KV のページネーション仕様どおり）。
   */
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * Hyperdrive バインディングの最小インターフェース。
 * src/lib/db/client.ts の HyperdriveBindingLike と同じ最小定義（理由も同じ）:
 * @cloudflare/workers-types のグローバル型に依存すると、このファイルを import する
 * tests/unit/error-reporter-worker.test.ts 経由でルートの `tsc --noEmit` が
 * 壊れる（ルート側に @cloudflare/workers-types が入っていないため。
 * EventSubParkKVNamespace のコメント参照）。
 */
interface HyperdriveBindingLike {
  connectionString: string
}

// =============================================================================
// 共通ヘルパ: errors/support_inquiries への DB アクセス (#711 C)
//
// Hyperdrive バインディング経由で PostgreSQL に postgres.js で直結する。
// メインアプリ（src/lib/db/client.ts）と同じPlanetScale Hyperdrive configを
// 指すため、errors/support_inquiriesを別DBへ誤配線しない。
//
// メインアプリの getDb() との違い（意図的な簡略化。YAGNI）:
//   - Drizzle は使わず raw SQL（postgres.js のタグ付きテンプレート）のみ。
//     この Worker は別パッケージであり src/lib/db/schema.ts を安全に import
//     できない（tsconfig・ビルド設定が別。EventSubParkKVNamespace 節と同じ理由）。
//     クエリも SELECT 2種 + UPDATE 2種と単純なため、スキーマ共有の恩恵が薄い。
//   - リクエストスコープの WeakMap キャッシュは持たない。この Worker は
//     Cron Trigger の呼び出し1回につき processErrors()/processInquiries() が
//     それぞれ独立してクライアントを1つ生成するだけで、呼び出しを跨いで
//     再利用するモジュールレベルのシングルトンを一切持たない。そのため
//     src/lib/db/client.ts が対策しているリクエストスコープ跨ぎの
//     'Cannot perform I/O on behalf of a different request' は構造的に発生しない。
//   - 明示的な sql.end() は呼ばない（メインアプリと同じ判断）。Workers ランタイムは
//     呼び出し終了時にその呼び出しが開いた TCP ソケットを破棄し、Hyperdrive 側は
//     実接続をプールしたまま維持するためリークしない。
// =============================================================================

/**
 * postgres.js が接続文字列内で認識しない `sslrootcert` クエリパラメータを取り除き、
 * 必要なら `sslmode=verify-full` を補う純粋関数。
 *
 * 詳細な背景・postgres.js 内部の行番号根拠・sslmode 未指定時に平文接続へ
 * サイレントダウングレードする問題とその対策の設計根拠は、正本である
 * `scripts/lib/db-migrate-core.js` の同名関数の JSDoc を参照。ロジックは常に
 * そちらと同期させること（analysis/dev/adminApiPg.ts が同じ理由で持つ独立
 * コピーと同じ位置付け）。
 *
 * このファイルへ複製する理由: このワーカーは root とは別のデプロイ単位
 * （wrangler がこのディレクトリを直接バンドルする。EventSubParkKVNamespace
 * 節と同じ理由）であり、root の scripts/lib を import すると依存関係が
   * この Worker のバンドルへ暗黙に広がる。PlanetScaleの接続文字列に含まれ得る
   * sslrootcertをこのデプロイ単位でも同じ規則で除去し、TLS検証を維持する。
 *
 * export する理由: tests/unit/error-reporter-worker.test.ts の契約テストが、
 * 正本 scripts/lib/db-migrate-core.js の同名関数と代表的な入力で出力が
 * 一致することを検証し、複製のドリフトを機械的に検知するため
 * （EVENTSUB_PARK_KEY_PREFIX の契約テストと同じ方針）。
 */
export function stripPostgresJsIncompatibleSslParams(connectionString: string): string {
  if (!connectionString) return connectionString
  try {
    const url = new URL(connectionString)
    const hadSslRootCert = url.searchParams.has('sslrootcert')
    url.searchParams.delete('sslrootcert')
    if (hadSslRootCert && !url.searchParams.get('sslmode')) {
      url.searchParams.set('sslmode', 'verify-full')
    }
    return url.toString()
  } catch {
    return connectionString
  }
}

/**
 * timestamptz(OID 1184) を postgres.js の既定動作（JS Date への自動変換）から
 * 除外し、PostgreSQL のワイヤ形式テキスト（例 '2026-07-21 12:34:56.789+00'）の
 * まま返す。
 *
 * このパーサが防ぐのは「Date への変換とその後の暗黙の toString()」であり、
 * 日時の表記形式そのものは変わる点に注意（m-1, Fableレビュー指摘で明確化）:
 * 旧 PostgREST 応答は ISO 8601（例 '2026-01-01T00:00:00.000Z'、'T'区切り・
 * ミリ秒3桁・末尾Z）だったが、このパーサを入れても PostgreSQL のワイヤ形式
 * （空白区切り・オフセットは '+00' 等）のまま返る。identity 関数はあくまで
 * 「Date オブジェクト化を止める」だけで、ISO 8601 への正規化までは行わない。
 *
 * それでも問題にならない理由: この Worker は created_at を GitHub Issue 本文へ
 * 文字列として埋め込んで表示するだけで、Date として再パースすることは無い
 * （generateSignature/buildInquiryIssue 等はいずれも文字列補間のみ）。
 * 表記形式の違いは人間が Issue 本文を読む上での見た目の差でしかなく、
 * 下流のパース処理には一切影響しない。一方 identity 関数を入れずに
 * postgres.js の既定動作（Date への自動変換）に任せた場合は、Date オブジェクトが
 * テンプレートリテラルへ渡された際に暗黙の toString() が発火し、実行環境依存の
 * ローカルタイムゾーン・曜日名付きの読みにくい形式（例
 * 'Mon Jul 21 2026 12:34:56 GMT+0000 (Coordinated Universal Time)'）に変換
 * されてしまう（実機の Postgres で確認済み）。このパーサはその劣化だけを防ぐ。
 *
 * メインアプリ（src/lib/db/client.ts の installIsoTimestampParsers）は
 * フロントエンドでの new Date() 再パース（Safari 対応）のため ISO 8601 へ
 * 正規化する複雑なパーサを使うが、この Worker は再パースを一切行わないため
 * identity 関数で十分（YAGNI）。
 *
 * sql.options.parsers[oid] への「プロパティ単位」の代入である必要がある理由
 * （オブジェクト自体の差し替え禁止）・クライアント生成直後かつ最初のクエリ
 * 発行前に完了させる必要がある理由は、src/lib/db/client.ts の
 * installIsoTimestampParsers 冒頭コメントと同じ（postgres.js の内部実装に
 * 依拠する制約のため、呼び出し元 createReporterDbClient で同じ順序を守る）。
 */
function installRawTimestampParser(client: postgres.Sql): void {
  client.options.parsers[1184] = (value: string) => value
}

/**
 * errors/support_inquiries 用の postgres.js クライアントを生成する。
 *
 * オプションの根拠（メインアプリの createHandle との違いのみ記載。共通する
 * 理由は src/lib/db/client.ts 参照）:
 * - max: 1
 *   メインアプリ（Web リクエスト、複数クエリが同時に飛びうる）の max: 5 と異なり、
 *   この Worker は1回の呼び出し内で常に直列に（SELECT → UPDATE の順で、同時に
 *   複数クエリを投げることなく）実行するため1接続で足りる。上流の Hyperdrive
 *   接続プール（メインアプリと共有の枠）の消費を抑える。
 * - fetch_types は明示的に false にしない（メインアプリと異なる判断、実機確認済み）:
 *   markErrorsAsProcessed の `WHERE id = ANY($1::uuid[])` は、postgres.js が
 *   接続時に型カタログを取得する（既定 fetch_types: true）前提でのみ正しい
 *   PostgreSQL 配列リテラルを送出する。fetch_types: false にすると配列引数が
 *   カンマ区切りの生文字列として送られ `malformed array literal` で失敗する
 *   （ローカル Docker Postgres で実機確認済み）。この Worker は5分に1回・
 *   高々数クエリしか投げないため、型カタログ取得の往復コストより配列引数の
 *   正しさを優先する。
 */
function createReporterDbClient(env: Env): postgres.Sql {
  if (!env.HYPERDRIVE_PLANETSCALE) {
    throw new Error('[Reporter] Missing HYPERDRIVE_PLANETSCALE binding in wrangler.toml')
  }
  const sql = postgres(stripPostgresJsIncompatibleSslParams(env.HYPERDRIVE_PLANETSCALE.connectionString), {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
  })
  installRawTimestampParser(sql)
  return sql
}

// =============================================================================
// 共通ヘルパ: GitHub Issues API
// @octokit は使わず raw fetch（バンドルサイズ最小化）。
// =============================================================================

/** GitHub API 共通ヘッダ。json=true で Content-Type を付与。 */
function githubHeaders(env: Env, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  }
  if (json) {
    headers['Content-Type'] = 'application/json'
  }
  return headers
}

/**
 * GitHub Issues Search API で既存 Issue を検索する。
 * Issue 本文に埋め込んだマーカー（Signature / Inquiry-ID 等）で照合し、
 * 重複作成を防止する。API 失敗時は例外を投げず null を返す。
 *
 * 検索は best-effort（GitHub の検索インデックスは非同期更新のため、作成直後の
 * Issue はヒットしないことがある）。冪等性の本命は呼び出し元の処理済みフラグ。
 */
async function searchIssue(
  env: Env,
  query: string
): Promise<{ number: number; url: string } | null> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: githubHeaders(env) })

  if (!res.ok) {
    console.warn(`[Reporter] GitHub search API failed: ${res.status}`)
    return null
  }

  const data = (await res.json()) as {
    total_count: number
    items: Array<{ number: number; html_url: string }>
  }
  if (data.total_count > 0) {
    return { number: data.items[0].number, url: data.items[0].html_url }
  }
  return null
}

/**
 * GitHub Issue を新規作成する。
 * @throws API がエラーを返した場合（呼び出し元で処理済みマークをスキップさせる）
 */
async function postGitHubIssue(
  env: Env,
  payload: { title: string; body: string; labels: string[] }
): Promise<{ number: number; url: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues`,
    {
      method: 'POST',
      headers: githubHeaders(env, true),
      body: JSON.stringify(payload),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API error: ${res.status} ${text}`)
  }

  const issue = (await res.json()) as { number: number; html_url: string }
  return { number: issue.number, url: issue.html_url }
}

/**
 * 既存 Issue にコメントを追加する。
 * @throws API がエラーを返した場合
 */
async function postIssueComment(env: Env, issueNumber: number, body: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(env, true),
      body: JSON.stringify({ body }),
    }
  )

  if (!res.ok) {
    throw new Error(`Failed to add comment to issue #${issueNumber}: ${res.status}`)
  }
}

// =============================================================================
// エラー処理（errors テーブル → GitHub Issue）
// =============================================================================

/** PlanetScale errorsテーブルのレコード型。 */
interface ErrorRecord {
  id: string
  error_type: string
  message: string
  stack_trace: string | null
  context: Record<string, unknown>
  environment: string
  created_at: string
}

/** 同一シグネチャのエラーをまとめたグループ */
interface ErrorGroup {
  signature: string
  errors: ErrorRecord[]
  count: number
  firstSeen: string
  lastSeen: string
}

/**
 * エラーシグネチャを生成する。
 * error_type + message の先頭行 + スタックトレースの先頭行 を組み合わせ、
 * 同一のエラーを1つの GitHub Issue にまとめるために使用。
 * SHA-256 で固定長ハッシュにし、Issue 本文内での検索・照合を容易にする。
 */
async function generateSignature(error: ErrorRecord): Promise<string> {
  const messageLine = error.message.split('\n')[0].slice(0, 200)
  const stackLine = error.stack_trace?.split('\n')[0]?.slice(0, 200) || ''
  const raw = `${error.error_type}:${messageLine}:${stackLine}`

  const encoder = new TextEncoder()
  const data = encoder.encode(raw)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  // 先頭16文字で十分な一意性を確保（衝突確率は無視できるレベル）
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** エラーをシグネチャでグループ化する（同一シグネチャは1つの Issue にまとめる）。 */
async function groupErrors(errors: ErrorRecord[]): Promise<ErrorGroup[]> {
  const groups = new Map<string, ErrorRecord[]>()

  for (const error of errors) {
    const sig = await generateSignature(error)
    if (!groups.has(sig)) {
      groups.set(sig, [])
    }
    groups.get(sig)!.push(error)
  }

  return Array.from(groups.entries()).map(([signature, errs]) => ({
    signature,
    errors: errs,
    count: errs.length,
    // errs は created_at ASC (FIFO) で取得されるため、最初=最古、最後=最新
    firstSeen: errs[0].created_at,
    lastSeen: errs[errs.length - 1].created_at,
  }))
}

/** 既存 Issue を Signature ハッシュで検索する（重複作成防止）。 */
async function findExistingErrorIssue(
  signature: string,
  env: Env
): Promise<{ number: number; url: string } | null> {
  const query = `repo:${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME} is:issue "Signature: ${signature}"`
  return searchIssue(env, query)
}

/**
 * GitHub Issue を新規作成する（エラー用）。
 * Signature は重複検索に使用されるため、フォーマットを変更しないこと。
 */
async function createErrorIssue(
  group: ErrorGroup,
  env: Env
): Promise<{ number: number; url: string }> {
  const first = group.errors[0]

  // タイトル: 環境 + エラー種別 + メッセージ先頭（最大80文字）
  const title = `[${first.environment}] ${first.error_type} ${first.message.split('\n')[0]}`.slice(0, 80)

  const body = `## Auto-generated Error Report

**Type**: \`${first.error_type}\`
**Environment**: ${first.environment}
**Occurrences**: ${group.count}x
**First Seen**: ${group.firstSeen}
**Last Seen**: ${group.lastSeen}

### Message
\`\`\`
${first.message.slice(0, 2000)}
\`\`\`

### Stack Trace
\`\`\`
${first.stack_trace?.slice(0, 3000) || 'N/A'}
\`\`\`

### Context
\`\`\`json
${JSON.stringify(first.context, null, 2).slice(0, 2000)}
\`\`\`

---
Signature: ${group.signature}
*Auto-generated by [twica-error-reporter](https://github.com/azumag/twica/issues/239)*`

  const labels = ['bug', 'auto-generated']
  if (first.environment !== 'production') {
    labels.push(first.environment)
  }

  return postGitHubIssue(env, { title, body, labels })
}

/** 既存 Issue にコメントを追加する（再発通知）。 */
async function addCommentToIssue(
  issueNumber: number,
  group: ErrorGroup,
  env: Env
): Promise<void> {
  const body = `## Error Recurrence

**New occurrences**: ${group.count}x
**Last Seen**: ${group.lastSeen}

This error has reoccurred. Please investigate if still unresolved.`

  // コメント追加失敗時は throw して markErrorsAsProcessed をスキップさせる
  // （throw しないと「処理済み」マークされ、GitHub Issue への追記が永久に失われる）。
  await postIssueComment(env, issueNumber, body)
}

/**
 * errors テーブルのレコードを処理済みに更新する。
 *
 * PostgREST の `id=in.(...)` フィルタ意味論を `WHERE id = ANY($1::uuid[])` で
 * 忠実に再現する（#711 比較コメント§3 の必須付帯作業）。`::uuid[]` の明示
 * キャストを付ける理由: postgres.js は拡張プロトコルで配列パラメータの要素型を
 * 実行時に推論するため理論上キャスト無しでも解決されうるが、その推論に
 * 依存せず SQL 側で型を確定させることで意図を自己文書化し、将来 postgres.js の
 * 挙動が変わっても壊れない防御的な実装にする（SQL インジェクション面での
 * パラメータバインドは `${errorIds}` 自体で既に確保されている）。
 */
async function markErrorsAsProcessed(
  sql: postgres.Sql,
  errorIds: string[],
  issueNumber: number,
  issueUrl: string
): Promise<void> {
  await sql`
    UPDATE errors
    SET github_issue_created = true, github_issue_number = ${issueNumber}, github_issue_url = ${issueUrl}
    WHERE id = ANY(${errorIds}::uuid[])
  `
}

/**
 * 未処理エラーを取得する。
 * github_issue_created = false を古い順（FIFO）で最大100件。
 * 古い順にすることで、上限到達時も古いエラーが飢餓状態にならない。
 * PostgREST の `github_issue_created=eq.false&order=created_at.asc&limit=100`
 * フィルタ意味論を SQL で忠実に再現する（#711 比較コメント§3）。
 */
async function fetchPendingErrors(sql: postgres.Sql): Promise<ErrorRecord[]> {
  return sql<ErrorRecord[]>`
    SELECT id, error_type, message, stack_trace, context, environment, created_at
    FROM errors
    WHERE github_issue_created = false
    ORDER BY created_at ASC
    LIMIT 100
  `
}

/**
 * エラー処理本体。
 * 1. 未処理エラーを取得 → 2. シグネチャでグループ化 → 3. 既存 Issue 検索
 *    （あり=コメント / なし=新規作成）→ 4. 処理済みマーク。
 */
export async function processErrors(env: Env): Promise<void> {
  console.log('[Error Reporter] Started')

  const sql = createReporterDbClient(env)
  const errors = await fetchPendingErrors(sql)
  if (errors.length === 0) {
    console.log('[Error Reporter] No pending errors')
    return
  }

  console.log(`[Error Reporter] Processing ${errors.length} errors`)

  const groups = await groupErrors(errors)
  console.log(`[Error Reporter] ${groups.length} unique error groups`)

  // 1回の実行で新規作成する Issue 数の上限（バースト時の Issue 乱立を防止）
  const MAX_NEW_ISSUES_PER_RUN = 5
  let newIssuesCreated = 0

  for (const group of groups) {
    try {
      const existing = await findExistingErrorIssue(group.signature, env)

      let issueNumber: number
      let issueUrl: string

      if (existing) {
        issueNumber = existing.number
        issueUrl = existing.url
        await addCommentToIssue(issueNumber, group, env)
        console.log(`[Error Reporter] Added comment to existing issue #${issueNumber}`)
      } else {
        if (newIssuesCreated >= MAX_NEW_ISSUES_PER_RUN) {
          console.log(`[Error Reporter] Max new issues limit (${MAX_NEW_ISSUES_PER_RUN}) reached. Deferring group: ${group.signature}`)
          continue
        }
        const issue = await createErrorIssue(group, env)
        issueNumber = issue.number
        issueUrl = issue.url
        newIssuesCreated++
        console.log(`[Error Reporter] Created issue #${issueNumber}: ${issueUrl}`)
      }

      const errorIds = group.errors.map(e => e.id)
      await markErrorsAsProcessed(sql, errorIds, issueNumber, issueUrl)
    } catch (err) {
      // 個別グループのエラーは他のグループの処理を阻害しない
      console.error(`[Error Reporter] Failed to process group ${group.signature}:`, err)
    }
  }

  console.log(`[Error Reporter] Completed (${newIssuesCreated} new issues created)`)
}

// =============================================================================
// 問い合わせ処理（support_inquiries テーブル → GitHub Issue）
// error 処理との違い: 問い合わせは1件ずつ一意なのでグループ化・再発コメント不要。
// =============================================================================

/** PlanetScale support_inquiriesテーブルのレコード型（Issue化に必要な列のみ）。 */
interface InquiryRecord {
  id: string
  twitch_user_id: string
  twitch_display_name: string
  // 'bug' | 'feature' | 'other'
  category: string
  subject: string
  body: string
  created_at: string
}

/**
 * 1回の実行で処理する問い合わせの最大件数。
 * fetchPendingInquiries の SQL LIMIT にも使い、1件ごとに走る GitHub Search の
 * 回数を抑える。問い合わせは低頻度なので通常はほぼ 0 件。
 */
const MAX_INQUIRIES_PER_RUN = 10

/** カテゴリコード → 日本語表示名 */
const INQUIRY_CATEGORY_LABELS: Record<string, string> = {
  bug: 'バグ報告',
  feature: '機能要望',
  other: 'その他',
}

/** カテゴリの日本語表示名を返す（未知の値はそのままフォールバック） */
function inquiryCategoryLabel(category: string): string {
  return INQUIRY_CATEGORY_LABELS[category] ?? category
}

/**
 * 本文を安全にコードフェンスで囲む。
 * 本文中のバッククォート連の最大長 + 1 のフェンスを使うことで、本文から
 * フェンスを脱出して偽の `Inquiry-ID:` 行などを混入させる余地をなくす。
 */
function fenceInquiryBody(body: string): string {
  const runs = body.match(/`+/g)
  const longest = runs ? Math.max(...runs.map(r => r.length)) : 0
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${body}\n${fence}`
}

/**
 * ユーザー入力を安全なインラインコードスパンとして描画する。
 * 改行を空白へ畳んで1行に収め、markdown 描画（@メンションによる他ユーザーへの
 * 通知スパム・画像/リンク・整形崩し）や偽の見出し行の注入を無効化する。
 * 値に含まれるバッククォート連より1つ長いデリミタを使い、必要なら CommonMark に
 * 従いスペースパディングしてエスケープする。件名・表示名など fenced ブロック外に
 * 展開する自由入力フィールドに使う（本文は fenceInquiryBody で保護済み）。
 */
function inlineCode(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  const runs = collapsed.match(/`+/g)
  const ticks = '`'.repeat((runs ? Math.max(...runs.map(r => r.length)) : 0) + 1)
  // 先頭/末尾がバッククォートだとデリミタと隣接して壊れるためスペースパディング
  const needsPad = collapsed.startsWith('`') || collapsed.endsWith('`')
  const inner = needsPad ? ` ${collapsed} ` : collapsed
  return `${ticks}${inner}${ticks}`
}

/**
 * 未処理問い合わせを取得する（FIFO・上限つき・必要列のみ）。
 * PostgREST の `select=${INQUIRY_SELECT_COLUMNS}&github_issue_created=eq.false&
 * order=created_at.asc&limit=${MAX_INQUIRIES_PER_RUN}` フィルタ意味論を SQL で
 * 忠実に再現する（#711 比較コメント§3）。列名は識別子でありプレースホルダ
 * バインドの対象外のため、InquiryRecord に対応する列（body 以外の余計な列は
 * 引かない）をそのまま SQL に書き下す。LIMIT は値なので通常どおりバインドする。
 */
async function fetchPendingInquiries(sql: postgres.Sql): Promise<InquiryRecord[]> {
  return sql<InquiryRecord[]>`
    SELECT id, twitch_user_id, twitch_display_name, category, subject, body, created_at
    FROM support_inquiries
    WHERE github_issue_created = false
    ORDER BY created_at ASC
    LIMIT ${MAX_INQUIRIES_PER_RUN}
  `
}

/**
 * 問い合わせから GitHub Issue のペイロードを組み立てる。
 * リポジトリは private のためメンテナが対応に必要な投稿者情報も含める。
 * 末尾の `Inquiry-ID:` 行は重複検索のマーカーなのでフォーマットを変更しないこと。
 */
function buildInquiryIssue(inquiry: InquiryRecord): { title: string; body: string; labels: string[] } {
  const label = inquiryCategoryLabel(inquiry.category)
  // タイトル: 一覧で判別しやすい接頭辞 + 件名。改行を除去し120字上限に丸める。
  const singleLineSubject = inquiry.subject.replace(/\s+/g, ' ').trim()
  const title = `[問い合わせ/${label}] ${singleLineSubject}`.slice(0, 120)

  // fenced ブロック外に出す自由入力フィールドは inlineCode で無害化する
  // （投稿者による @メンション通知スパム・リンク/画像・偽の見出し行注入を防ぐ）。
  const body = `## 新規問い合わせ

**カテゴリ**: ${inlineCode(label)} (${inlineCode(inquiry.category)})
**投稿者**: ${inlineCode(inquiry.twitch_display_name)} (${inlineCode(inquiry.twitch_user_id)})
**件名**: ${inlineCode(inquiry.subject)}
**投稿日時**: ${inquiry.created_at}

### 本文
${fenceInquiryBody(inquiry.body)}

---
返信はダッシュボードの問い合わせ管理画面から行ってください。
Inquiry-ID: ${inquiry.id}
*Auto-generated by twica-error-reporter — https://github.com/azumag/twica/issues/633*`

  // 自動生成であることを明示するラベル（存在しなければ GitHub が自動作成する）。
  return { title, body, labels: ['support-inquiry', 'auto-generated'] }
}

/**
 * 問い合わせを処理済みに更新する（発行した Issue の番号・URL を記録）。
 * この PATCH は support_inquiries の update_support_inquiries_updated_at トリガ
 * (00019) を発火させ、対象行の updated_at を発行時刻に1度だけ書き換える。
 * ユーザー向け一覧・詳細は created_at ソートで updated_at に依存しないため実害は
 * 無いが、将来 updated_at を「最終更新」として表示する場合は考慮すること。
 */
async function markInquiryProcessed(
  sql: postgres.Sql,
  id: string,
  issueNumber: number,
  issueUrl: string
): Promise<void> {
  // PostgREST の `id=eq.${id}` フィルタ意味論を再現する。id はパラメータバインド
  // されるため、旧実装の encodeURIComponent（URL クエリ文字列エスケープ用）は
  // 不要（SQL パラメータバインドはそもそも URL エンコーディングの対象ではない）。
  await sql`
    UPDATE support_inquiries
    SET github_issue_created = true, github_issue_number = ${issueNumber}, github_issue_url = ${issueUrl}
    WHERE id = ${id}
  `
}

/**
 * 問い合わせ処理本体。
 * 各件について既存 Issue を検索（冪等性の保険）→ 無ければ新規作成 →
 * 既存/新規いずれでも必ず処理済みマーク。
 */
export async function processInquiries(env: Env): Promise<void> {
  console.log('[Inquiry Reporter] Started')

  const sql = createReporterDbClient(env)
  const inquiries = await fetchPendingInquiries(sql)
  if (inquiries.length === 0) {
    console.log('[Inquiry Reporter] No pending inquiries')
    return
  }

  console.log(`[Inquiry Reporter] Processing ${inquiries.length} inquiries`)

  let created = 0

  for (const inquiry of inquiries) {
    try {
      // 冪等性の保険: 直前の実行で「作成成功 → 処理済みマーク失敗」となった場合に
      // 二重作成しないよう既存 Issue を検索する。本命の冪等性は github_issue_created
      // フラグ + create→mark の順序であり、検索は非同期インデックス依存の補助。
      // label:support-inquiry も条件に含め、無関係 Issue の本文に同じ文字列が
      // 偶然/意図的に含まれていた場合の誤マッチ面を減らす。
      const query = `repo:${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME} is:issue label:support-inquiry "Inquiry-ID: ${inquiry.id}"`
      const existing = await searchIssue(env, query)

      let issueNumber: number
      let issueUrl: string

      if (existing) {
        issueNumber = existing.number
        issueUrl = existing.url
        console.log(`[Inquiry Reporter] Existing issue #${issueNumber} found for inquiry ${inquiry.id}, skipping create`)
      } else {
        const issue = await postGitHubIssue(env, buildInquiryIssue(inquiry))
        issueNumber = issue.number
        issueUrl = issue.url
        created++
        console.log(`[Inquiry Reporter] Created issue #${issueNumber} for inquiry ${inquiry.id}: ${issueUrl}`)
      }

      // 既存・新規いずれの場合でも必ず処理済みマークする。
      // これを怠ると、既存 Issue があるのに github_issue_created=false のまま残り、
      // 毎回 GitHub Search を無駄に叩き続ける「飢餓 + 無限 search」状態に陥る。
      await markInquiryProcessed(sql, inquiry.id, issueNumber, issueUrl)
    } catch (err) {
      // 個別問い合わせのエラーは他の問い合わせの処理を阻害しない
      console.error(`[Inquiry Reporter] Failed to process inquiry ${inquiry.id}:`, err)
    }
  }

  console.log(`[Inquiry Reporter] Completed (${created} new issues created)`)
}

// =============================================================================
// EventSub 退避 backlog 監視（RATE_LIMIT_KV → GitHub Issue）
//
// Issue #695（EventSub の Cloudflare Queue 化）の代替として承認された、
// KV ベース部分改善の1項目目。maintenance mode 中に退避された EventSub
// notification（src/lib/maintenance/eventsub-park.ts 参照）が、リプレイ
// 忘れ・maintenance mode 解除忘れ等で KV に滞留していないかを監視する。
//
// errors / support_inquiries との違い:
//   - 「処理済みフラグ」を持つ DB テーブルではなく、KV の現在時点の
//     スナップショット（キー一覧）を毎回読み直すだけ。そのため
//     「未処理を取得して処理済みにマークする」というトランザクショナル
//     アウトボックスの形は取れない。
//   - 値（get）は読まない。キー名 `maintenance:eventsub:<ISO8601受信時刻>:
//     <messageId>` から件数・最古受信時刻がそのまま分かるため、
//     KV 読み取り課金・レイテンシの両方を抑えられる（list のみで完結）。
// =============================================================================

/**
 * 退避データのキープレフィックス。
 * 相互参照: src/lib/maintenance/eventsub-park.ts の KEY_PREFIX 定数と
 * 完全に一致していなければならない。あちらを変更したらここも変更すること。
 *
 * ドリフトの機械的検知（Fable レビュー Major-3 対応）: export し、
 * tests/unit/error-reporter-worker.test.ts の契約テストで
 * src/lib/maintenance/eventsub-park.ts の export された KEY_PREFIX /
 * buildParkedEventSubKey と実際に一致するか（このワーカー独自実装が生成した
 * キーを本家の関数が作ったキーと突き合わせて）検証する。これによりコメントでの
 * 相互参照だけに頼らず、どちらかがドリフトしたらテストが赤くなるようにする。
 */
export const EVENTSUB_PARK_KEY_PREFIX = 'maintenance:eventsub:'

/**
 * プレフィックスを除いた残り部分（`<ISO8601受信時刻>:<messageId>`）の先頭が
 * ISO8601 タイムスタンプであることを検証しつつ、その部分だけを抽出する正規表現。
 * `Date.prototype.toISOString()` は常に `YYYY-MM-DDTHH:mm:ss.sssZ`
 * （ミリ秒3桁・末尾Z固定）の形式を返す仕様（ECMA-262）であることに依拠している。
 * 相互参照: src/lib/maintenance/eventsub-park.ts の
 * `${KEY_PREFIX}${receivedAt}:${input.messageId}` というキー組み立てと対。
 * あちらのキー形式（区切り文字・時刻フォーマット）を変更したら、この正規表現も
 * 追従して変更すること。
 */
const EVENTSUB_PARK_RECEIVED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):/

/**
 * バックログ監視の閾値。KV の値は読まずキー一覧のみから判定するため、
 * どちらも「キー名から機械的に分かる情報」だけで計算できる。
 *
 * - EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD（件数、10件）:
 *   maintenance mode は本来まれにしか有効化されず、有効化される場合も
 *   短時間の cutover 作業が主目的（eventsub-park.ts の TTL 選定コメント参照）。
 *   10件は「一時的な数件のブレ」を許容しつつ「明らかに退避が溜まり続けている」
 *   状態を検知できる保守的な値として仮置きした。
 * - EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD（経過時間、30分）:
 *   通常の cutover 作業は数時間〜長くて1日程度で完了する想定だが、
 *   30分はそれよりかなり短い値をあえて選んでいる。理由は「リプレイ忘れ・
 *   maintenance 解除忘れ」を早期検知したいため（偽陽性より見逃し防止を優先）。
 *
 * どちらも「issue #695 側に具体的な数値指定はないため仮の値」であり、
 * 実運用実績を見て Stage 7 の runbook 整備時に見直す前提（eventsub-park.ts
 * の TTL 選定コメントと同じ立て付け）。
 */
const EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD = 10
const EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD = 30

/**
 * count===0 かつ list_complete=false（tombstone 追従、Major-1 対応）の場合に
 * 追加で辿る cursor ページ数の上限。
 *
 * 背景: Cloudflare Workers KV 公式ドキュメントによれば、最近失効・削除された
 * キー（tombstone）は list() の返す keys 配列には含まれないが、ページ内部では
 * 走査されるため、tombstone だけで1ページ（limit 件）が埋まることがある。
 * その結果「生キー0件（keys=[]）だが list_complete=false」という、素朴には
 * 「0件確定」に見えて実際には後続ページに生きたキーが存在しうる状態が起こる。
 * これを単純に count===0 として扱うと、実際には backlog が存在するのに
 * "No parked notifications" と誤報し監視が盲目化する（Fable レビュー Major-1）。
 *
 * 上限を設ける理由: tombstone が異常に連続した場合の無限ループ・レイテンシ膨張・
 * KV 課金増大を防ぐため。この監視の閾値はたった10件であり、正確な全件取得に
 * 際限なくコストを払う価値はない（YAGNI）。上限に達してもなお解決しない場合は
 * 安全側に倒し、「0件（backlogなし）」と断定せず unknown として扱う
 * （下記 getEventSubParkBacklogStats 参照）。
 */
const EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT = 3

/**
 * Issue 本文の末尾に埋め込む識別用マーカー文字列。
 *
 * Major-2 対応より前は、これを GitHub Issue Search のクエリに含めて重複起票を
 * 防止していたが、現在は重複防止の判定に使っていない（下記
 * findOpenEventSubParkBacklogIssue のコメント参照）。人間が Issue 本文を見て
 * 「このワーカーが起票したものだ」と識別できるドキュメンテーション目的で
 * 残している。
 */
const EVENTSUB_PARK_BACKLOG_MARKER = 'Monitor: eventsub-park-backlog'

/**
 * backlog 監視専用の GitHub ラベル（Major-2 対応）。
 * findOpenEventSubParkBacklogIssue が Issues List API
 * （state=open&labels=...）で「このワーカーが起票した未対応の backlog Issue」を
 * 機械的に絞り込むために使う。誤マッチ防止（誰かが本文にマーカー文字列を
 * 引用しただけの無関係 Issue を拾わないこと）を、全文検索ではなくラベルという
 * メタデータで行う（support_inquiries 監視の label:support-inquiry と同じ方針）。
 */
const EVENTSUB_PARK_BACKLOG_LABEL = 'eventsub-park-backlog'

/** getEventSubParkBacklogStats の戻り値。 */
interface EventSubParkBacklogStats {
  /** 取得できたキー件数（1回の list 呼び出し内、上限 EVENTSUB_PARK_LIST_LIMIT）。 */
  count: number
  /**
   * count が実際の総件数と一致しない可能性がある場合 true。
   * limit に達して list_complete=false だった場合のみ true になる
   * （その場合でも limit 自体が閾値よりずっと大きいため、閾値判定には影響しない）。
   */
  countIsLowerBound: boolean
  /**
   * Major-1 対応: true の場合、count は信頼できない（"0件確定" とみなしてはならない）。
   * 生キー0件かつ list_complete=false のまま
   * EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT 回の追加ページ取得でも解決しなかった
   * 状態（tombstone のみのページが連続している疑い）を示す。呼び出し元はこの場合
   * 「backlogなし」と扱わず、unknown であることを警告ログに残したうえで
   * この回の判定をスキップすること。
   */
  unknown: boolean
  /** 最古エントリの受信時刻（ISO8601）。パース可能なキーが1件もなければ null。 */
  oldestReceivedAt: string | null
  /** 最古エントリの経過時間（分、切り捨て）。oldestReceivedAt が null なら null。 */
  oldestAgeMinutes: number | null
}

/**
 * KV キー名から ISO8601 受信時刻を抽出する。プレフィックス不一致・
 * 時刻フォーマット不一致（想定外のキー）の場合は null を返し、防御的に
 * 呼び出し元でスキップさせる。
 */
export function parseParkedEventSubKeyReceivedAt(key: string): string | null {
  if (!key.startsWith(EVENTSUB_PARK_KEY_PREFIX)) return null
  const rest = key.slice(EVENTSUB_PARK_KEY_PREFIX.length)
  const match = rest.match(EVENTSUB_PARK_RECEIVED_AT_PATTERN)
  return match ? match[1] : null
}

/**
 * KV 一覧から backlog の件数・最古エントリの経過時間を算出する。
 *
 * 基本は1回の list 呼び出し（limit=1000、Workers KV の1リクエストあたり最大件数）で
 * 完結させる設計。全件を正確に数えるための無条件のページネーション（cursor を
 * 辿って全件取得）はあえて実装しない: 閾値が10件なので、1000件取得できた時点で
 * 既に閾値の100倍であり「超過している」という結論は変わらない。追加の list 呼び出し
 * （課金・レイテンシ）を無条件に払う価値がない（YAGNI）。
 *
 * 最古エントリの特定に全件ソートを行わない理由: KV の list は既定でキー名の
 * 辞書順（UTF-8バイト順）に返し、ISO8601 文字列は辞書順=時刻順になるため
 * （eventsub-park.ts の parkEventSubNotification コメント参照）、
 * 返却された keys 配列の先頭からパース可能な最初のキーが最古エントリになる。
 *
 * Major-1 対応（tombstone 追従）: 上記の「1000件取れたら閾値の100倍だから安全」
 * という判断は、返ってきた keys 配列が「実際に存在するキー」であることを前提に
 * している。しかし Cloudflare Workers KV は最近失効・削除されたキー
 * （tombstone）を keys 配列に含めない一方でページ内部の走査には数えるため、
 * tombstone だけで1ページ（limit 件）が埋まり「keys=[]（生キー0件）だが
 * list_complete=false」という状態になりうる。これを単純に count===0 として
 * 扱うと、実際には backlog が存在するのに誤って「0件」と報告してしまう。
 * そのため生キー0件かつ list_complete=false の場合のみ、
 * EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT 回を上限に cursor で追加ページを
 * 辿り、生キーが見つかるか list_complete になるまで様子を見る。上限に達しても
 * まだ解決しない場合は count を信頼せず unknown=true を返す（呼び出し元は
 * これを「0件」と混同してはならない）。
 */
async function getEventSubParkBacklogStats(
  kv: EventSubParkKVNamespace,
  now: Date = new Date()
): Promise<EventSubParkBacklogStats> {
  const EVENTSUB_PARK_LIST_LIMIT = 1000
  let list = await kv.list({
    prefix: EVENTSUB_PARK_KEY_PREFIX,
    limit: EVENTSUB_PARK_LIST_LIMIT,
  })

  let followupPages = 0
  while (
    list.keys.length === 0 &&
    !list.list_complete &&
    followupPages < EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT
  ) {
    followupPages++
    list = await kv.list({
      prefix: EVENTSUB_PARK_KEY_PREFIX,
      limit: EVENTSUB_PARK_LIST_LIMIT,
      cursor: list.cursor,
    })
  }

  // 追加ページを上限まで辿ってもなお「生キー0件かつ未完了」なら、tombstone の
  // 連続で解決しなかったとみなし、0件と断定せず unknown として呼び出し元に返す。
  const unknown = list.keys.length === 0 && !list.list_complete

  let oldestReceivedAt: string | null = null
  for (const { name: key } of list.keys) {
    const receivedAt = parseParkedEventSubKeyReceivedAt(key)
    if (receivedAt) {
      oldestReceivedAt = receivedAt
      break
    }
  }

  const oldestAgeMinutes =
    oldestReceivedAt !== null
      ? Math.floor((now.getTime() - new Date(oldestReceivedAt).getTime()) / 60000)
      : null

  return {
    count: list.keys.length,
    countIsLowerBound: !list.list_complete,
    unknown,
    oldestReceivedAt,
    oldestAgeMinutes,
  }
}

/**
 * 既存の Open Issue を専用ラベルで検索する（重複起票防止）。
 *
 * Major-2 対応の経緯: 当初は共通ヘルパ searchIssue（GitHub Search API）を
 * 再利用していた。しかし searchIssue は「検索インデックスは非同期更新であり
 * 作成直後の Issue はヒットしないことがある」ことを前提に、API 失敗時は
 * 例外を投げず null（＝Issue なし）を返す fail-open 設計になっている。
 * errors/support_inquiries 監視ではこの fail-open は許容できる
 * ——「処理済みフラグ」という別の冪等性の本命があるため、search は
 * あくまで補助（findExistingErrorIssue / processInquiries 内のコメント参照）。
 * だが、この backlog 監視には処理済みフラグに相当するものが存在せず、
 * search 結果だけが唯一の重複防止ガードだった。GitHub Search API の障害・
 * レート制限・インデックス反映遅延（5分を超えることがある）のいずれでも、
 * 5分ごとの cron で上限なく重複 Issue が作成されうる（最悪 288 件/日）。
 *
 * 対応（案(b)を優先し、案(a)のfail-closedも併用）:
 * 1. GitHub Search API ではなく Issues List API
 *    （GET /repos/{owner}/{repo}/issues?labels=...&state=open）を使う。
 *    こちらはコアのレート制限（Search の 30 req/min よりずっと高い）に乗り、
 *    検索インデックスの非同期反映に依存しない（作成直後の Issue も確実に
 *    拾える）。`state=open` を明示的に指定する理由は元の `is:open` と同じ:
 *    運用者が Issue をクローズした後に backlog が再発した場合、クローズ済みの
 *    古い Issue に引っかかって再起票がブロックされ続けると再発を見逃すため。
 * 2. 誤マッチ防止は本文中のマーカー文字列ではなく専用ラベル
 *    （EVENTSUB_PARK_BACKLOG_LABEL）で行う。ラベルはメタデータであり、
 *    誰かが Issue 本文でマーカー文字列を偶然/意図的に引用しただけの無関係
 *    Issue を拾う余地がない。
 * 3. それでも API 呼び出し自体が失敗した場合（ネットワーク断・GitHub 障害・
 *    トークン権限不足等）は fail-closed にする（例外を投げ、呼び出し元
 *    processEventSubParkBacklog で Issue 作成をスキップさせる）。
 *    処理済みフラグという保険が無いため、ここは errors/support_inquiries の
 *    fail-open 方針をそのまま踏襲しない —— 「重複を作るくらいなら今回は
 *    起票を諦めて次の cron tick に賭ける」を選ぶ。
 */
async function findOpenEventSubParkBacklogIssue(
  env: Env
): Promise<{ number: number; url: string } | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues?labels=${encodeURIComponent(EVENTSUB_PARK_BACKLOG_LABEL)}&state=open&per_page=1`
  const res = await fetch(url, { headers: githubHeaders(env) })

  if (!res.ok) {
    const text = await res.text()
    // fail-closed: 例外を投げて呼び出し元に伝播させる（新規 Issue 作成させない）。
    throw new Error(`GitHub Issues List API error: ${res.status} ${text}`)
  }

  const issues = (await res.json()) as Array<{ number: number; html_url: string }>
  if (issues.length > 0) {
    return { number: issues[0].number, url: issues[0].html_url }
  }
  return null
}

/** GitHub Issue のペイロードを組み立てる（EventSub 退避 backlog 監視用）。 */
function buildEventSubParkBacklogIssue(
  stats: EventSubParkBacklogStats
): { title: string; body: string; labels: string[] } {
  const countLabel = `${stats.count}${stats.countIsLowerBound ? '+' : ''}`
  const title = `[EventSub Park Backlog] 退避データが ${countLabel} 件滞留中`.slice(0, 80)

  const body = `## EventSub 退避 backlog 監視アラート

maintenance mode 中に KV へ退避された EventSub notification
（\`maintenance:eventsub:*\`）が、以下の閾値を超えて滞留しています。

**件数**: ${countLabel} 件（閾値: ${EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD} 件以上）
**最古エントリ受信時刻**: ${stats.oldestReceivedAt ?? '不明'}
**最古エントリ経過時間**: ${stats.oldestAgeMinutes !== null ? `${stats.oldestAgeMinutes} 分` : '不明'}（閾値: ${EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD} 分以上）

### 想定される原因
- maintenance mode が意図せず有効なまま長時間放置されている
- maintenance mode は解除済みだが、退避データのリプレイが未実施
  （\`npm run replay:maintenance-eventsub -- --url=<base-url>\`、
  詳細は docs/history/migration/DB_PHASE2_RUNBOOK.md を参照）

### 対応後
このアラートには自動クローズが無いため、対応後は手動でこの Issue を
クローズしてください。backlog が解消しないまま次回 cron 実行（5分後）を
迎えても、この Issue が Open のままなら再起票はされません
（Open Issue が既にある間はスキップする設計、実装コメント参照）。

---
${EVENTSUB_PARK_BACKLOG_MARKER}
*Auto-generated by [twica-error-reporter](https://github.com/azumag/twica/issues/695)*`

  // EVENTSUB_PARK_BACKLOG_LABEL は必須: findOpenEventSubParkBacklogIssue が
  // Issues List API でこのラベルを絞り込み条件に使うため、ここで付け忘れると
  // 次回以降の重複起票防止が機能しなくなる。
  return { title, body, labels: ['bug', 'auto-generated', 'maintenance', EVENTSUB_PARK_BACKLOG_LABEL] }
}

/**
 * EventSub 退避 backlog 監視本体。
 * 1. RATE_LIMIT_KV からキー一覧を取得し、件数・最古エントリの経過時間を算出
 *    （kv.get は呼ばない。値ではなくキー名だけで判定できるため）
 * 2. どちらかの閾値を超えていなければ何もしない
 * 3. 超えていれば、既存の Open Issue を検索 → あればスキップ（再起票しない）、
 *    なければ新規作成
 *
 * 「既存 Open Issue があれば更新（コメント追加）」ではなく「スキップ」を選んだ
 * 理由: この監視は5分ごとに毎回同じ判定をやり直すだけで、errors 処理のような
 * 「新規発生イベント」の単位を持たない。Open のままコメントを追加し続けると、
 * backlog が解消しない間（例: maintenance mode が長時間続く運用上正常なケース）
 * 5分に1回コメントが増え続けるスパムになる。Issue が Open であること自体が
 * 「まだ未対応」を示す十分な情報であるため、追加コメントは付加価値が薄い。
 */
export async function processEventSubParkBacklog(env: Env): Promise<void> {
  console.log('[EventSub Park Monitor] Started')

  if (!env.RATE_LIMIT_KV) {
    console.error('[EventSub Park Monitor] Missing RATE_LIMIT_KV binding in wrangler.toml')
    return
  }

  const stats = await getEventSubParkBacklogStats(env.RATE_LIMIT_KV)

  // Major-1 対応: tombstone 追従でも解決しなかった「本当に0件か不明」な状態。
  // 0件と断定して沈黙するとバックログを見逃すリスクがあるため、warn で明示的に
  // 検知可能にしたうえで、信頼できない数値で誤って Issue を起票しないよう
  // この回の判定はスキップする（次回 cron 実行で再評価される）。
  if (stats.unknown) {
    console.warn(
      '[EventSub Park Monitor] Unable to determine backlog state: KV list returned 0 raw keys but list_complete=false after tombstone followup pages. Skipping this run (will retry next cron tick).'
    )
    return
  }

  if (stats.count === 0) {
    console.log('[EventSub Park Monitor] No parked notifications')
    return
  }

  const overThreshold =
    stats.count >= EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD ||
    (stats.oldestAgeMinutes !== null &&
      stats.oldestAgeMinutes >= EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD)

  if (!overThreshold) {
    console.log(
      `[EventSub Park Monitor] Below threshold (count=${stats.count}, oldestAgeMinutes=${stats.oldestAgeMinutes})`
    )
    return
  }

  console.warn(
    `[EventSub Park Monitor] Backlog threshold exceeded (count=${stats.count}, oldestAgeMinutes=${stats.oldestAgeMinutes})`
  )

  const existing = await findOpenEventSubParkBacklogIssue(env)
  if (existing) {
    console.log(`[EventSub Park Monitor] Open issue #${existing.number} already exists, skipping`)
    return
  }

  const issue = await postGitHubIssue(env, buildEventSubParkBacklogIssue(stats))
  console.log(`[EventSub Park Monitor] Created issue #${issue.number}: ${issue.url}`)
}

// =============================================================================
// EventSub サブスクリプション健全性監視（HTTP経由でアプリ本体のAPIを叩く）
//
// Issue #540: EventSub サブスクリプションが disabled 相当の終端状態に落ちても、
// これまで検知手段が「Twitch Developer Console を手動確認する」という運用依存の
// 手順しかなかった。上の processEventSubParkBacklog（KVのbacklog監視）とは別の
// 関心事（こちらはTwitch側のサブスクリプション状態そのものを見る）だが、同じ
// 5分毎のCron Triggerに相乗りする形で定期実行する。
//
// processEventSubParkAutoDrain と同じ設計判断（KVやTwitch API を直接叩かず、
// アプリ本体の API を HTTP 経由で呼ぶ）を踏襲する: 実際の健全性判定・
// アラート発行（reportError → errors テーブル → 既存の error-reporter パイプライン
// でGitHub Issue化）は `src/app/api/admin/eventsub-health/route.ts` 側に集約されて
// おり、この Worker 側はそれを定期的に叩く「トリガー」の役割に徹する。
// Twitch app access token の発行・キャッシュ・401時の自己回復ロジック
// (`src/lib/twitch/app-token.ts`) をこの Worker で複製しないためでもある。
// =============================================================================

/** ヘルスチェック route のパス（`src/app/api/admin/eventsub-health/route.ts`）。 */
const EVENTSUB_HEALTH_PATH = '/api/admin/eventsub-health'

/**
 * fetch のタイムアウト（ミリ秒）。GET一発の軽い呼び出しのため、
 * EVENTSUB_AUTO_DRAIN_PEEK_TIMEOUT_MS と同水準に揃える。
 */
const EVENTSUB_HEALTH_CHECK_TIMEOUT_MS = 30_000

/** eventsub-health route のレスポンス形状（route.ts の戻り値と一致させる）。 */
interface EventSubHealthResponse {
  total: number
  unhealthyCount: number
  unhealthy: Array<{ id: string; type: string; status: string }>
  checkedAt: string
}

/** 1ターゲット（prod または preview）分の設定。 */
interface EventSubHealthTarget {
  /** ログに出す環境名。 */
  name: string
  baseUrl: string | undefined
  healthSecret: string | undefined
}

/**
 * 1ターゲットに対する健全性チェックを呼び出す。
 * アラート発行自体は route.ts 側が担うため、ここでは「呼び出しが成功したか」
 * のログを残すだけに徹する（drainEventSubParkBacklogForTargetと同じく例外を
 * 投げない設計。呼び出し元processEventSubSubscriptionHealthのtry/catchは
 * 防御的な保険として残す）。
 */
async function checkEventSubSubscriptionHealthForTarget(target: EventSubHealthTarget): Promise<void> {
  const { name, healthSecret } = target
  const baseUrl = target.baseUrl ? stripTrailingSlash(target.baseUrl) : undefined

  if (!baseUrl) {
    console.warn(`[EventSub Health Check] Missing base URL for ${name}, skipping`)
    return
  }
  if (!healthSecret) {
    console.warn(`[EventSub Health Check] Missing health secret for ${name}, skipping (set it via wrangler secret put)`)
    return
  }

  try {
    const res = await fetch(`${baseUrl}${EVENTSUB_HEALTH_PATH}`, {
      headers: { 'X-EventSub-Health-Secret': healthSecret },
      signal: AbortSignal.timeout(EVENTSUB_HEALTH_CHECK_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[EventSub Health Check] eventsub-health returned ${res.status} for ${name}: ${text}`)
      return
    }
    const body = (await res.json()) as EventSubHealthResponse
    if (body.unhealthyCount > 0) {
      // アラート（GitHub Issue化）自体は route.ts 側の reportError が既に完了させて
      // いる。ここは Cron Worker 側のログ（wrangler tail）にも要約を残すだけ。
      console.warn(
        `[EventSub Health Check] ${name}: ${body.unhealthyCount}/${body.total} subscription(s) unhealthy ` +
        `(alert already reported via errors table)`
      )
    } else {
      console.log(`[EventSub Health Check] ${name}: all ${body.total} subscription(s) healthy`)
    }
  } catch (err) {
    console.error(`[EventSub Health Check] failed to call eventsub-health for ${name}:`, err)
  }
}

/**
 * EventSub サブスクリプション健全性監視本体。prod/preview 両ターゲットを
 * 独立した try/catch で処理する（既存の processErrors/processInquiries/
 * processEventSubParkBacklog/processEventSubParkAutoDrain 間の独立性と同じ
 * パターン）。
 */
export async function processEventSubSubscriptionHealth(env: Env): Promise<void> {
  console.log('[EventSub Health Check] Started')

  const targets: EventSubHealthTarget[] = [
    { name: 'production', baseUrl: env.APP_BASE_URL_PROD, healthSecret: env.EVENTSUB_HEALTH_SECRET_PROD },
    { name: 'preview', baseUrl: env.APP_BASE_URL_PREVIEW, healthSecret: env.EVENTSUB_HEALTH_SECRET_PREVIEW },
  ]

  for (const target of targets) {
    try {
      await checkEventSubSubscriptionHealthForTarget(target)
    } catch (err) {
      console.error(`[EventSub Health Check] ${target.name} failed:`, err)
    }
  }

  console.log('[EventSub Health Check] Completed')
}

// =============================================================================
// EventSub退避/chat outbox自動ドレイン（DB + RATE_LIMIT_KV → replay API）
//
// Issue #695（EventSub の Cloudflare Queue 化）の代替として承認された、
// KV ベース部分改善の2項目目。1項目目（上記 processEventSubParkBacklog）は
// 滞留を「検知して人間に通知する」だけだったが、この2項目目は
// maintenance mode 解除後の再処理（リプレイ）そのものを自動化し、運用者が
// 手動で `scripts/replay-maintenance-eventsub.js` を実行し忘れるリスクを減らす。
//
// 手動 CLI（scripts/replay-maintenance-eventsub.js）との違い:
//   - CLI は cursor を使って listComplete になるまで全件処理する「完走」設計。
//     この自動ドレインは Cron Trigger 1回の実行につき1バッチ（最大
//     EVENTSUB_AUTO_DRAIN_BATCH_LIMIT 件）だけ処理し、cursor は保持しない。
//     処理しきれない残りは EVENTSUB_AUTO_DRAIN_CRON の次回実行（20分後）に
//     委ねる。理由: Cron Worker の1回の実行時間を有界に保つ（KV 障害等で
//     backlog が巨大化した場合に単発の実行が長時間化するのを防ぐ）ため、
//     また通常運用では maintenance window 終了後の backlog は高々数十件
//     程度と見込まれ、複数回の cron tick に分割されても実害が小さいため
//     （手動 CLI による即時完全処理が必要な場合は運用者が引き続き使える）。
//   - KV へは直接アクセスしない（processEventSubParkBacklog と異なり
//     RATE_LIMIT_KV バインディングを使わない）。理由は下記 Env 型の
//     APP_BASE_URL_PROD/PREVIEW コメント参照: prod/preview は別ドメイン・
//     別 KV namespace を持つ別々の Cloudflare Workers デプロイであり、
//     このワーカーからは prod 用の RATE_LIMIT_KV バインディングしか
//     持てない（preview 用 KV namespace への直接バインディングを追加する
//     こともできるが、それだと「アプリ本体の API を経由せず KV を直接
//     操作する」経路が増え、eventsub-replay route.ts が持つ冪等性ロジック
//     （event_id UNIQUE 制約前提の重複排除、invalid-payload 検知等）を
//     この worker 側でも再実装する必要が生じてしまう。既存の
//     POST /api/admin/eventsub-replay を HTTP 経由で呼ぶことで、そのロジックを
//     一切複製せずに再利用できる）。
// =============================================================================

/** eventsub-replay route のパス（`src/app/api/admin/eventsub-replay/route.ts`）。 */
const EVENTSUB_REPLAY_PATH = '/api/admin/eventsub-replay'

/** maintenance-status route のパス（`src/app/api/maintenance-status/route.ts`）。未認証で呼べる。 */
const MAINTENANCE_STATUS_PATH = '/api/maintenance-status'

/**
 * 自動ドレイン専用の Cron 式。wrangler.toml の `[triggers] crons` に
 * 完全一致する文字列を追加すること（片方だけ変更するとこの分岐が機能しなくなる）。
 * 既存の5分毎トリガー（errors/inquiries/backlog監視、wrangler.toml 1個目の
 * crons エントリ）とは意図的に別トリガーにしている。理由: 既存トリガーは
   * errors/inquiriesポーリングが主目的で高頻度（5分毎）だが、自動ドレインはHTTP経由で
 * アプリ本体の書き込み系 API（eventsub-replay）を叩く処理であり、同じ頻度で
 * 回す必要性が薄い（maintenance window は頻繁に発生しない）。Free プランは
 * 3トリガー/worker まで無料なので、2個目のトリガーを追加しても追加コストは無い。
 *
 * 値そのもの（20分間隔）については wrangler.toml 側のコメントを参照。
 * ここではJSDocコメント終端記号（アスタリスク+スラッシュ）とcron式の
 * 区切り文字が衝突するため、コメント内でのcron式の直接引用を避けている。
 */
export const EVENTSUB_AUTO_DRAIN_CRON = '*/20 * * * *'

/**
 * backlog が実在しても、最古エントリの滞留がこの閾値（分）未満なら今回は
 * ドレインを見送る。
 *
 * 注意（Fableレビューで指摘、重要な訂正）: この閾値は「park された時刻からの
 * 経過」であり、「maintenance mode が off になってからの経過」ではない。
 * 典型的なmaintenance window（数時間〜1日）では、mode解除の瞬間に既に
 * 最古エントリは10分を超えているため、**このガードは実質ゼロ遅延で
 * 通過し、次回tickで即座に発火する**。「mode解除直後の割り込みを防ぐ」
 * という効果はこのガードにはほぼ無い。
 *
 * 実際にmode解除直後の競合（KVのeventual consistencyによる一覧の
 * 反映遅延、手動リプレイとの同時実行等）から守っているのは、
 * `execute_gacha_transaction` の `event_id` UNIQUE制約 + ON CONFLICT
 * DO NOTHINGによる冪等性（1項目目・自動ドレイン・手動リプレイのいずれが
 * 同じエントリを処理しても、DB書き込みは1回しか成功しない）であり、
 * 本ガードは主防御ではない。
 *
 * ではこのガードは何のためか: 「park直後（KVへの書き込み自体が
 * まだlist()に反映されていない可能性がある短い窓）」に自動ドレインが
 * 割り込むのを避けるための、軽い安全マージンとして残している
 * （1項目目のgetEventSubParkBacklogStatsと同じ「最古エントリを見る」
 * という考え方の踏襲。値が1項目目の30分より短い10分なのは、こちらは
 * 20分毎に繰り返し判定されるため、1回見送っても次回tickで再評価
 * されるだけで実害が無いため）。
 */
const EVENTSUB_AUTO_DRAIN_OLDEST_AGE_MINUTES_THRESHOLD = 10

/**
 * 「最古エントリの経過時間」だけを安価に確認するための dry-run peek 呼び出しの
 * limit。routeはDB outbox workとKV listを結合後にreceivedAt順へ再整列するため、
 * limit=1のresults[0]が両保存先を通じた最古候補になる。DB-only pendingや
 * 保持期限cleanupだけが残る場合も実relayを起動できる。dry-runなのでDB/KVの
 * 状態変更は発生しない。
 */
const EVENTSUB_AUTO_DRAIN_PEEK_LIMIT = 1

/**
 * 実際にドレイン（リプレイ実行）する際の1バッチあたりの limit。
 * サーバー側 `DEFAULT_LIMIT`（route.ts）と同じ控えめな値を明示的に指定し、
 * 1回の HTTP リクエストが長時間化しないようにする（route.ts は各エントリを
 * 直列 await するため、件数が多いほどレスポンスが遅くなる。ただしroute側は
 * DB outboxを最大5件に制限し、DB+KVをこのlimit内で共有したうえで105秒の
 * wall-clock budgetを持つ。未処理分はcursor/未claim状態のまま次tickへ残る）。
 */
const EVENTSUB_AUTO_DRAIN_BATCH_LIMIT = 20

/**
 * fetch のタイムアウト（ミリ秒）。対象アプリが無応答の場合に Cron Worker の
 * 実行がハングし続けるのを防ぐ。peek（limit=1、dry-run で KV 書き込みなし）は
 * 軽量なので短め、実ドレインは120秒とする。アプリroute自身が105秒で新規処理を
 * 停止するため、残り15秒をレスポンス転送・Worker側ログ処理へ確保できる。
 */
const EVENTSUB_AUTO_DRAIN_PEEK_TIMEOUT_MS = 30_000
const EVENTSUB_AUTO_DRAIN_REPLAY_TIMEOUT_MS = 120_000

/** eventsub-replay route のレスポンス形状（route.ts の戻り値と一致させる）。 */
interface EventSubReplayResponse {
  dryRun: boolean
  cursor?: string
  listComplete: boolean
  results: Array<{
    key: string
    messageId: string
    subscriptionType: string
    receivedAt: string
    outcome: string
    error?: string
  }>
  counts: {
    succeeded: number
    skipped: number
    failed: number
    unknownType: number
    invalidPayload: number
    total: number
  }
}

/** 末尾のスラッシュを取り除く（wrangler.toml の設定ミスで付いていても安全に動くようにする）。 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 対象アプリの maintenance mode を取得する。`GET /api/maintenance-status` は
 * 未認証で呼べる公開エンドポイント（4.5節参照）。
 *
 * fail-safe 設計: ネットワークエラー・非2xx・レスポンス形状不正のいずれでも
 * null を返し、呼び出し元でこのターゲットへのドレインをスキップさせる。
 * 「状態が確認できない = off だと決め打たない」ことで、実際には
 * maintenance 中かもしれない状態で書き込み系のリプレイを誤って実行する事故を防ぐ。
 */
async function fetchMaintenanceMode(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}${MAINTENANCE_STATUS_PATH}`, {
      signal: AbortSignal.timeout(EVENTSUB_AUTO_DRAIN_PEEK_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[EventSub Auto Drain] maintenance-status returned ${res.status} for ${baseUrl}`)
      return null
    }
    const body = (await res.json()) as { mode?: unknown }
    if (typeof body.mode !== 'string') {
      console.error(`[EventSub Auto Drain] maintenance-status response missing mode field for ${baseUrl}`)
      return null
    }
    return body.mode
  } catch (err) {
    console.error(`[EventSub Auto Drain] failed to fetch maintenance-status for ${baseUrl}:`, err)
    return null
  }
}

/**
 * POST /api/admin/eventsub-replay を呼ぶ。dry-run（peek）・実ドレイン共通。
 * ネットワークエラー・非2xx・JSON パース失敗のいずれでも null を返し、
 * 呼び出し元で例外を投げずにこのターゲットの処理を打ち切らせる
 * （scheduled() 側の try/catch に頼らず、この関数内で完結させることで
 * 「prod 失敗時に preview の処理が止まらない」ことをより明示的に保証する）。
 */
async function postEventSubReplay(
  baseUrl: string,
  secret: string,
  body: { dryRun?: boolean; limit?: number },
  timeoutMs: number
): Promise<EventSubReplayResponse | null> {
  try {
    const res = await fetch(`${baseUrl}${EVENTSUB_REPLAY_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Replay-Secret': secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[EventSub Auto Drain] eventsub-replay returned ${res.status} for ${baseUrl}: ${text}`)
      return null
    }
    return (await res.json()) as EventSubReplayResponse
  } catch (err) {
    console.error(`[EventSub Auto Drain] failed to call eventsub-replay for ${baseUrl}:`, err)
    return null
  }
}

/** 1ターゲット（prod または preview）分の設定。 */
interface EventSubAutoDrainTarget {
  /** ログに出す環境名。 */
  name: string
  baseUrl: string | undefined
  replaySecret: string | undefined
}

/**
 * 1ターゲットに対する自動ドレインを実行する。
 * 1. baseUrl / secret の両方が設定されていることを確認（無ければ warn して no-op）
 * 2. maintenance mode が 'off' であることを確認（off 以外・確認不能ならスキップ）
 * 3. dry-run peek（limit=1）でDB outboxまたはKVの最古エントリ経過時間を確認
 *    （backlog が無ければ、または閾値未満ならここで終了）
 * 4. 実ドレイン（limit=EVENTSUB_AUTO_DRAIN_BATCH_LIMIT、1バッチのみ）を実行し、結果をログ出力
 *
 * 例外を投げない設計: 呼び出し元 processEventSubParkAutoDrain が各ターゲットを
 * 独立した try/catch で回すため二重の保険ではあるが、上記の fetch ヘルパが
 * いずれも例外を投げず null を返す設計にしているため、実質的にこの関数も
 * 例外を投げることはない（防御的に呼び出し元の try/catch は残す）。
 */
async function drainEventSubParkBacklogForTarget(target: EventSubAutoDrainTarget): Promise<void> {
  const { name, replaySecret } = target
  const baseUrl = target.baseUrl ? stripTrailingSlash(target.baseUrl) : undefined

  if (!baseUrl) {
    console.warn(`[EventSub Auto Drain] Missing base URL for ${name}, skipping`)
    return
  }
  if (!replaySecret) {
    console.warn(`[EventSub Auto Drain] Missing replay secret for ${name}, skipping (set it via wrangler secret put)`)
    return
  }

  const mode = await fetchMaintenanceMode(baseUrl)
  if (mode === null) {
    // fetchMaintenanceMode 内で既にエラーログ済み。
    return
  }
  if (mode !== 'off') {
    console.log(`[EventSub Auto Drain] ${name}: maintenance mode is '${mode}' (not 'off'), skipping`)
    return
  }

  const peek = await postEventSubReplay(
    baseUrl,
    replaySecret,
    { dryRun: true, limit: EVENTSUB_AUTO_DRAIN_PEEK_LIMIT },
    EVENTSUB_AUTO_DRAIN_PEEK_TIMEOUT_MS
  )
  if (peek === null) {
    // postEventSubReplay 内で既にエラーログ済み。
    return
  }
  if (peek.results.length === 0) {
    console.log(`[EventSub Auto Drain] ${name}: no parked notifications, nothing to drain`)
    return
  }

  const oldestReceivedAt = peek.results[0].receivedAt
  const oldestAgeMinutes = Math.floor((Date.now() - new Date(oldestReceivedAt).getTime()) / 60000)
  if (oldestAgeMinutes < EVENTSUB_AUTO_DRAIN_OLDEST_AGE_MINUTES_THRESHOLD) {
    console.log(
      `[EventSub Auto Drain] ${name}: oldest entry age ${oldestAgeMinutes}min is below threshold ` +
      `(${EVENTSUB_AUTO_DRAIN_OLDEST_AGE_MINUTES_THRESHOLD}min), skipping this tick (KV eventual consistency guard)`
    )
    return
  }

  console.log(
    `[EventSub Auto Drain] ${name}: oldest entry age ${oldestAgeMinutes}min exceeds threshold, draining one batch (limit=${EVENTSUB_AUTO_DRAIN_BATCH_LIMIT})`
  )

  const result = await postEventSubReplay(
    baseUrl,
    replaySecret,
    { dryRun: false, limit: EVENTSUB_AUTO_DRAIN_BATCH_LIMIT },
    EVENTSUB_AUTO_DRAIN_REPLAY_TIMEOUT_MS
  )
  if (result === null) {
    // postEventSubReplay 内で既にエラーログ済み。
    return
  }

  console.log(
    `[EventSub Auto Drain] ${name}: batch drained - succeeded=${result.counts.succeeded} ` +
    `skipped=${result.counts.skipped} failed=${result.counts.failed} ` +
    `unknownType=${result.counts.unknownType} invalidPayload=${result.counts.invalidPayload} ` +
    `total=${result.counts.total} listComplete=${result.listComplete}` +
    (result.listComplete
      ? ''
      : ' (backlog remains, will continue on next auto-drain tick)')
  )
}

/**
 * EventSub 退避 backlog 自動ドレイン本体。prod/preview 両ターゲットを
 * 独立した try/catch で処理する（片方の失敗が他方に波及しないため。
 * 既存の processErrors/processInquiries/processEventSubParkBacklog 間の
 * 独立性と同じパターン）。
 */
export async function processEventSubParkAutoDrain(env: Env): Promise<void> {
  console.log('[EventSub Auto Drain] Started')

  const targets: EventSubAutoDrainTarget[] = [
    { name: 'production', baseUrl: env.APP_BASE_URL_PROD, replaySecret: env.EVENTSUB_REPLAY_SECRET_PROD },
    { name: 'preview', baseUrl: env.APP_BASE_URL_PREVIEW, replaySecret: env.EVENTSUB_REPLAY_SECRET_PREVIEW },
  ]

  for (const target of targets) {
    try {
      await drainEventSubParkBacklogForTarget(target)
    } catch (err) {
      console.error(`[EventSub Auto Drain] ${target.name} failed:`, err)
    }
  }

  console.log('[EventSub Auto Drain] Completed')
}

// =============================================================================
// Cron Trigger エントリポイント
// =============================================================================

export default {
  /**
   * Cron Trigger ハンドラ。wrangler.toml の `[triggers] crons` に登録された
   * 2つのトリガーを `event.cron` で判別し、完全に独立した処理へ分岐する:
   *   - EVENTSUB_AUTO_DRAIN_CRON（20分毎）: EventSub 退避 backlog 自動ドレインのみ
   *   - それ以外（既定の5分毎トリガー、テスト等で cron 未設定の場合を含む）:
   *     従来どおり errors/inquiries/backlog監視の3処理
   * 自動ドレインを既存3処理と混在させない理由は
   * processEventSubParkAutoDrain セクション冒頭のコメント参照。
   */
  async scheduled(
    event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    if (event.cron === EVENTSUB_AUTO_DRAIN_CRON) {
      // 自動ドレインは HYPERDRIVE_PLANETSCALE/GITHUB_TOKEN 等、既存3処理専用の
      // binding/secrets に依存しないため、下の環境変数バリデーションより前で
      // 分岐・完結させる。
      try {
        await processEventSubParkAutoDrain(env)
      } catch (err) {
        console.error('[EventSub Auto Drain] Cron job failed:', err)
      }
      return
    }

    // 環境変数バリデーション（既存3処理共通）: 必須 binding/secret が
    // 未設定なら無害に早期リターンする。
    if (!env.HYPERDRIVE_PLANETSCALE || !env.GITHUB_TOKEN) {
      console.error('[Reporter] Missing required binding/secrets. Bind HYPERDRIVE_PLANETSCALE in wrangler.toml and set GITHUB_TOKEN via wrangler secret put')
      return
    }
    if (!env.GITHUB_REPO_OWNER || !env.GITHUB_REPO_NAME) {
      console.error('[Reporter] Missing GITHUB_REPO_OWNER or GITHUB_REPO_NAME in wrangler.toml [vars]')
      return
    }

    // エラー処理と問い合わせ処理は独立。片方の失敗が他方を止めないよう個別に捕捉。
    try {
      await processErrors(env)
    } catch (err) {
      console.error('[Error Reporter] Cron job failed:', err)
    }

    try {
      await processInquiries(env)
    } catch (err) {
      console.error('[Inquiry Reporter] Cron job failed:', err)
    }

    try {
      await processEventSubParkBacklog(env)
    } catch (err) {
      console.error('[EventSub Park Monitor] Cron job failed:', err)
    }

    try {
      await processEventSubSubscriptionHealth(env)
    } catch (err) {
      console.error('[EventSub Health Check] Cron job failed:', err)
    }
  },
}
