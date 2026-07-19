#!/usr/bin/env node

/**
 * Supabase（または任意のPostgreSQL）DBの public スキーマを schema-only dump する / Issue #691 Chunk 1
 *
 * 背景:
 * `pg_dump` を直接シェルから叩く手作業（SQL Editor 貼り付け含む）は再現性が無く、
 * 「どのオプションで・いつ・どのバージョンのDBから」採取したかが記録に残らない。
 * 本スクリプトは `pg_dump --schema=public --schema-only --no-owner --no-privileges` を
 * Node の child_process 経由でラップし、生dump（raw dump）と非機密metadataの
 * manifest.json を必ずセットで生成することで、採取作業を再現可能にする。
 *
 * bash スクリプトではなく Node (.mjs) にした理由（Issue #691 設計方針）:
 *   - scripts/lib/db-migrate-core.js の `redactSecretsFromText` をログ出力にそのまま
 *     再利用でき、bash側で同等のredaction処理を再実装する二重管理を避けられる。
 *   - scripts/db-phase2/normalize-schema.mjs とのオブジェクト種別カウントロジック共有
 *     （`countsByType` は normalizeDump が持つパーサをそのまま再利用する）。
 *
 * manifest.json に含めない情報（重要）:
 * source DB のホスト名・接続文字列・パスワードは一切含めない。含まれていないことは
 * tests/unit/db-phase2/normalize-schema.test.ts 側ではなく、本ファイルの純粋関数
 * buildManifest を対象にした専用テストで担保する（DATABASE_URL 由来の文字列が
 * manifest の値のどこにも現れないことをアサートする）。
 *
 * pg_dump 起動時のパスワードの扱いについて（N-3、Fableレビュー2回目対応）:
 * DATABASE_URL をそのまま pg_dump の argv（コマンドライン引数）として渡すと、同一マシン上の
 * 他ユーザーが `ps aux` 等でプロセス一覧を見た際にパスワードが平文で見えてしまう。
 * `splitDatabaseUrlPassword()` でパスワードを分離し、argvにはパスワード除去済みのURIのみを
 * 渡し、パスワードは `PGPASSWORD` 環境変数（子プロセスの環境変数のみに載り、argvには
 * 現れない）経由で渡す設計にしている。
 *
 * 使い方:
 *   DATABASE_URL="postgres://..." node scripts/db-phase2/export-public-schema.mjs
 *   DATABASE_URL="postgres://..." node scripts/db-phase2/export-public-schema.mjs --out-dir=db/planetscale/.artifacts
 *
 * pg_dump バイナリについて:
 * ローカル/CI環境に pg_dump が入っていない場合は明確なエラーで即終了する（本文
 * resolvePgDumpBinary 参照）。`PG_DUMP_BIN` 環境変数でパスを明示指定できる。
 */

'use strict'

import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import postgres from 'postgres'
import { normalizeDump, OBJECT_CATEGORY } from './normalize-schema.mjs'

// scripts/lib/db-migrate-core.js は CommonJS（scripts/db-migrate.js と共用のため）。
// ESM から require() した module.exports オブジェクトをそのまま使う
// （named importではなくnamespaceごと受け取り、core.xxx の形でアクセスする）。
const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

const DEFAULT_OUT_DIR = 'db/planetscale/.artifacts'
const RAW_DUMP_FILENAME = 'public-schema.raw.sql'
const MANIFEST_FILENAME = 'manifest.json'

// pg_dump が dump 本文に埋め込む "-- Dumped from database version X.Y (...)" 行から
// メジャーバージョンを取り出す正規表現。マイナーバージョン以降は捨てる
// （manifest には「PostgreSQLメジャーバージョン」とだけ記録する設計、Issue #691本文）。
const DUMPED_VERSION_RE = /^-- Dumped from database version (\d+)(?:\.\d+)*/m

/**
 * pg_dump 生出力から PostgreSQL メジャーバージョンを抽出する純粋関数。
 * 抽出できない場合は null を返す（manifest にはその旨を記録する）。
 * @param {string} rawText
 * @returns {number | null}
 */
export function extractPostgresMajorVersion(rawText) {
  const match = rawText.match(DUMPED_VERSION_RE)
  if (!match) return null
  return Number(match[1])
}

/**
 * manifest.json の内容を組み立てる純粋関数（DB接続・ファイルI/O無し、単体テスト対象）。
 * 意図的に「非機密metadataのみ」を扱う設計を型で示すため、引数に接続文字列やhost名を
 * 一切取らない（呼び出し側が誤って渡せない/渡す必要が無い構造にする）。
 *
 * @param {{
 *   capturedAt: string,
 *   postgresMajorVersion: number | null,
 *   countsByType: Record<string, number>,
 *   artifactSha256: string,
 *   restrictRemovedCount: number,
 *   excludedCount: number,
 *   maxAppliedMigrationVersion?: string | null,
 * }} args
 */
export function buildManifest({
  capturedAt,
  postgresMajorVersion,
  countsByType,
  artifactSha256,
  restrictRemovedCount,
  excludedCount,
  maxAppliedMigrationVersion,
}) {
  return {
    capturedAt,
    postgresMajorVersion,
    // 受け入れ条件（Issue #691）: table/function/trigger/index/policy件数。
    // pg_dump の TOC Type フィールドと1:1で対応させる
    // （TABLE/FUNCTION/TRIGGER/INDEX/POLICY。CONSTRAINTやFK CONSTRAINT等その他の種別も
    // 参考情報としてそのまま残す＝countsByTypeの全キーを含める）。
    objectCounts: countsByType,
    artifactSha256,
    restrictMetacommandsRemoved: restrictRemovedCount,
    excludedObjectCount: excludedCount,
    // Fableレビュー M-7（Issue #691本文の要求項目）: Supabase CLI自体が管理する
    // migration history テーブル（supabase_migrations.schema_migrations）の最大version。
    // `public`スキーマの外にあるためpg_dumpの対象には含まれず、fetchMaxAppliedMigrationVersion()
    // が別途1クエリだけ発行して取得する。テーブルが存在しない環境（Supabase CLIを
    // 使っていないPostgreSQL、ローカルDocker検証等）やクエリ失敗時は null になる
    // （「migrationが0件」ではなく「この情報を持たない/取得できなかった」ことを表す）。
    maxAppliedMigrationVersion: maxAppliedMigrationVersion ?? null,
  }
}

/**
 * supabase_migrations.schema_migrations（Supabase CLI自体が管理するmigration historyテーブル）
 * の最大 version を取得する（Issue #691本文 / Fableレビュー M-7対応）。
 *
 * pg_dump は child_process 経由の別プロセスであり、JS側でコネクションを保持しないため、
 * 「pg_dump実行のために確立済みの接続を使い回す」ことはできない。ただし新たな接続管理の
 * 抽象化レイヤーは作らず、同じ接続文字列に対して postgres パッケージ（本リポジトリが
 * scripts/db-migrate.js 等で既に使っているクライアント）で軽量に1回だけ接続・クエリ・
 * 切断するだけに留める（YAGNI、過剰な抽象化をしない）。
 *
 * テーブルが存在しない場合（Supabase CLIを使っていない素のPostgreSQL。ローカルDocker検証等）
 * は null を返す。これはエラーではなく、「この情報を持たないDBに接続している」という
 * 正常な状態として扱う。
 *
 * @param {string} databaseUrl
 * @returns {Promise<string | null>}
 */
export async function fetchMaxAppliedMigrationVersion(databaseUrl) {
  const sql = postgres(core.stripPostgresJsIncompatibleSslParams(databaseUrl), {
    max: 1,
    connect_timeout: 15,
  })
  try {
    const [{ reg }] = await sql`select to_regclass('supabase_migrations.schema_migrations') as reg`
    if (!reg) return null
    const [{ maxVersion }] =
      await sql`select max(version) as "maxVersion" from supabase_migrations.schema_migrations`
    return maxVersion ?? null
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** pg_dump バイナリのパスを解決する。PG_DUMP_BIN 環境変数があれば優先する。 */
function resolvePgDumpBinary(env) {
  return env.PG_DUMP_BIN && env.PG_DUMP_BIN.trim() ? env.PG_DUMP_BIN.trim() : 'pg_dump'
}

/**
 * 接続文字列（DATABASE_URL）からパスワードを分離する純粋関数（N-3、Fableレビュー2回目対応）。
 *
 * 背景: 以前の実装は `spawnSync(pgDumpBin, [databaseUrl, ...])` のようにパスワード込みの
 * 接続文字列をそのまま子プロセスの argv として渡していた。Node の `child_process.spawnSync`
 * は起動時にコマンドライン全体をOSのプロセステーブルへ登録するため、同一マシン上の他ユーザーが
 * `ps aux` 等でプロセス一覧を見ると、そのargvにパスワードが平文でそのまま表示されてしまう
 * （環境変数は通常 `ps` のデフォルト出力に含まれず、`/proc/<pid>/environ`
 * を読める権限を要求するOSが多いのに対し、argvは`ps`のデフォルト出力で誰でも見えるため、
 * 露出の敷居がargvの方が著しく低い）。
 *
 * 対処方針: libpq（pg_dumpが使う接続ライブラリ）は接続URIにパスワードが含まれない場合、
 * `PGPASSWORD` 環境変数からパスワードを解決する仕様を持つ。これを利用し、argvには
 * パスワードを除去した「サニタイズ済みURI」のみを渡し、パスワードは子プロセスの環境変数
 * （`spawnSync` の `env` オプション経由。argvには一切現れない）として渡す設計に変更した。
 *
 * `url.password` はWHATWG URLの仕様上パーセントエンコード済みの形で保持されるため、
 * `PGPASSWORD`（パーセントエンコードされていない生の文字列を期待する）に渡す前に
 * `decodeURIComponent` でデコードする。
 *
 * @param {string} databaseUrl
 * @returns {{ sanitizedUrl: string, password: string | null }}
 * @throws {Error} databaseUrl がURIとしてパースできない場合
 */
export function splitDatabaseUrlPassword(databaseUrl) {
  const url = new URL(databaseUrl)
  const password = url.password ? decodeURIComponent(url.password) : null
  url.password = ''
  return { sanitizedUrl: url.toString(), password }
}

function parseCliArgs(argv) {
  const args = argv.slice(2)
  let outDir = DEFAULT_OUT_DIR
  for (const arg of args) {
    if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length)
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `不明な引数です: ${arg}` }
  }
  return { outDir }
}

const HELP_TEXT = `
使い方:
  DATABASE_URL="postgres://..." node scripts/db-phase2/export-public-schema.mjs [--out-dir=<dir>]

説明:
  pg_dump --schema=public --schema-only --no-owner --no-privileges をラップし、
  生dump（public-schema.raw.sql）と非機密metadataのmanifest.json（capturedAt・
  PostgreSQLメジャーバージョン・オブジェクト種別ごとの件数・SHA-256・
  supabase_migrations.schema_migrationsの最大version）を出力する。
  host名・接続文字列・パスワードはmanifest.jsonに一切含めない。

オプション:
  --out-dir=<dir>  出力先ディレクトリ（既定: ${DEFAULT_OUT_DIR}）
  --help, -h       このヘルプを表示する

環境変数:
  DATABASE_URL   接続文字列（必須。CLI引数では受け付けない）
  PG_DUMP_BIN    pg_dump バイナリのパス（既定: "pg_dump"、PATH経由で解決）
`.trim()

async function main() {
  const parsed = parseCliArgs(process.argv)
  if (parsed.help) {
    console.log(HELP_TEXT)
    return 0
  }
  if (parsed.error) {
    console.error(`[export-public-schema] ${parsed.error}`)
    console.error('')
    console.error(HELP_TEXT)
    return 1
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl || !databaseUrl.trim()) {
    console.error(
      '[export-public-schema] 環境変数 DATABASE_URL が設定されていません。' +
        '接続文字列は環境変数でのみ受け付けます（CLI引数不可、シェル履歴への漏洩防止）。'
    )
    return 1
  }

  const pgDumpBin = resolvePgDumpBinary(process.env)
  console.log(
    `[export-public-schema] pg_dump 実行中... database=${core.redactConnectionString(databaseUrl)}`
  )

  // N-3（Fableレビュー2回目）対応: パスワード込みの接続文字列をそのままargvへ渡さない。
  // sanitizedUrl（パスワード除去済みURI）のみをargvへ、パスワードはPGPASSWORD環境変数
  // （子プロセスの環境変数のみに載り、`ps`等のプロセス一覧には現れない）経由で渡す。
  // 詳細は splitDatabaseUrlPassword のJSDoc参照。
  let sanitizedUrl, dumpPassword
  try {
    ;({ sanitizedUrl, password: dumpPassword } = splitDatabaseUrlPassword(databaseUrl))
  } catch (error) {
    console.error(
      `[export-public-schema] DATABASE_URL の形式が不正です（URIとしてパースできません）: ` +
        core.redactSecretsFromText(String(error?.message ?? error), databaseUrl)
    )
    return 1
  }
  const pgDumpEnv = dumpPassword ? { ...process.env, PGPASSWORD: dumpPassword } : process.env

  // --schema=public --schema-only --no-owner --no-privileges:
  // Issue #691 本文の明示要件。auth/realtime/storage等のSupabase管理スキーマを
  // 巻き込まず、owner/ACLも持ち込まない（後段のnormalize-schema.mjsはこれらが
  // 万一混入した場合の防御的検知のみを担う設計であり、一次防御はここのフラグ指定）。
  const result = spawnSync(
    pgDumpBin,
    [sanitizedUrl, '--schema=public', '--schema-only', '--no-owner', '--no-privileges'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256, env: pgDumpEnv }
  )

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(
        `[export-public-schema] pg_dump コマンドが見つかりません（${pgDumpBin}）。` +
          'PostgreSQLクライアントツールをインストールしてください' +
          '（例: brew install postgresql@17）。' +
          'または PG_DUMP_BIN 環境変数で pg_dump の絶対パスを明示指定してください。'
      )
    } else {
      console.error(
        `[export-public-schema] pg_dump の起動に失敗しました: ` +
          core.redactSecretsFromText(String(result.error), databaseUrl)
      )
    }
    return 2
  }

  if (result.status !== 0) {
    console.error(
      `[export-public-schema] pg_dump がエラー終了しました (exit=${result.status}):`
    )
    console.error(core.redactSecretsFromText(result.stderr ?? '', databaseUrl))
    return 1
  }

  if (result.stderr && result.stderr.trim()) {
    // pg_dump は成功時でも stderr に警告を出すことがある。黙って握りつぶさない
    // （db-migrate.js の PostgreSQL warning 方針と同じ思想）。
    console.warn('[export-public-schema] pg_dump stderr (exit=0、警告として記録):')
    console.warn(core.redactSecretsFromText(result.stderr, databaseUrl))
  }

  const rawDump = result.stdout
  const outDir = parsed.outDir
  mkdirSync(outDir, { recursive: true })

  const rawDumpPath = join(outDir, RAW_DUMP_FILENAME)
  writeFileSync(rawDumpPath, rawDump, 'utf8')

  // normalize-schema.mjs のパーサをそのまま再利用してオブジェクト種別を集計する
  // （TOCコメントのパースロジックを2箇所に重複実装しない）。
  const normalized = normalizeDump(rawDump)
  const artifactSha256 = core.computeChecksum(rawDump)
  const postgresMajorVersion = extractPostgresMajorVersion(rawDump)

  // Fableレビュー M-7: supabase_migrations.schema_migrations の最大versionを取得する。
  // pg_dumpの対象外（publicスキーマの外）のため別クエリが必要。この情報はmanifestの
  // 主目的（スキーマ定義のdrift検知）にとって副次的な項目のため、取得に失敗しても
  // pg_dumpの成果（raw dump・主要なmanifestフィールド）自体は失わない設計にする
  // （取得失敗時はnullを記録し、警告を出すのみでexport全体は継続する）。
  let maxAppliedMigrationVersion = null
  try {
    maxAppliedMigrationVersion = await fetchMaxAppliedMigrationVersion(databaseUrl)
  } catch (error) {
    console.warn(
      '[export-public-schema] supabase_migrations.schema_migrations の最大versionを' +
        '取得できませんでした（manifest.jsonにはnullを記録します）: ' +
        core.redactSecretsFromText(String(error?.message ?? error), databaseUrl)
    )
  }

  const manifest = buildManifest({
    capturedAt: new Date().toISOString(),
    postgresMajorVersion,
    countsByType: normalized.countsByType,
    artifactSha256,
    restrictRemovedCount: normalized.restrictRemovedCount,
    // マジック文字列 'exclude' 直書きを避け、normalize-schema.mjs が公開する定数を使う
    // （normalize-schema.mjs 側でカテゴリ名の内部表現が変わった場合にここも追随できるように）。
    excludedCount: normalized.countsByCategory[OBJECT_CATEGORY.EXCLUDE],
    maxAppliedMigrationVersion,
  })

  const manifestPath = join(outDir, MANIFEST_FILENAME)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`[export-public-schema] raw dump: ${rawDumpPath} (${rawDump.length} bytes)`)
  console.log(`[export-public-schema] manifest: ${manifestPath}`)
  console.log(`[export-public-schema] PostgreSQL major version: ${postgresMajorVersion ?? '(不明)'}`)
  console.log(
    `[export-public-schema] supabase_migrations.schema_migrations 最大version: ${maxAppliedMigrationVersion ?? '(不明/未取得)'}`
  )
  console.log(`[export-public-schema] artifact sha256: ${artifactSha256}`)
  console.log('[export-public-schema] オブジェクト種別ごとの件数:')
  for (const [type, count] of Object.entries(normalized.countsByType).sort()) {
    console.log(`    ${type}: ${count}`)
  }
  if (normalized.warnings.length > 0) {
    console.warn(
      `[export-public-schema] 警告: 防御的除外の対象になったオブジェクトが${normalized.warnings.length}件あります。` +
        ' normalize-schema.mjs 実行時に詳細を確認してください。'
    )
  }

  return 0
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
