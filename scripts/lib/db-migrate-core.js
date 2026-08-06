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
 * ファイル内容（コメント行・空行を除いた実効コード）に `SET LOCAL` が含まれるかを検査する
 * 純粋関数。Issue #691（PlanetScale移行 Chunk 1）タスク3のガードで使う
 * （buildMigrationDescriptor 内のコメント参照）。
 * countEffectiveStatements と同様、行全体が `--` から始まる単純なコメント行のみを除外する
 * 簡易実装（行末コメント・ブロックコメントは対象外）。
 * @param {string} content
 * @returns {boolean}
 */
function containsSetLocal(content) {
  const codeLines = content.split('\n').filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('--')
  })
  return /\bSET\s+LOCAL\b/i.test(codeLines.join('\n'))
}

/**
 * 非加法的(non-additive)なmigration文を検知する純粋関数 / Issue #800。
 *
 * 背景:
 * `.github/workflows/planetscale-migrate.yml` が main push 毎に `apply --provider=planetscale`
 * を自動実行し本番DBへmigrationを適用する。アプリ側の deploy-window fallback は
 * 加法的（additive）な変更（列追加等）にしか成り立たないため、DROP COLUMN や RENAME 等の
 * 非加法的変更が混入したmigrationが誤って本番へ自動適用されると、
 * 新旧アプリコードとスキーマの不一致による本番障害に直結する。
 * 本関数はその事故を「apply 実行前に」機械的にブロックするための検知を行う
 * （shouldBlockFreshApply と同じ「事故は起きる前提でコードが守る」設計思想）。
 *
 * 検知の考え方:
 * - 単語だけ（`\bdrop\b` 等）で検知すると、実ファイルに多数存在する列名 `drop_rate`・
 *   関数名 `rename_card_pack` 等を誤検知するため、「文の形」（`DROP COLUMN` 等）で検知する。
 * - `DROP INDEX` / `DROP CONSTRAINT` / `DROP POLICY` / `DROP TRIGGER` は
 *   アプリが読む列・表・関数の契約（クエリ結果面）を変えず、実ファイルにも既に存在する
 *   ため、意図的にブロック対象外とする。
 * - 完全なSQLパーサは過剰実装（YAGNI）。正規表現ベースの簡易検知で、未知構文バリアントの
 *   見逃しは許容し、最終防御はレビュー運用に委ねる。代表的な見逃し例:
 *   PostgreSQL の `COLUMN` キーワード省略形（`ALTER TABLE t DROP c;` /
 *   `ALTER TABLE t RENAME a TO b;` / `ALTER id TYPE ...`）は検知しない（誤検知を
 *   増やさず、安全側に倒さない判断。省略形が混入する場合はレビューで気づく前提）。
 * - 行コメント・ブロックコメントは事前に除去する（ヘッダー記述やコメント内言及による
 *   誤検知を防ぐ。extractCreatedIndexNames と同じ前処理。文字列リテラル内や
 *   DO ブロック内のキーワードは除去されず検知されるが、安全側に倒れるため許容する）。
 *
 * @param {string} content - migration ファイルの内容全体
 * @returns {{ kind: string, line: number }[]} 検出された文の種別と行番号（1始まり）の配列。無ければ空配列
 */
const NON_ADDITIVE_PATTERNS = [
  // 列削除。IF EXISTS が付いていても旧コードが列を読む契約を破壊するためブロックする
  { kind: 'DROP COLUMN', re: /\bdrop\s+column\b/gi },
  // 列・表のリネーム。クエリが書く列名・表名の契約を破壊する
  { kind: 'RENAME COLUMN/TABLE', re: /\brename\s+(column|table|to)\b/gi },
  // 型変更（ALTER COLUMN ... TYPE / SET DATA TYPE）。読み書きの型契約を変更する。
  // 識別子は「スペースを含むクォート付き（"my col"）」または「空白・カンマ・セミコロンを
  // 含まない通常トークン」のどちらでも受ける
  {
    kind: 'ALTER COLUMN TYPE',
    re: /\balter\s+column\s+(?:"[^"]*"|[^\s,;]+)\s+(type|set\s+data\s+type)\b/gi,
  },
  // オブジェクト削除。実行時参照が死ぬ。DROP INDEX/CONSTRAINT/POLICY/TRIGGER は対象外
  // （アプリが読む契約面を変えないため、意図的に許可する）
  {
    kind: 'DROP TABLE/VIEW/FUNCTION',
    re: /\bdrop\s+(table|view|materialized\s+view|function|procedure|schema|sequence|type|domain|extension)\b/gi,
  },
  // データ破壊（TRUNCATE ... RESTART IDENTITY CASCADE を含む）。
  // TRUNCATE は PostgreSQL の unreserved keyword のため識別子（`CREATE TABLE truncate` 等）
  // にもマッチしうる。対象名の形まで含めることで、識別子としての使用は誤検知しない
  { kind: 'TRUNCATE', re: /\btruncate\s+(?:table\s+)?(?:[a-z_][a-z0-9_$]*|"[^"]*")/gi },
]

function detectNonAdditiveStatements(content) {
  // ブロックコメント除去 → 行コメント除去。ブロックコメント内の改行は行番号を維持する
  // ため残す（extractCreatedIndexNames の前処理は改行を消すため、行番号を報告する
  // 本関数ではブロックコメントの文字だけを除去する実装にしている）。
  const code = content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/--.*$/g, ''))
    .join('\n')
  const findings = []
  for (const p of NON_ADDITIVE_PATTERNS) {
    for (const match of code.matchAll(p.re)) {
      // マッチ位置から行番号を算出（1始まり）。ファイルは小さいため先頭から数えてもコストは無視できる
      const line = code.slice(0, match.index).split('\n').length
      findings.push({ kind: p.kind, line })
    }
  }
  // ファイル内の出現順（行番号順）で並べ替え、同一行での重複報告は先頭の1件にまとめる
  // （同一行に DROP COLUMN と TRUNCATE が並ぶことは実運用でほぼ無く、行番号と種別が
  // 分かれば人間が現物を見て判断できるため、全件列挙はしない）。
  findings.sort((a, b) => a.line - b.line)
  const deduped = []
  let previousLine = -1
  for (const f of findings) {
    if (f.line === previousLine) continue
    deduped.push(f)
    previousLine = f.line
  }
  return deduped
}

/**
 * forbidden migration に含まれる CREATE INDEX の名前を取り出す純粋関数。
 *
 * CREATE INDEX CONCURRENTLY は失敗時に「無効なindexが残る」ことがある。
 * その状態で `IF NOT EXISTS` を再実行すると、PostgreSQLは同名relationが
 * あるとして作成をスキップするため、runnerがSQL成功だけを見てhistoryへ
 * 記録すると、以後ずっと壊れたindexを正当な適用済みとして扱ってしまう。
 * runnerはこの名前を使って `pg_index.indisvalid/indisready` を確認し、
 * 不完全なindexのままhistoryへ進まないようにする。
 *
 * 厳密なSQLパーサを導入せず、migrationで使うCREATE INDEXの定型だけを扱う。
 * 行コメントとブロックコメントは除去するが、文字列リテラル中のキーワードを
 * SQLとして解釈することはしない。対象migrationはDDL 1文だけという別ガードを
 * 既に持つため、ここで複雑な汎用SQLパーサを追加するのはYAGNIと判断した。
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractCreatedIndexNames(content) {
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/g, ''))
    .join('\n')
  const pattern = /\bCREATE\s+INDEX(?:\s+CONCURRENTLY)?\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_$]*))/gi
  const names = []
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1] ?? match[2]
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * forbidden migrationのCREATE INDEX文を、名前と定義の組で抽出する純粋関数。
 *
 * `IF NOT EXISTS`は同名relationがあるとDDLを成功扱いにするため、名前だけを
 * `pg_index`で確認すると、別テーブル・別列・別方式の誤ったindexを正しいものと
 * 取り違える。runnerはこの定義と`pg_get_indexdef`を正規化比較してからhistoryへ
 * 登録する。対象migrationは1文DDLという既存ガードがあるため、汎用SQLパーサを
 * 導入せず、コメント除去後のセミコロン区切りで十分な範囲に限定する。
 *
 * @param {string} content
 * @returns {{ name: string, definition: string }[]}
 */
function extractCreatedIndexDefinitions(content) {
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/g, ''))
    .join('\n')
  const definitions = []
  for (const statement of withoutComments.split(';')) {
    const trimmed = statement.trim()
    if (!/^CREATE\s+INDEX\b/i.test(trimmed)) continue
    const match = trimmed.match(
      /^CREATE\s+INDEX(?:\s+CONCURRENTLY)?\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_$]*))/i
    )
    if (!match) continue
    const name = match[1] ?? match[2]
    if (!definitions.some((definition) => definition.name === name)) {
      definitions.push({ name, definition: trimmed })
    }
  }
  return definitions
}

/**
 * CREATE INDEX文と`pg_get_indexdef`の表記差を吸収して比較用に正規化する。
 *
 * PostgreSQLは省略された`USING btree`を出力へ補い、opclassのschema修飾を
 * 省略することがある。一方、migration側には`CONCURRENTLY`/`IF NOT EXISTS`が
 * ある。これらは実体のindex定義ではないため吸収するが、対象テーブル、列、
 * sort方向、アクセス方式、opclass、predicateは残し、誤った同名indexを通さない。
 * @param {string} definition
 * @returns {string}
 */
/**
 * SQL定義のquoted literal / identifier / dollar-quoted bodyをplaceholderへ退避する。
 * normalizeIndexDefinitionは引用符外の空白・大小文字だけを吸収する必要があるため、
 * 先にこの境界を確定する。E''のbackslash escape、doubled quote、$tag$ / $$ の双方を
 * 扱い、定義比較のためにリテラル内容を変更しない。
 * @param {string} sql
 * @returns {{ masked: string, quotedSegments: string[] }}
 */
function maskQuotedSqlSegments(sql) {
  const quotedSegments = []
  let masked = ''

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const isEscapeStringPrefix =
      (character === 'e' || character === 'E') &&
      sql[index + 1] === "'" &&
      (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1]))
    if (character === "'" || character === '"' || isEscapeStringPrefix) {
      const quoteIndex = isEscapeStringPrefix ? index + 1 : index
      const quote = sql[quoteIndex]
      const isEscapeString = isEscapeStringPrefix
      let end = quoteIndex + 1
      for (; end < sql.length; end += 1) {
        if (isEscapeString && sql[end] === '\\' && end + 1 < sql.length) {
          end += 1
          continue
        }
        if (sql[end] !== quote) continue
        if (sql[end + 1] === quote) {
          end += 1
          continue
        }
        end += 1
        break
      }
      const placeholder = `\u0001${quotedSegments.length}\u0002`
      quotedSegments.push(sql.slice(index, end))
      masked += placeholder
      index = end - 1
      continue
    }

    if (character === '$') {
      const dollarTag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
      if (dollarTag) {
        const closingIndex = sql.indexOf(dollarTag, index + dollarTag.length)
        if (closingIndex >= 0) {
          const end = closingIndex + dollarTag.length
          const placeholder = `\u0001${quotedSegments.length}\u0002`
          quotedSegments.push(sql.slice(index, end))
          masked += placeholder
          index = end - 1
          continue
        }
      }
    }

    masked += character
  }

  return { masked, quotedSegments }
}

/**
 * placeholderへ退避したquoted segmentを元のSQLへ戻す。
 * @param {string} masked
 * @param {string[]} quotedSegments
 * @returns {string}
 */
function restoreQuotedSqlSegments(masked, quotedSegments) {
  return masked.replace(/\u0001(\d+)\u0002/g, (_match, index) => quotedSegments[Number(index)])
}

/**
 * 括弧が式全体を一重に包んでいる場合だけ外す。quoted segmentはplaceholderに
 * 置換済みなので、predicate内のliteralに含まれる括弧を誤って数えない。
 * @param {string} expression
 * @returns {string}
 */
function stripRedundantOuterParentheses(expression) {
  let result = expression.trim()
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0
    let enclosesWholeExpression = true
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] === '(') depth += 1
      if (result[index] === ')') depth -= 1
      if (depth === 0 && index < result.length - 1) {
        enclosesWholeExpression = false
        break
      }
    }
    if (!enclosesWholeExpression || depth !== 0) break
    result = result.slice(1, -1).trim()
  }
  return result
}

/**
 * PostgreSQLがpartial predicateの各比較式へ付ける冗長な括弧を吸収する。
 * AND/ORを含むグループの括弧はprecedenceを変えうるため、比較演算子を含み、
 * グループ内にトップレベルのAND/ORが無い場合だけ対象にする。
 * @param {string} predicate
 * @returns {string}
 */
function stripSimplePredicateParentheses(predicate) {
  let result = predicate
  let changed = true
  while (changed) {
    changed = false
    result = result.replace(/\(([^()]+)\)/g, (match, inner) => {
      if (!/[=<>]\s*/.test(inner) || /\b(?:AND|OR)\b/i.test(inner)) return match
      changed = true
      return inner
    })
  }
  return result
}

/**
 * PostgreSQL E-stringのescapeを値へデコードする。単文字escapeだけでなく、
 * `\\xNN` / `\\ooo` / `\\uNNNN` / `\\UNNNNNNNN`を扱わないと、正しいE-string
 * predicateをpg_get_indexdefの通常literalと同一視できず、逆に誤ったliteralを
 * canonicalizeして通す可能性がある。PostgreSQLが受理する未知escapeはbackslashを
 * 除去し、不完全なhex/Unicode escapeは原表記を保って比較を安全側へ倒す。
 * @param {string} body
 * @returns {string}
 */
function decodePostgresEscapeString(body) {
  const result = []
  const simpleEscapes = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
  }
  const byteEscapes = []
  const flushByteEscapes = () => {
    if (byteEscapes.length === 0) return
    try {
      result.push(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(byteEscapes))
      )
    } catch {
      // 不正なUTF-8 byte列はPostgreSQL側でも通常literalへcanonicalizeできない。
      // 値を推測せず、byte escapeの原表記へ戻して比較を不一致にする。
      result.push(...byteEscapes.map((byte) => String.fromCharCode(byte)))
    }
    byteEscapes.length = 0
  }

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\' || index + 1 >= body.length) {
      flushByteEscapes()
      result.push(body[index])
      continue
    }

    const escape = body[index + 1]
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
      flushByteEscapes()
      result.push(simpleEscapes[escape])
      index += 1
      continue
    }

    if (escape === 'x' || escape === 'u' || escape === 'U') {
      const digitCount = escape === 'x' ? 2 : escape === 'u' ? 4 : 8
      const digits = body.slice(index + 2, index + 2 + digitCount)
      const pattern = escape === 'x' ? /^[0-9A-Fa-f]{1,2}/ : new RegExp(`^[0-9A-Fa-f]{${digitCount}}$`)
      if (escape === 'x' && !/^[0-9A-Fa-f]/.test(digits)) {
        // \xにhex digitが続かない場合、PostgreSQLは特殊escapeと解釈せず
        // backslashを除去してxをそのまま値にする（E'\\x' -> 'x'）。
        flushByteEscapes()
        result.push(escape)
        index += 1
        continue
      }
      const matchedDigits = digits.match(pattern)?.[0]
      if (matchedDigits) {
        const codePoint = Number.parseInt(matchedDigits, 16)
        if (escape === 'x') {
          byteEscapes.push(codePoint)
          index += 1 + matchedDigits.length
          continue
        }
        if (escape === 'u' && codePoint >= 0xd800 && codePoint <= 0xdbff) {
          const lowSurrogate = body
            .slice(index + 2 + digitCount)
            .match(/^\\u([0-9A-Fa-f]{4})/i)?.[1]
          const lowCodePoint = lowSurrogate ? Number.parseInt(lowSurrogate, 16) : null
          if (lowCodePoint !== null && lowCodePoint >= 0xdc00 && lowCodePoint <= 0xdfff) {
            flushByteEscapes()
            result.push(String.fromCodePoint(0x10000 + (codePoint - 0xd800) * 0x400 + lowCodePoint - 0xdc00))
            index += 1 + digitCount + 2 + digitCount
            continue
          }
        }
        if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          flushByteEscapes()
          result.push(String.fromCodePoint(codePoint))
          index += 1 + matchedDigits.length
          continue
        }
      }
      result.push('\\', escape)
      index += 1
      continue
    }

    if (/^[0-7]$/.test(escape)) {
      const digits = body.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0]
      if (digits) {
        byteEscapes.push(Number.parseInt(digits, 8))
        index += digits.length
        continue
      }
    }

    // PostgreSQLは未知escapeのbackslashを捨て、後続文字だけを値にする。
    // 例: E'\\q' は 'q'。これはpg_get_indexdefとの一致に必要な仕様である。
    flushByteEscapes()
    result.push(escape)
    index += 1
  }
  flushByteEscapes()
  return result.join('')
}

/**
 * single-quoted / E-string / dollar-quoted literalを同じ標準SQL literal表記へ
 * 揃える。pg_get_indexdefは入力の$$literal$$を' literal '::textへ書き換えるため、
 * 表記だけが異なる同値literalを比較で拒否しないようにする。
 * @param {string} segment
 * @returns {string}
 */
function canonicalizeQuotedLiteral(segment) {
  if (segment.startsWith('"')) return segment

  let body
  if (segment.startsWith('$')) {
    const tag = segment.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
    body = tag ? segment.slice(tag.length, -tag.length) : segment
  } else {
    const isEscapeString = /^[eE]'/u.test(segment)
    body = segment.slice(isEscapeString ? 2 : 1, -1)
    if (isEscapeString) {
      body = body.replace(/''/g, "'")
      body = decodePostgresEscapeString(body)
    } else {
      body = body.replace(/''/g, "'")
    }
  }
  return `'${body.replace(/'/g, "''")}'`
}

function normalizeIndexDefinition(definition) {
  const withoutTrailingSemicolon = definition.trim().replace(/;$/, '')
  const { masked, quotedSegments } = maskQuotedSqlSegments(withoutTrailingSemicolon)
  const canonicalQuotedSegments = quotedSegments.map(canonicalizeQuotedLiteral)
  let normalized = masked.replace(/\s+/g, ' ').trim()
    .replace(/\bCREATE\s+INDEX\s+CONCURRENTLY\s+/i, 'CREATE INDEX ')
    .replace(/\bIF\s+NOT\s+EXISTS\s+/i, '')
    .replace(/\bpublic\.gin_trgm_ops\b/gi, 'gin_trgm_ops')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')

  // migrationではbtreeのUSING句を省略できるが、pg_get_indexdefは明示する。
  // ここまでにquoted identifierもplaceholderへ置換済みなので、schema/tableが
  // 引用符付きでも同じ表記差吸収を適用できる。placeholderはrestore時に元の
  // quoted identifierへ戻るため、識別子の大小文字・空白は保持される。
  const maskedIdentifier = '(?:\\u0001\\d+\\u0002|[a-z_][a-z0-9_$]*)'
  normalized = normalized.replace(
    new RegExp(
      `\\bON\\s+(${maskedIdentifier}(?:\\.${maskedIdentifier})?)\\s+(?=\\()`,
      'i'
    ),
    'ON $1 USING btree '
  )

  // pg_get_indexdefは、文字列literalへ暗黙の::text castを追加し、partial
  // predicate全体を括弧で包む（例: WHERE (status = 'READY'::text)）。
  // literal placeholder直後のcastだけを吸収し、他の式に明示されたcastは残す。
  normalized = normalized.replace(/\u0001(\d+)\u0002::text\b/gi, (match, index) => {
    const segment = canonicalQuotedSegments[Number(index)]
    return segment && /^'/.test(segment)
      ? `\u0001${index}\u0002`
      : match
  })
  const whereIndex = normalized.search(/\bWHERE\b/i)
  if (whereIndex >= 0) {
    const whereKeyword = normalized.slice(whereIndex).match(/^WHERE\b/i)?.[0] ?? 'WHERE'
    const predicate = stripSimplePredicateParentheses(
      stripRedundantOuterParentheses(normalized.slice(whereIndex + whereKeyword.length))
    )
    normalized = `${normalized.slice(0, whereIndex)}${whereKeyword} ${predicate}`
  }

  // SQLキーワード・未引用識別子の大小文字は意味を持たないが、single-quoted
  // literalとdouble-quoted identifierの大小文字は意味を持つ。定義全体を
  // toLowerCase()すると、例えば WHERE status = 'READY' と 'ready' を同一視して
  // IF NOT EXISTS後の誤ったindexをhistoryへ登録してしまうため、引用符の外側だけを
  // 小文字化する。PostgreSQLの標準的な doubled-quote escapeも1文字列として保持する。
  let lowercasedOutsideQuotes = ''
  let quote = null
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (quote !== null) {
      lowercasedOutsideQuotes += character
      if (character === quote) {
        if (normalized[index + 1] === quote) {
          lowercasedOutsideQuotes += normalized[index + 1]
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      lowercasedOutsideQuotes += character
    } else {
      lowercasedOutsideQuotes += character.toLowerCase()
    }
  }
  return restoreQuotedSqlSegments(lowercasedOutsideQuotes, canonicalQuotedSegments)
}

/**
 * 既存同名indexの定義がmigrationの意図と一致するかを検証する純粋関数。
 * @param {{ name: string, definition: string }[]} expectedDefinitions
 * @param {{ name: string, definition?: string }[]} states
 * @returns {string[]} 定義不一致のindex名
 */
function validateIndexDefinitions(expectedDefinitions, states) {
  const stateByName = new Map(states.map((state) => [state.name, state]))
  return expectedDefinitions
    .filter((expected) => {
      const actual = stateByName.get(expected.name)
      if (!actual || typeof actual.definition !== 'string') return false
      return normalizeIndexDefinition(expected.definition) !== normalizeIndexDefinition(actual.definition)
    })
    .map((expected) => expected.name)
}

/**
 * DBから返されたindex状態が、期待したindexをすべて有効にしているか検証する純粋関数。
 *
 * `indisready` は再構築・作成途中のindexを除外し、`indisvalid` はplannerが利用可能な
 * indexかを表す。どちらか一方でもfalseなら、migration historyへ登録する前に停止して
 * 再実行または運用者によるREINDEX/DROP判断を促す。DB問い合わせ自体はCLI側に残し、
 * この関数はfault-injection相当の状態（missing/invalid/valid）を単体テストできるようにする。
 *
 * @param {string[]} expectedNames
 * @param {{ name: string, indisvalid: boolean, indisready: boolean }[]} states
 * @returns {{ missing: string[], invalid: string[] }}
 */
function validateIndexStates(expectedNames, states) {
  const stateByName = new Map(states.map((state) => [state.name, state]))
  const missing = expectedNames.filter((name) => !stateByName.has(name))
  const invalid = expectedNames.filter((name) => {
    const state = stateByName.get(name)
    return state !== undefined && (state.indisvalid !== true || state.indisready !== true)
  })
  return { missing, invalid }
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

    // Issue #691（PlanetScale移行 Chunk 1）タスク3: SET LOCAL はトランザクションブロック内
    // でのみ有効というPostgreSQL仕様上のガード。
    //
    // 背景: supabase/migrations/00051_add_card_owner_stats.sql（160行目）は
    // `SET LOCAL statement_timeout = 0;` を使っている。このファイルは
    // migration-transaction ヘッダー宣言を持たないため DEFAULT_TRANSACTION_MODE
    // （'required'）が適用され、db-migrate.js の apply は `sql.begin()` でこのファイル
    // 全体をトランザクションに包んで実行する。この設計では SET LOCAL は正しく
    // 効果を持つ（トランザクション内のみに限定される変更が、まさにそのトランザクション内で
    // 完結するため）。
    //
    // 一方、`migration-transaction: forbidden` はSQLをトランザクション外
    // （オートコミット、1文ずつ独立）で実行する宣言であり、この場合 SET LOCAL の効果は
    // 直後の1文（SET LOCAL自身が暗黙的に作るトランザクション）で終わってしまい、
    // 後続のSQL文には一切適用されない。実際に `psql -f`（オートコミットモード）で
    // 00051を流すと `WARNING: SET LOCAL can only be used in transaction blocks` が
    // 発生することをDocker実機検証で確認済み（docs/history/migration/PLANETSCALE_MIGRATION_AUDIT.md 3.1節、
    // docs/planetscale-schema-baseline.md）。
    //
    // 現状の00051自体はforbiddenを宣言していないため、このガードは「将来この
    // ファイル（または同様にSET LOCALを使う新規ファイル）へ誤ってforbiddenが
    // 宣言された場合」を検知するための予防線であり、既存71ファイルのいずれにも
    // 現時点では該当しない（`grep -rn "SET LOCAL" supabase/migrations/*.sql` で
    // 00051以外に同種のパターンが無いことを確認済み。同ファイルはforbiddenを
    // 宣言していないため本ガードには引っかからない）。
    if (containsSetLocal(content)) {
      errors.push(
        'migration-transaction: forbidden と SET LOCAL は併用できません' +
          '（SET LOCAL はトランザクションブロック内でのみ有効というPostgreSQLの仕様のため、' +
          'forbidden 宣言（オートコミット実行）では SET LOCAL の効果が直後の1文に限定され、' +
          '後続のSQL文には適用されません。SET LOCAL の効果を保ちたい場合は ' +
          'migration-transaction: required（既定値）を使うか、SET LOCAL を' +
          'セッションスコープの SET（LOCALなし）に書き換えてください。）'
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
 * 指定ディレクトリの `*.sql` を発見し、ファイル名昇順にソートした migration descriptor 配列を返す。
 * fs 同期I/Oを行うため厳密には「純粋」ではないが、DB接続を一切持たない（unit test では一時
 * ディレクトリを渡して検証できる）。
 *
 * 各 descriptor には `sourceDir`（このディレクトリの絶対パス）を付与する。
 * `loadMigrationFilesFromDirs` で複数ディレクトリの結果をマージした後も、
 * どのディレクトリの実ファイルを読めばよいか（`readMigrationFile` の呼び出し）を
 * descriptor 単体から判断できるようにするため（Issue #691 Chunk 1 C-1対応）。
 *
 * @param {string} migrationsDir 絶対パス
 * @returns {(ReturnType<typeof buildMigrationDescriptor> & { sourceDir: string })[]}
 */
function loadMigrationFiles(migrationsDir) {
  const filenames = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // ファイル名の昇順（check-migration-order.js が保証する不変条件と同じ並び）

  return filenames.map((filename) => {
    const content = fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
    return { ...buildMigrationDescriptor(filename, content), sourceDir: migrationsDir }
  })
}

/**
 * 複数ディレクトリから migration ファイルを読み込み、ファイル名昇順で1本にマージする純粋関数
 * （fs同期I/Oはあるがpure）。Issue #691 Chunk 1（C-1、Fableレビュー）対応:
 * `--provider=planetscale` 実行時、`supabase/migrations/`（共通/Supabase向け）と
 * `db/planetscale/migrations/`（PlanetScale専用、Supabase CLIの `supabase db push` が
 * スキャンしない別ディレクトリ）の両方からmigrationを読み込み、1つの適用順序として扱う
 * 必要があるために追加した。
 *
 * ディレクトリをまたいだファイル名（version）の重複は本関数では検知しない
 * （既存の `findDuplicateVersions(descriptors)` がマージ後の配列に対してそのまま機能する
 * ため、ここで重複ロジックを再実装しない）。
 *
 * @param {string[]} migrationsDirs 絶対パスの配列（1つでもよい）
 * @returns {(ReturnType<typeof buildMigrationDescriptor> & { sourceDir: string })[]} ファイル名昇順
 */
function loadMigrationFilesFromDirs(migrationsDirs) {
  const merged = migrationsDirs.flatMap((dir) => loadMigrationFiles(dir))
  merged.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
  return merged
}

/**
 * 指定した migration ファイルの内容全体を読み込む。apply 実行時、実際に SQL を流す対象
 * （pending の中でも provider 対象かつ実行することが決まったもの）だけを都度読み込むために使う
 * （loadMigrationFiles は checksum 計算のためだけに内容を読むが、descriptor には保持しない。
 * 71ファイル程度なら保持してもコスト上問題ないが、descriptor はあくまで「メタデータ」に
 * 責務を絞り、実行対象のSQL本文取得は使う側が明示的に行う方が責務が分かりやすいため）。
 * 呼び出し側は descriptor の `sourceDir`（`loadMigrationFiles`/`loadMigrationFilesFromDirs` が
 * 付与）をそのまま `migrationsDir` に渡すことを想定している。
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
 * postgres.js が接続文字列内で認識しない `sslrootcert` クエリパラメータを取り除く純粋関数。
 *
 * ==== 正本 ====
 * このファイルがこのロジックの正本（single source of truth）である。
 * `src/lib/db/client.ts` はこの関数を直接 `import` する（root の tsconfig.json が
 * `allowJs: true` のため、TypeScript から `.js` の CommonJS モジュールを問題なく
 * import できる。実際に `tsc --noEmit` で検証済み）。`scripts/db-migrate.js` /
 * `scripts/verify-db-schema.js` は `require('./lib/db-migrate-core')` で利用する。
 * 唯一の例外は `analysis/dev/adminApiPg.ts`: `analysis/` は root とは別の npm
 * パッケージ（独自の node_modules、npm workspaces 未使用）であり、root の
 * ソースを import すると暗黙のディレクトリ遡り解決に頼ることになり壊れやすいため、
 * 意図的に同ロジックの独立コピーを持つ（Fableレビューで妥当性を確認済み）。
 * ロジックを変更する場合は analysis 側のコピーも同期させること。
 *
 * ==== 背景（実PlanetScale previewで実機確認済み） ====
 * PlanetScale ダッシュボードが提供する接続文字列には
 * `?sslmode=verify-full&sslrootcert=system` が付与される。
 * `sslrootcert=system` は libpq（psql/pg_dump 等のC実装クライアント、libpq 14+）
 * 固有の記法で「システムのCA証明書ストアを使う」ことを意味する。
 *
 * postgres.js（本プロジェクトが使う純JS実装のNode driver、v3.4.9）は
 * `sslrootcert === 'system'` を特別扱いして `ssl` オプションを `'verify-full'` に
 * 変換するコードを持つ（node_modules/postgres/cjs/src/index.js:445 実装確認済み）が、
 * `sslrootcert` キー自体を query オブジェクトから削除し忘れているため、残った
 * `sslrootcert` が「未知の接続オプション」として PostgreSQL への startup packet の
 * セッションパラメータに混入し（同ファイル470-487行目、`ssl`/`sslmode`等の既知
 * defaultsキーに含まれない query パラメータは全て `connection` オブジェクトへ
 * 転写されそのままサーバーへ送信される）、
 * `unrecognized configuration parameter "sslrootcert"` で接続自体が失敗する。
 *
 * ==== Major-1（Fableレビュー）: sslmode 明示補完について ====
 * `sslrootcert` を単純に削除するだけでは、`sslmode` が付いていない接続文字列
 * （`?sslrootcert=system` のみ）で平文接続へサイレントダウングレードする重大な
 * リグレッションが起きる。理由（node_modules/postgres/cjs/src/index.js の
 * parseOptions、442-445行目で実機確認済み）:
 *   1. `query.sslmode && (query.ssl = query.sslmode, delete query.sslmode)`
 *   2. `query.sslrootcert === 'system' && (query.ssl = 'verify-full')`
 * の2行がこの順で実行される。postgres.js 自身は本来 (2) で `sslrootcert=system`
 * を見て `ssl` を `'verify-full'` に昇格させる救済ロジックを持つが、この関数が
 * postgres() を呼ぶ「前」に `sslrootcert` を URL から消してしまうため、postgres.js
 * 側の `query.sslrootcert` は常に `undefined` になり (2) が発火しない。`sslmode`
 * も無ければ `query.ssl` は一切設定されず、`ssl` は defaults の `false`（平文接続）
 * のまま `postgres()` に渡ってしまう。修正前の「未知パラメータで接続失敗」という
 * fail-loud な壊れ方より悪い「暗号化なしで無言接続」という壊れ方になる。
 *
 * 対策: `sslrootcert` を削除する際、その時点で `sslmode` が指定されていなければ
 * `sslmode=verify-full` を明示的に補う。これにより `sslrootcert=system` が本来
 * 意図していた「システムCAストアでの完全な証明書検証」が、postgres.js 側の
 * 救済ロジックに頼らず独立して成立する。`sslmode` が既に指定されている場合は
 * 呼び出し元の意図（PlanetScale以外の接続先を含む）を尊重し上書きしない。
 *
 * `sslmode=verify-full` は postgres.js 内で正しく `ssl='verify-full'` として
 * 解釈され（node_modules/postgres/cjs/src/connection.js の `secure()`）、
 * `require`/`allow`/`prefer` のような緩いモードとは異なり `rejectUnauthorized` を
 * 明示 false にしない（Node tls のデフォルト rejectUnauthorized: true のまま）上に
 * `servername` を設定してホスト名検証も行う。つまり証明書検証を弱める変更ではない
 * （PlanetScaleの証明書がNode.js標準のCAトラストストアで検証可能なことも
 * 実機確認済み）。
 *
 * パースに失敗した場合（URLとして不正な接続文字列）は変換をあきらめて元の文字列を
 * そのまま返す（このユーティリティの責務は sslrootcert の除去・sslmode補完のみで
 * あり、接続文字列自体の妥当性検証は呼び出し元の postgres() に委ねる）。
 *
 * @param {string} connectionString
 * @returns {string}
 */
function stripPostgresJsIncompatibleSslParams(connectionString) {
  if (!connectionString) return connectionString
  try {
    const url = new URL(connectionString)
    const hadSslRootCert = url.searchParams.has('sslrootcert')
    url.searchParams.delete('sslrootcert')
    // Major-1: sslrootcert 除去だけだと、sslmode 未指定URLが平文接続へサイレント
    // ダウングレードしうる（このJSDoc「Major-1」セクション参照）。sslrootcert が
    // 実際に存在した場合のみ、かつ sslmode が空文字列も含めて未指定の場合のみ補う
    // （既存の明示的な sslmode 指定は上書きしない）。`.has()`だけだと`sslmode=`
    // （空文字列）を「指定済み」とみなしてしまい、postgres.js側でfalsy評価され
    // 平文接続になる病的ケースが残るため`.get()`の真偽値も見る（Fableレビュー再検証Minor-1）。
    if (hadSslRootCert && !url.searchParams.get('sslmode')) {
      url.searchParams.set('sslmode', 'verify-full')
    }
    return url.toString()
  } catch {
    return connectionString
  }
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
  containsSetLocal,
  detectNonAdditiveStatements,
  extractCreatedIndexNames,
  extractCreatedIndexDefinitions,
  normalizeIndexDefinition,
  validateIndexDefinitions,
  validateIndexStates,
  buildMigrationDescriptor,
  loadMigrationFiles,
  loadMigrationFilesFromDirs,
  readMigrationFile,
  findDuplicateVersions,
  isProviderApplicable,
  collectDescriptorErrors,
  diffMigrationState,
  redactConnectionString,
  extractPasswordCandidates,
  redactSecretsFromText,
  stripPostgresJsIncompatibleSslParams,
}
