#!/usr/bin/env node

/**
 * provider-neutral migration runner の純粋ロジック / Issue #692
 *
 * 背景:
 * 現行の migration 運用は `supabase db push`（Supabase CLI）に依存しており、
 * PlanetScale切替後は新規migrationを適用できなくなる。本モジュールは
 * `scripts/db-migrate.js`（CLI・DB接続を持つ薄いラッパー）から呼ばれる
 * 「ファイルI/Oはあるが DB 接続は一切持たない」純粋ロジックを集約する。
 * `scripts/check-migration-order.js` や `scripts/replay-maintenance-eventsub.js`
 * と同じ流儀（純粋関数を module.exports して単体テスト可能にする）を踏襲する。
 *
 * このファイルが担う責務:
 *   - migration ファイルの発見・ソート・ファイル名からの version/name 抽出
 *   - descriptor（transaction/providers宣言）のパースとchecksum計算
 *   - 重複version検知
 *   - ディスク上のファイルと history（DB から読んだ行）の突き合わせ（diff）
 *   - 接続文字列のredaction（ログ・エラーメッセージへのcredential漏洩防止）
 *
 * DB接続・SQL実行・advisory lock・トランザクション制御は scripts/db-migrate.js が担う
 * （`postgres` パッケージへの依存はそちらのみに閉じ込め、本ファイルは node 標準の
 * fs/path/crypto/os のみに依存する）。
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto')

// ファイル名から version（数値/タイムスタンプ接頭辞）と name（接頭辞除去後、拡張子除去済み）を
// 抽出する正規表現。scripts/check-migration-order.js の MIGRATION_FILENAME_RE
// (`/^(\d+)_.+\.sql$/`) と同じ「先頭が数字の連続、区切りは `_`」というパターンを共有する
// （新形式 `YYYYMMDDHHMMSS_name.sql`・旧形式 `NNNNN_name.sql` の両方にマッチする）。
// name も抽出する点だけが check-migration-order.js との違い。どちらかを変更する場合は
// 両ファイルを同期させること。
const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/

// migration descriptor ヘッダーコメントの許容値（Issue #692 設計方針）
const VALID_TRANSACTION_MODES = ['required', 'forbidden', 'optional']
const VALID_PROVIDERS = ['supabase', 'planetscale', 'postgres']
const DEFAULT_TRANSACTION_MODE = 'required' // 安全側のデフォルト（SQL全体を1トランザクションで実行）

const TRANSACTION_HEADER_RE = /^--\s*migration-transaction:\s*(\S+)\s*$/m
// providers 側は「宣言はあるが値が空」(コロンの後に何も無い) を "未宣言と同じ扱い" にせず
// 明示的な誤り (errors) として検知したいため、transaction と異なり `\S` を要求しない
// (行末までを丸ごとキャプチャしてから trim する)。
const PROVIDERS_HEADER_RE = /^--\s*migration-providers:(.*)$/m

/**
 * twica_meta.schema_migrations の advisory lock キー計算に使う入力文字列。
 * 実際の 64bit int への変換 (`hashtext(...)`) は Postgres 側で行う
 * （scripts/db-migrate.js が `select pg_advisory_lock(hashtext($1))` で使用する）。
 * JS 側で Postgres の hashtext アルゴリズムを再実装しない（車輪の再発明を避ける）ための定数。
 */
const ADVISORY_LOCK_KEY_INPUT = 'twica_meta.schema_migrations'

/** twica_meta スキーマ・履歴テーブルの作成 DDL（Issue #692 設計方針そのまま） */
const HISTORY_SCHEMA_SQL = 'create schema if not exists twica_meta'
const HISTORY_TABLE_SQL = `
create table if not exists twica_meta.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  applied_by text,
  execution_id uuid not null
)
`.trim()

/**
 * ファイル名から version/name を抽出する純粋関数。
 * @param {string} filename
 * @returns {{ version: string, name: string } | null} マッチしない場合は null
 */
function parseFilenameVersion(filename) {
  const match = filename.match(MIGRATION_FILENAME_RE)
  if (!match) return null
  return { version: match[1], name: match[2] }
}

/**
 * ファイル先頭の連続するコメント行（`--` で始まる行、および空行）を「ヘッダーブロック」として
 * 切り出す。descriptor宣言（migration-transaction / migration-providers）はこのブロック内のみを
 * 対象にパースし、ファイル中盤・末尾のコメント（既存ファイルによくある詳細な日本語コメント）に
 * たまたま同じ文字列が現れても誤検出しないようにする。
 * @param {string} content
 * @returns {string}
 */
function extractHeaderBlock(content) {
  const lines = content.split('\n')
  const header = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('--')) {
      header.push(trimmed)
      continue
    }
    break
  }
  return header.join('\n')
}

/**
 * migration descriptor ヘッダーコメントをパースする純粋関数。
 *
 * 宣言が無い場合は安全側のデフォルト（transaction: required, providers: 全provider対象）を採用する。
 * 宣言はあるが値が不正な場合（typo等）は、同じ安全側デフォルトにフォールバックしつつ
 * errors に理由を積む。呼び出し側（diffMigrationState 経由で db-migrate.js）はこの errors を
 * 検知して status/plan/apply/verify いずれも即座にエラー終了させる
 * （不正な宣言を安全側にフォールバックしたまま黙って処理を続けない）。
 *
 * @param {string} content ファイル内容全体
 * @returns {{ transaction: 'required'|'forbidden'|'optional', providers: string[] | null, errors: string[] }}
 *   providers は null の場合「全provider対象」を表す（省略時のデフォルト）
 *
 * 申し送り（Issue #692 Fableレビュー Medium-2、#691着手時に思い出すためのメモ）:
 * このヘッダー宣言（migration-transaction / migration-providers）は checksum 計算対象の
 * ファイル内容そのものに含まれる。つまり「既に適用済みのファイルへ後からヘッダーを追記する」と
 * checksum が変わり、diffMigrationState の checksumMismatches として即エラー終了してしまう。
 * 既存71ファイル（本PR時点で全て未適用扱い＝これから初めてhistoryへ登録される想定）は
 * このタイミングでの追記なら問題ないが、一度でも apply/bootstrap で登録された後は
 * 当該ファイルへ migration-providers 等を後付けできない（新規ファイルとして書き直すしかない）。
 * PlanetScale切替（#691）着手時、既存ファイルへの後付けを検討する場合はこの制約に注意すること。
 */
function parseDescriptorHeader(content) {
  const header = extractHeaderBlock(content)
  const errors = []

  let transaction = DEFAULT_TRANSACTION_MODE
  const transactionMatch = header.match(TRANSACTION_HEADER_RE)
  if (transactionMatch) {
    const raw = transactionMatch[1]
    if (VALID_TRANSACTION_MODES.includes(raw)) {
      transaction = raw
    } else {
      errors.push(
        `migration-transaction の値が不正です: "${raw}" (許容値: ${VALID_TRANSACTION_MODES.join(', ')})`
      )
    }
  }

  let providers = null
  const providersMatch = header.match(PROVIDERS_HEADER_RE)
  if (providersMatch) {
    const tokens = providersMatch[1]
      .trim()
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    const invalidTokens = tokens.filter((t) => !VALID_PROVIDERS.includes(t))
    if (tokens.length === 0) {
      errors.push('migration-providers が空です（少なくとも1つ指定するか、宣言自体を省略してください）')
    } else if (invalidTokens.length > 0) {
      errors.push(
        `migration-providers に不正な値が含まれています: ${invalidTokens.join(', ')} (許容値: ${VALID_PROVIDERS.join(', ')})`
      )
    } else {
      providers = tokens
    }
  }

  return { transaction, providers, errors }
}

/**
 * ファイル内容全体の SHA-256 checksum（16進文字列）を計算する純粋関数。
 * @param {string} content
 * @returns {string}
 */
function computeChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * ファイル内容から「実質的なSQL文の個数」を簡易カウントする純粋関数。
 * `migration-transaction: forbidden` のバリデーション専用に使う（Issue #692 Fableレビュー High-1）。
 *
 * 背景: PostgreSQL は複数文の simple query バッチ（`sql.unsafe(fileContent)` が送る形）を
 * 暗黙のトランザクションブロックとして実行する。そのため `CREATE INDEX CONCURRENTLY` のように
 * トランザクション外実行が必須な文を2本以上含む `forbidden` ファイルは
 * `cannot run inside a transaction block` で実行時に失敗する（Dockerでの実機検証で確認済み）。
 * このチェックはその事故を実行前（status/plan/apply/verify いずれの時点でも）に検知するためのもの。
 *
 * 制約（意図的な簡易実装。厳密なSQLパーサは導入しない）:
 *   - 空行・行全体が `--` から始まる行（単純なコメント行）のみを除去対象とする。
 *     行末コメント（`SELECT 1; -- comment`）やブロックコメント（C言語スタイルの範囲コメント）の除去は行わない。
 *   - `;` で素朴に分割するだけで、文字列リテラル内の `;`（例: `'a;b'`）はエスケープ対応しない。
 *     そのため稀に誤検知（実際は1文なのに複数文と判定される等）はあり得るが、
 *     forbidden ファイルは「複数文を書かない」運用を強制する目的のチェックなので、
 *     安全側（誤検知で書き直しを促す）に倒れる分には実害が小さいと判断している。
 *
 * @param {string} content
 * @returns {number} 実質的なSQL文の個数
 */
function countEffectiveStatements(content) {
  const codeLines = content.split('\n').filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('--')
  })
  return codeLines
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length
}

/**
 * 1ファイル分の migration descriptor を組み立てる純粋関数。
 * ファイル名が MIGRATION_FILENAME_RE にマッチしない場合、version/name は null になり、
 * errors にその旨が積まれる（呼び出し側で不正ファイルとして扱われる）。
 *
 * @param {string} filename ベース名（ディレクトリ部分を含まない）
 * @param {string} content ファイル内容全体
 * @returns {{
 *   filename: string, version: string | null, name: string | null, checksum: string,
 *   transaction: 'required'|'forbidden'|'optional', providers: string[] | null, errors: string[]
 * }}
 */
function buildMigrationDescriptor(filename, content) {
  const parsed = parseFilenameVersion(filename)
  const header = parseDescriptorHeader(content)
  const errors = [...header.errors]

  if (!parsed) {
    errors.push(
      `不正なファイル名です (先頭が数値プレフィックス + "_" + 名前 + ".sql" である必要があります): ${filename}`
    )
  }

  // High-1 (Issue #692 Fableレビュー): forbidden は「SQL文1つのみ」をサポートする。
  // 詳細は countEffectiveStatements のコメント参照。
  if (header.transaction === 'forbidden') {
    const statementCount = countEffectiveStatements(content)
    if (statementCount > 1) {
      errors.push(
        'migration-transaction: forbidden のファイルはSQL文を1つだけ含む必要があります' +
          '（PostgreSQLは複数文のsimple queryバッチを暗黙のトランザクションブロックとして実行するため、' +
          'CREATE INDEX CONCURRENTLY 等のトランザクション外実行が必須な文を2本以上まとめて実行できません）。' +
          `検出された実質的なSQL文の数: ${statementCount}`
      )
    }
  }

  return {
    filename,
    version: parsed ? parsed.version : null,
    name: parsed ? parsed.name : null,
    checksum: computeChecksum(content),
    transaction: header.transaction,
    providers: header.providers,
    errors,
  }
}

/**
 * `supabase/migrations/*.sql` を発見し、ファイル名昇順にソートした migration descriptor 配列を返す。
 * fs 同期I/Oを行うため厳密には「純粋」ではないが、DB接続を一切持たない（unit test では一時
 * ディレクトリを渡して検証できる）。
 *
 * @param {string} migrationsDir 絶対パス
 * @returns {ReturnType<typeof buildMigrationDescriptor>[]}
 */
function loadMigrationFiles(migrationsDir) {
  const filenames = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // ファイル名の昇順（check-migration-order.js が保証する不変条件と同じ並び）

  return filenames.map((filename) => {
    const content = fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
    return buildMigrationDescriptor(filename, content)
  })
}

/**
 * 指定した migration ファイルの内容全体を読み込む。apply 実行時、実際に SQL を流す対象
 * （pending の中でも provider 対象かつ実行することが決まったもの）だけを都度読み込むために使う
 * （loadMigrationFiles は checksum 計算のためだけに内容を読むが、descriptor には保持しない。
 * 71ファイル程度なら保持してもコスト上問題ないが、descriptor はあくまで「メタデータ」に
 * 責務を絞り、実行対象のSQL本文取得は使う側が明示的に行う方が責務が分かりやすいため）。
 *
 * @param {string} migrationsDir
 * @param {string} filename
 * @returns {string}
 */
function readMigrationFile(migrationsDir, filename) {
  return fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
}

/**
 * descriptor 配列から version の重複を検知する純粋関数。
 * version が null（ファイル名が不正）のものは対象外（buildMigrationDescriptor 側で既に
 * errors に積まれているため、ここで二重に報告しない）。
 *
 * @param {ReturnType<typeof buildMigrationDescriptor>[]} descriptors
 * @returns {{ version: string, filenames: string[] }[]}
 */
function findDuplicateVersions(descriptors) {
  const byVersion = new Map()
  for (const d of descriptors) {
    if (!d.version) continue
    const list = byVersion.get(d.version) ?? []
    list.push(d.filename)
    byVersion.set(d.version, list)
  }
  return [...byVersion.entries()]
    .filter(([, filenames]) => filenames.length > 1)
    .map(([version, filenames]) => ({ version, filenames }))
}

/**
 * descriptor が指定 provider に適用対象かどうかを判定する純粋関数。
 * providers が null（宣言省略）の場合は全 provider が対象。
 *
 * @param {{ providers: string[] | null }} descriptor
 * @param {string} provider
 * @returns {boolean}
 */
function isProviderApplicable(descriptor, provider) {
  if (!descriptor.providers) return true
  return descriptor.providers.includes(provider)
}

/**
 * descriptor 配列から errors を集約する純粋関数（不正ファイル名・不正descriptor宣言）。
 * @param {ReturnType<typeof buildMigrationDescriptor>[]} descriptors
 * @returns {{ filename: string, errors: string[] }[]}
 */
function collectDescriptorErrors(descriptors) {
  return descriptors.filter((d) => d.errors.length > 0).map((d) => ({ filename: d.filename, errors: d.errors }))
}

/**
 * ディスク上の migration descriptor 配列と、DB から読んだ history 行配列を突き合わせ、
 * apply/status/plan/verify 共通で使う diff 結果を作る純粋関数。
 *
 * 「既適用versionのchecksum変更を検知したら即座にエラー終了する」という要件（Issue #692）は、
 * ここで checksumMismatches / missingFiles として検出し、呼び出し側（db-migrate.js）が
 * 空でなければ処理を中断する、という形で実現する。
 *
 * @param {ReturnType<typeof buildMigrationDescriptor>[]} descriptors ディスク上の全migration（ファイル名昇順）
 * @param {{ version: string, name: string, checksum: string, applied_at: unknown, applied_by: string | null, execution_id: string }[]} historyRows
 *   DB の twica_meta.schema_migrations から読んだ行（順不同で渡してよい）
 * @param {string} provider 対象provider（'supabase' | 'planetscale' | 'postgres'）
 * @returns {{
 *   applied: Array<ReturnType<typeof buildMigrationDescriptor> & { appliedAt: unknown, appliedBy: string | null, executionId: string }>,
 *   pending: ReturnType<typeof buildMigrationDescriptor>[],
 *   skippedForProvider: ReturnType<typeof buildMigrationDescriptor>[],
 *   checksumMismatches: Array<{ version: string, name: string, diskChecksum: string, historyChecksum: string }>,
 *   missingFiles: Array<{ version: string, name: string }>,
 * }}
 */
function diffMigrationState(descriptors, historyRows, provider) {
  const historyByVersion = new Map(historyRows.map((r) => [r.version, r]))
  const diskByVersion = new Map(descriptors.filter((d) => d.version).map((d) => [d.version, d]))

  const checksumMismatches = []
  const missingFiles = []
  for (const row of historyRows) {
    const disk = diskByVersion.get(row.version)
    if (!disk) {
      // 適用済みとして記録されているのに、ディスク上にファイルが無い
      // （適用後にファイルが削除・リネームされた）。整合性違反として報告する。
      missingFiles.push({ version: row.version, name: row.name })
      continue
    }
    if (disk.checksum !== row.checksum) {
      // 適用済みファイルの内容が改変されている（checksum不一致）。
      checksumMismatches.push({
        version: row.version,
        name: row.name,
        diskChecksum: disk.checksum,
        historyChecksum: row.checksum,
      })
    }
  }

  const applied = []
  const pending = []
  const skippedForProvider = []
  for (const d of descriptors) {
    if (!d.version) continue // 不正ファイル名は collectDescriptorErrors 側で既に報告済み
    const historyRow = historyByVersion.get(d.version)
    if (historyRow) {
      applied.push({
        ...d,
        appliedAt: historyRow.applied_at,
        appliedBy: historyRow.applied_by,
        executionId: historyRow.execution_id,
      })
      continue
    }
    if (!isProviderApplicable(d, provider)) {
      skippedForProvider.push(d)
      continue
    }
    pending.push(d)
  }

  return { applied, pending, skippedForProvider, checksumMismatches, missingFiles }
}

/**
 * 接続文字列（DATABASE_URL）からパスワードをマスクした文字列を返す純粋関数。
 * host名・ポート・DB名・クエリパラメータ（sslmode等）はそのまま残す
 * （運用者がログから接続先を判別できるようにするため）が、credential部分は必ず `***` に置換する。
 *
 * パースに失敗した場合（想定外のフォーマット）は、中身を一切含まない固定文字列を返す
 * （「わからないので一部だけ出す」ではなく「わからないので何も出さない」方向に倒す）。
 *
 * @param {string | undefined} rawConnectionString
 * @returns {string}
 */
function redactConnectionString(rawConnectionString) {
  if (!rawConnectionString) return '(not set)'
  try {
    const url = new URL(rawConnectionString)
    if (url.password) url.password = '***'
    // ユーザー名自体は一般に秘密情報ではないが、念のためマスクしない方針は明示しておく
    // （twica_app 等の固定ロール名であり、パスワードのように使い回されるcredentialではない）。
    return url.toString()
  } catch {
    return '(接続文字列の形式が不正なため出力を抑制しました)'
  }
}

/**
 * 接続文字列からパスワード部分（URLエンコード済み・デコード済みの両方）を抽出する。
 * redactErrorMessage が任意のエラーメッセージ文字列からパスワードを取り除くために使う。
 * @param {string | undefined} rawConnectionString
 * @returns {string[]} 抽出できたパスワード候補（重複除去、長さ0は除外）
 */
function extractPasswordCandidates(rawConnectionString) {
  if (!rawConnectionString) return []
  try {
    const url = new URL(rawConnectionString)
    if (!url.password) return []
    const candidates = new Set([url.password])
    try {
      candidates.add(decodeURIComponent(url.password))
    } catch {
      // decode失敗（不正なパーセントエンコーディング）は無視し、エンコード済み形のみ使う
    }
    return [...candidates].filter((c) => c.length > 0)
  } catch {
    return []
  }
}

/**
 * 任意のテキスト（postgres.js が投げる例外メッセージ等、接続文字列全体を含みうるもの）から
 * 接続文字列のパスワード部分を除去する防御的なredaction関数。
 * redactConnectionString は「自分でURLを組み立てて出力する」場合のガード、こちらは
 * 「ライブラリ側が生成したエラーメッセージに何が紛れ込んでいるか完全には制御できない」場合の
 * 二重の安全網として使う。
 *
 * @param {string} text
 * @param {string | undefined} rawConnectionString
 * @returns {string}
 */
function redactSecretsFromText(text, rawConnectionString) {
  if (typeof text !== 'string') return text
  let result = text
  for (const password of extractPasswordCandidates(rawConnectionString)) {
    result = result.split(password).join('***')
  }
  return result
}

module.exports = {
  MIGRATION_FILENAME_RE,
  VALID_TRANSACTION_MODES,
  VALID_PROVIDERS,
  DEFAULT_TRANSACTION_MODE,
  ADVISORY_LOCK_KEY_INPUT,
  HISTORY_SCHEMA_SQL,
  HISTORY_TABLE_SQL,
  parseFilenameVersion,
  extractHeaderBlock,
  parseDescriptorHeader,
  computeChecksum,
  countEffectiveStatements,
  buildMigrationDescriptor,
  loadMigrationFiles,
  readMigrationFile,
  findDuplicateVersions,
  isProviderApplicable,
  collectDescriptorErrors,
  diffMigrationState,
  redactConnectionString,
  extractPasswordCandidates,
  redactSecretsFromText,
}
