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
import { getDbTarget, type DbTarget } from './target'
// scripts/lib/db-migrate-core.js が正本（single source of truth）。root の
// tsconfig.json は allowJs: true のため、この .js（CommonJS）を素の import で
// 問題なく読める（tsc --noEmit で型解決込みに検証済み。JSDoc の @param/@returns から
// string/string の型が推論される）。詳細な背景・Major-1 (sslmode 補完) の設計根拠は
// stripPostgresJsIncompatibleSslParams 自身の JSDoc（db-migrate-core.js）を参照。
import { stripPostgresJsIncompatibleSslParams } from '../../../scripts/lib/db-migrate-core'

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
 *
 * 値を DbTarget 別の Map にしているのは #693（Phase 2 dual binding）対応: 同一
 * リクエスト内で source（supabase）/target（planetscale）を両方読む検証 path
 * （getDb({ target: ... }) を targetを変えて複数回呼ぶ）でも、ハンドルが target
 * ごとに独立してキャッシュされ混ざらないようにするため。DB_TARGET を一切使わない
 * 既存呼び出し元（引数無し getDb()）は常に 'supabase' 1 エントリしか使わないため、
 * 挙動は従来と変わらない。
 */
const requestScopedHandles = new WeakMap<object, Map<DbTarget, DbHandle>>()

/**
 * Node 環境（next dev）用のシングルトン（supabase/admin.ts と同じパターン）。
 * #693 で target 別に保持するよう拡張（理由は requestScopedHandles と同じ）。
 */
const nodeSingletonHandles: Record<DbTarget, DbHandle | null> = {
  supabase: null,
  planetscale: null,
}

/**
 * PG テキスト形式の timestamp/timestamptz 文字列にのみ一致する正規表現。
 *
 * 一致対象（終端まで完全一致 = ^...$ でアンカー。部分一致では安全側に倒せない
 * ため必ずフルマッチさせる）:
 *   YYYY-MM-DD HH:MM:SS[.f{1,6}][±HH または ±HH:MM]
 * 具体例: '2024-01-01 12:00:00.123456+00' / '2024-01-01 12:00:00+09:30' /
 *         '2024-01-01 12:00:00'（timestamp without time zone、オフセット無し）
 *
 * 意図的に一致させない（= 呼び出し元でパススルーさせる）もの:
 *   - ±HH:MM:SS 形式のオフセット（歴史的タイムゾーン。ISO 8601 非準拠で
 *     この関数の変換対象外。offset 部分は [+-]\d{2}(:\d{2})? までしか
 *     受理しないため、末尾に :SS が残ると $ 終端アンカーに一致せず全体マッチ失敗する）
 *   - 'infinity' / '-infinity'
 *   - BC 日付（例 '0001-01-01 00:00:00+00 BC'。末尾の ' BC' が $ に一致しない）
 *   - year 10000 以上（PostgreSQL は5桁以上の年を返す。例 '10000-01-01 00:00:00+00'）
 *     は日付部分が \d{4} に一致せずパススルーされる（Twitch 関連の実データで
 *     西暦10000年以降の日時が発生することはあり得ないため実害はない）
 *   - その他パターン不一致の文字列全般（既に ISO 8601 形式の文字列を含む。
 *     ISO 8601 は日付・時刻区切りが 'T' であり、この正規表現が要求する
 *     半角スペース区切りに一致しないため自然にパススルーされる＝冪等）
 *
 * キャプチャは番号参照（1=date, 2=time, 3=fraction, 4=offset）。named capture
 * groups（ES2018 構文）は tsconfig の target: ES2017 で TS1503 になるため使えない。
 *
 * 前提: 接続先 PostgreSQL の DateStyle が既定の ISO であること（Supabase の既定。
 * 万一 DateStyle が変更されると全タイムスタンプがパターン不一致→無変換パススルー
 * となり、Safari での日付パース問題が再発する。その場合もエラーにはならないため、
 * preview 検証チェックリスト（docs/db-driver-migration.md）の ISO 8601 実機確認が
 * 検出手段になる）。
 */
const PG_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?([+-]\d{2}(?::\d{2})?)?$/

/**
 * PG テキスト形式の timestamp/timestamptz 文字列を ISO 8601（PostgREST が返す
 * 形式）に変換する純関数（#688）。
 *
 * 変換仕様:
 * - 日付と時刻の間の半角スペース → 'T'
 * - 小数秒は PG が返す桁数（1〜6桁。PG は末尾ゼロを削って可変長で返す）を
 *   そのまま維持する。PostgREST も同じ生テキストを JSON 化するだけなので、
 *   桁数を揃えず維持することがパリティになる（0埋めや切り詰めをしない）。
 * - オフセット ±HH → ±HH:00 に正規化（PostgREST の ISO 8601 出力と同形式にする）。
 *   ±HH:MM はそのまま維持。
 * - オフセット無し（timestamp without time zone、OID 1114）→ オフセットを
 *   付けず 'YYYY-MM-DDTHH:MM:SS[.ffffff]' を返す（PostgREST の timestamp
 *   （tz無し）列の出力と同形式）。
 *
 * 上記の変換パターンに一致しない入力（PG_TIMESTAMP_PATTERN 参照: 歴史的
 * ±HH:MM:SS オフセット、infinity/-infinity、BC 日付、空文字列、既に ISO 8601
 * 形式の文字列、その他任意の文字列）は安全側で無変換のまま返す
 * （変換に失敗して値を壊すより、PG テキスト形式のまま返すほうが安全という判断。
 * なお infinity のパススルーは PostgREST の出力とも一致する）。
 */
export function normalizePgTimestampString(value: string): string {
  const match = PG_TIMESTAMP_PATTERN.exec(value)
  if (!match) {
    return value
  }

  // 番号キャプチャ: [1]=date, [2]=time, [3]=fraction（省略時 undefined）, [4]=offset（同）
  const [, date, time, fraction, offset] = match
  const isoBody = `${date}T${time}${fraction ?? ''}`

  if (offset === undefined) {
    // timestamp without time zone（OID 1114）: PostgREST の対応する出力と同じく
    // オフセットを付けない。
    return isoBody
  }

  // offset は '[+-]\d{2}' （length 3, 例 '+09'）か '[+-]\d{2}:\d{2}'
  // （length 6, 例 '+09:30'）のいずれかのみが PG_TIMESTAMP_PATTERN を通過する。
  // 前者は ':00' を補って ±HH:MM 形式に揃える（PostgREST の ISO 8601 出力仕様）。
  return offset.length === 3 ? `${isoBody}${offset}:00` : `${isoBody}${offset}`
}

/**
 * postgres.js クライアントの最小構造型。実体は postgres.Sql だが、単体テストで
 * fake オブジェクトを渡せるよう options.parsers のみを要求する構造型にする
 * （r2-client.ts の R2BucketLike と同じ最小インターフェース方針）。
 */
interface PostgresParsersLike {
  options: {
    parsers: Record<number, (value: string) => unknown>
  }
}

/**
 * timestamp(OID 1114)/timestamptz(OID 1184) のパーサを ISO 8601 正規化パーサ
 * （normalizePgTimestampString）に in-place で差し替える（#688）。
 *
 * 呼び出しタイミングの制約: createHandle() 内で `drizzle(sql, { schema })` の
 * **後**に呼ぶこと。drizzle-orm 0.45.2 の construct()
 * （node_modules/drizzle-orm/postgres-js/driver.cjs:46-53）が
 * `client.options.parsers[type] = transparentParser`（対象 OID:
 * "1184","1082","1083","1114","1182","1185","1115","1231"）で 1114/1184 を
 * 含めて透過パーサに in-place 上書きするため、drizzle() より前に本関数を呼んでも
 * 直後の drizzle() 呼び出しで正規化が消される。
 *
 * 実装上絶対に守る必要がある2点（いずれも postgres.js 3.4.9 のソースで実測確認済み。
 * どちらか一方でも破ると正規化が「サイレントに」効かなくなるため、根拠込みで
 * ここに残す）:
 *
 * 1. `sql.options.parsers` オブジェクトそのものを差し替えてはならない
 *    （`sql.options.parsers = { ...旧, 1184: fn }` のようなコードは絶対禁止。
 *    必ず `sql.options.parsers[1184] = fn` のようにプロパティ単位で書き換える）。
 *    理由: postgres.js は `postgres()` 呼び出し時点で
 *    （node_modules/postgres/cjs/src/index.js:65
 *    `[...Array(options.max)].map(() => Connection(options, queues, ...))`）
 *    max 個の Connection を eager に生成する。各 Connection は
 *    node_modules/postgres/cjs/src/connection.js:52-70 付近で
 *    `const { ..., parsers, ... } = options` と分割代入しており、この時点で
 *    `options.parsers` オブジェクトへの「参照」をクロージャに捕まえる（値の
 *    コピーではない）。したがってプロパティ単位の書き換えは全 Connection に
 *    伝播するが、オブジェクト自体の差し替えは「Connection 群が握っているのは
 *    古いオブジェクトへの参照のまま」になり、以後 sql.options.parsers を
 *    上書きしても各 Connection には一切反映されない（エラーにならず単に無視
 *    されるため、発見が非常に困難な不具合になる）。
 *
 * 2. 本関数は createHandle() 内・そのクライアントで最初のクエリが発行される前に
 *    完了させる必要がある。理由: node_modules/postgres/cjs/src/connection.js の
 *    RowDescription ハンドラ（632行目付近の `parser: parsers[type]`）は列メタ
 *    データ受信時点の parsers[type] を「解決済み関数」として
 *    `query.statement.columns` に固定し、prepared statement は
 *    クエリ signature ごとに接続内キャッシュされる（同ファイル 632行目付近
 *    `query.prepare && (statements[query.signature] = query.statement)`）。
 *    そのため、あるクエリ形状について一度カラム定義が解決された後にパーサを
 *    差し替えても、そのクエリ形状の以後の実行には反映されない可能性がある。
 */
export function installIsoTimestampParsers(client: PostgresParsersLike): void {
  client.options.parsers[1114] = normalizePgTimestampString
  client.options.parsers[1184] = normalizePgTimestampString
}

// stripPostgresJsIncompatibleSslParams はここでは定義せず、正本
// scripts/lib/db-migrate-core.js からの import をそのまま re-export する
// （このファイル冒頭の import 文のコメント参照）。テスト
// （tests/unit/db-client.test.ts）が `@/lib/db/client` からこの関数を直接
// import しているため、re-export してモジュール公開面を変えない。
export { stripPostgresJsIncompatibleSslParams }

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
 *   ※補足（#688 で更新）: drizzle() はこのクライアントの timestamp/timestamptz/date
 *   パーサを透過（文字列パススルー）に上書きする。そのままでは日時列が PG テキスト
 *   形式の文字列（例 '2024-01-01 12:00:00.123456+00'）で返ってしまい、Safari(JSC) の
 *   new Date() ではこの形式のパースが仕様上保証されない。そのため createHandle() は
 *   drizzle() 呼び出しの直後に installIsoTimestampParsers() を呼び、
 *   timestamp(OID 1114)/timestamptz(OID 1184) のパーサを ISO 8601 文字列
 *   （PostgREST が返す形式と同じ）に正規化するパーサへ差し替える。根拠・実装上の
 *   制約は installIsoTimestampParsers 自身のコメントを参照。date(OID 1082) は
 *   'YYYY-MM-DD' で元々 ISO 8601 準拠のため対象外。time/timetz（1083/1266）や
 *   timestamp[]/timestamptz[] 配列（1115/1185 等）は現行スキーマに該当列が無く
 *   （配列列はそもそも fetch_types: false により postgres.js 側でパースされない）
 *   対象外だが、将来これらの型の列を追加する場合は同様の正規化パーサ登録が必要に
 *   なる点に注意。schema.ts は引き続き mode: 'string' のため、Drizzle が返す値は
 *   Date ではなく文字列のまま（プロセスのタイムゾーンに依存する Date 変換は
 *   発生しない。drizzle-orm/postgres-js/driver の construct() を実測確認済み）。
 *   ISO 8601 正規化そのものはタイムゾーン変換を一切行わない（オフセット表記の
 *   桁揃えのみ）ため、この性質に影響しない。
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
  // PlanetScale接続文字列が付与する sslrootcert パラメータは postgres.js が
  // 未知の接続オプションとしてサーバーへ送りつけてしまい接続失敗する
  // （stripPostgresJsIncompatibleSslParams のdocコメント参照。実機確認済み）。
  const sql = postgres(stripPostgresJsIncompatibleSslParams(connectionString), {
    max: 5,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 20,
  })
  const db = drizzle(sql, { schema })
  // #688: drizzle() が transparentParser で上書きした直後、かつこの sql
  // クライアントで最初のクエリが発行される前に正規化パーサを設定する
  // （呼び出し順序の根拠は installIsoTimestampParsers 自身のコメント参照）。
  installIsoTimestampParsers(sql)
  return { db, sql }
}

/**
 * target ごとの Hyperdrive binding 名（wrangler.toml の [[hyperdrive]] /
 * [[env.preview.hyperdrive]]）。#693 で 'HYPERDRIVE' 単一 binding から
 * target 別 binding へ分割した（wrangler.toml 側のリネームと対になる変更）。
 *
 * 'planetscale' 側は本 issue (#693) の時点ではまだ wrangler.toml に
 * binding を追加していない（#691 で実 PlanetScale DB・Hyperdrive config が
 * 作成された後に追加）。binding 未定義のうちは cfEnv からこの名前を引いても
 * 常に undefined になり、resolveConnectionString は自然に (2)(3) へフォール
 * スルーする（存在しない binding 名を先に書いても、有効化されるまでは
 * ただの unresolved lookup であり例外にはならない）。
 */
const HYPERDRIVE_BINDING_NAMES: Record<DbTarget, string> = {
  supabase: 'HYPERDRIVE_SUPABASE',
  planetscale: 'HYPERDRIVE_PLANETSCALE',
}

/** target ごとのローカル開発用 DATABASE_URL 環境変数名。 */
const DATABASE_URL_ENV_NAMES: Record<DbTarget, string> = {
  supabase: 'DATABASE_URL_SUPABASE',
  planetscale: 'DATABASE_URL_PLANETSCALE',
}

/**
 * 接続文字列の解決。優先順:
 *   (1) Cloudflare env の target 別 Hyperdrive バインディング
 *       （HYPERDRIVE_SUPABASE / HYPERDRIVE_PLANETSCALE）
 *   (2) process.env の target 別 DATABASE_URL（DATABASE_URL_SUPABASE /
 *       DATABASE_URL_PLANETSCALE。next dev などローカル開発用）
 *   (3) target === 'supabase' の場合のみ、既存の process.env.DATABASE_URL への
 *       後方互換フォールバック（#693 以前からの唯一の接続先だったため）
 *   (4) どれも無ければ throw
 *
 * (3) を 'planetscale' に適用しない理由（#693 の明示要件）: DATABASE_URL は
 * 歴史的に Supabase 用として設定されてきた値であり、PlanetScale ターゲットが
 * binding/専用 env 変数の設定漏れで DATABASE_URL に暗黙フォールバックすると、
 * 「PlanetScale のつもりで実は Supabase に書き込んでいた」という事故になり得る。
 * fail-closed（明示的な throw）の方が、誤った接続先への到達より安全。
 *
 * (4) は新経路（DB_DRIVER=pg-read/pg）を呼んだときにのみ到達する。フラグ未設定の
 * postgrest 経路はこのモジュールを呼ばないため、Hyperdrive 未設定のままデプロイ
 * しても既存機能には影響しない。
 */
function resolveConnectionString(
  target: DbTarget,
  cfEnv: Record<string, unknown> | null,
): string {
  const bindingName = HYPERDRIVE_BINDING_NAMES[target]
  const hyperdrive = cfEnv?.[bindingName] as HyperdriveBindingLike | undefined
  if (hyperdrive?.connectionString) {
    return hyperdrive.connectionString
  }

  const targetDatabaseUrl = process.env[DATABASE_URL_ENV_NAMES[target]]?.trim()
  if (targetDatabaseUrl) {
    return targetDatabaseUrl
  }

  if (target === 'supabase') {
    const legacyDatabaseUrl = process.env.DATABASE_URL?.trim()
    if (legacyDatabaseUrl) {
      return legacyDatabaseUrl
    }
  }

  const envVarName = DATABASE_URL_ENV_NAMES[target]
  const legacyHint = target === 'supabase' ? ' or DATABASE_URL' : ''
  throw new Error(
    `[db:pg] No database connection configured for target=${target}: bind ${bindingName} ` +
      `in wrangler.toml (Workers) or set ${envVarName}${legacyHint} (local dev). This is ` +
      'only reached when DB_DRIVER=pg-read/pg is set; unset DB_DRIVER to fall back to PostgREST.',
  )
}

/**
 * Drizzle クライアントを取得する。
 * - Workers: リクエストごとに生成し、同一リクエスト内では target 別に WeakMap
 *   （経由の Map）で再利用
 * - Node（next dev）: target 別のモジュールシングルトン
 *
 * @param options.target - 明示的に接続先を指定したい場合のみ渡す（migration/
 *   検証用の内部 API 呼び出し等）。省略時は getDbTarget()（src/lib/db/target.ts）
 *   で解決する。**既存の全呼び出し元は引数無しで getDb() を呼んでおり、
 *   DB_TARGET 環境変数が未設定なら getDbTarget() は 'supabase' を返すため、
 *   これらは #693 以前と全く同じ接続先（HYPERDRIVE_SUPABASE / DATABASE_URL）に
 *   到達する（挙動不変）。**
 *
 * 使用側の規約: withDbRetry() でラップする場合は queryFn の中で getDb() を
 * 呼ぶこと（リクエストスコープ破棄からの回復にはクライアント再取得が必要。
 * src/lib/db/retry.ts 参照）。
 */
export async function getDb(options?: { target?: DbTarget }): Promise<DbHandle> {
  const target = options?.target ?? getDbTarget()

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
    // Workers: 同一リクエスト（= 同一 ExecutionContext）内は target ごとに
    // ハンドルを再利用する。OpenNext は AsyncLocalStorage でリクエストごとに
    // 同一の ctx を返すため、ctx がそのままリクエスト識別子として機能する。
    //
    // 注意: 以下の get → create → set の間に await を挟まないこと。
    // createHandle() は同期（postgres() は遅延接続でコンストラクトは同期）なので
    // このブロックは原子的に実行され、同一リクエスト内で getDb() が並列に
    // 呼ばれても（Promise.all 等）ハンドルが二重生成されることはない。
    // ここに await を追加すると、その保証が壊れる（#693 で target 単位の
    // Map を挟んだ後もこの原子性は変わらず維持している）。
    let handlesByTarget = requestScopedHandles.get(cfCtx)
    const existing = handlesByTarget?.get(target)
    if (existing) {
      return existing
    }
    const handle = createHandle(resolveConnectionString(target, cfEnv))
    if (!handlesByTarget) {
      handlesByTarget = new Map<DbTarget, DbHandle>()
      requestScopedHandles.set(cfCtx, handlesByTarget)
    }
    handlesByTarget.set(target, handle)
    return handle
  }

  // Node（next dev）: target 別シングルトンで TCP 接続を再利用
  // （上と同じく判定〜代入は同期ブロックなので並列呼び出しでも二重生成されない）
  if (!nodeSingletonHandles[target]) {
    nodeSingletonHandles[target] = createHandle(resolveConnectionString(target, null))
  }
  return nodeSingletonHandles[target]
}
