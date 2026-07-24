#!/usr/bin/env node

/**
 * Drizzle スキーマ定義と実 DB の突き合わせ検証スクリプト (#570)
 *
 * 目的:
 * src/lib/db/schema.ts（手書きの Drizzle スキーマ）が PlanetScale PostgreSQL の
 * information_schema と一致していることを確認する。列名・データ型・NOT NULL
 * 制約の3点を照合し、
 * 差分を表形式で出力する。テーブルの抜け漏れは双方向で検出する
 * （schema.ts にあって DB に無いテーブル / DB の public スキーマにあって
 * schema.ts に定義が無いテーブルの両方）。列照合の後に、接続ロールで全テーブルへ
 * SELECT 1 件のスモーククエリを発行し、RLS / GRANT 起因で行が見えない・権限エラーに
 * なるテーブルを検出する（smokeCheckTableAccess のコメント参照）。
 * 差分ゼロ・アクセス失敗ゼロなら exit 0、差分または権限エラーありなら
 * exit 1（接続失敗などの運用エラーは exit 2）。
 *
 * 使い方:
 *   DATABASE_URL="postgres://..." node scripts/verify-db-schema.js
 *   （preview / production それぞれの PlanetScale 接続文字列で実行する。
 *    docs/db-driver-migration.md 参照。DB 接続が必要なため CI では実行しない）
 *
 * 実装方針（重要）:
 * schema.ts の解析は「正規表現ベースの簡易パーサ」で行う。TypeScript コンパイラや
 * drizzle-kit を依存に加えれば厳密に解析できるが、このスクリプトは切替前の補助
 * 検証ツールであり、厳密性より依存ゼロ（プロジェクトに既にある postgres パッケージ
 * 以外を要求しない）を優先する。schema.ts は列定義が
 * 「プロパティ名: 型関数('列名', ...)」という一様なスタイルで書かれており、
 * その前提の範囲で十分正確に抽出できる。スタイルが大きく変わった場合は
 * このパーサも追随が必要（その場合も「差分が出る」方向に壊れるため、
 * 一致しているのに見逃す方向の事故にはなりにくい）。
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./lib/db-migrate-core')

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'lib', 'db', 'schema.ts')

// Drizzle の型関数名 → information_schema.columns.data_type の対応表
// （schema.ts で実際に使われている型のみ。増えたらここに追加する）
const TYPE_FN_TO_DATA_TYPE = {
  uuid: 'uuid',
  text: 'text',
  boolean: 'boolean',
  jsonb: 'jsonb',
  integer: 'integer',
  numeric: 'numeric',
  bigint: 'bigint',
  smallint: 'smallint',
  varchar: 'character varying',
  // timestamp は withTimezone の有無で分岐するため parseColumnChunk 内で処理
}

/**
 * schema.ts のソースから解析の邪魔になる部分を除去する。
 * - テンプレートリテラル（sql`...`）: 中に '{}' や引用符を含み（例: '{}'::text[]）、
 *   ブレース深度カウントや列名抽出を壊すため中身を空にする
 * - 行コメント: 列定義の説明コメントに型関数名などが含まれても誤検出しないように除去
 */
function stripNoise(source) {
  return source
    .replace(/`[^`]*`/gs, '``')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * pgTable('name', { ... }) の列定義オブジェクト部分をブレース深度カウントで
 * 切り出し、テーブルごとの列定義を抽出する。
 *
 * @returns {Map<string, Map<string, { dataType: string, notNull: boolean }>>}
 *   テーブル名 → (列名 → { dataType, notNull })
 */
function parseSchemaFile(source) {
  const cleaned = stripNoise(source)
  const tables = new Map()

  const tableRe = /pgTable\(\s*'([^']+)'\s*,\s*\{/g
  let match
  while ((match = tableRe.exec(cleaned)) !== null) {
    const tableName = match[1]
    // 列定義オブジェクトの開始 '{'（tableRe が消費した最後の1文字）から
    // 対応する '}' までを深度カウントで探す
    const start = tableRe.lastIndex - 1
    let depth = 0
    let end = -1
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      throw new Error(`Unbalanced braces while parsing table '${tableName}' in schema.ts`)
    }
    const block = cleaned.slice(start + 1, end)
    tables.set(tableName, parseColumns(tableName, block))
  }

  return tables
}

/**
 * テーブルの列定義ブロックから列を抽出する。
 * 列は「プロパティ名: 型関数('列名'」で始まり、次の列定義の開始（または
 * ブロック末尾）までを1チャンクとして修飾子（.notNull() 等）を判定する。
 * 修飾子が複数行にまたがるスタイル（.default() が次行など）にも対応できる。
 */
function parseColumns(tableName, block) {
  const columns = new Map()
  const columnRe = /(?:^|\n)\s*\w+:\s*(uuid|text|boolean|jsonb|timestamp|integer|numeric|bigint|smallint|varchar)\(\s*'([^']+)'/g

  const starts = []
  let m
  while ((m = columnRe.exec(block)) !== null) {
    starts.push({ index: m.index, typeFn: m[1], columnName: m[2] })
  }

  starts.forEach((col, i) => {
    const chunkEnd = i + 1 < starts.length ? starts[i + 1].index : block.length
    const chunk = block.slice(col.index, chunkEnd)

    let dataType
    if (col.typeFn === 'timestamp') {
      dataType = /withTimezone:\s*true/.test(chunk)
        ? 'timestamp with time zone'
        : 'timestamp without time zone'
    } else if (col.typeFn === 'text' && /\.array\(\)/.test(chunk)) {
      // text[] は information_schema 上 data_type='ARRAY'（udt_name='_text'）
      dataType = 'ARRAY'
    } else {
      dataType = TYPE_FN_TO_DATA_TYPE[col.typeFn]
    }

    // NOT NULL 判定: .notNull() 明示、または単一列 .primaryKey()（PG では PK 列は
    // 暗黙に NOT NULL になる）。複合 PK（第3引数の primaryKey({...})）の列は
    // schema.ts 側で全列に .notNull() が明示されている前提（現状すべて明示済み）。
    const notNull = /\.notNull\(\)/.test(chunk) || /\.primaryKey\(\)/.test(chunk)

    columns.set(col.columnName, { dataType, notNull })
  })

  if (columns.size === 0) {
    throw new Error(`No columns parsed for table '${tableName}' (schema.ts style changed?)`)
  }

  return columns
}

/**
 * 実 DB の public スキーマに存在する全テーブル名を取得する。
 * schema.ts 側の定義漏れ（DB にだけ存在するテーブル）の検出に使う。
 * VIEW は型付け対象外のため BASE TABLE のみ。
 */
async function fetchDbTableNames(sql) {
  const rows = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
    order by table_name
  `
  return rows.map((row) => row.table_name)
}

/** 実 DB から対象テーブルの列情報を取得する */
async function fetchDbColumns(sql, tableNames) {
  const rows = await sql`
    select table_name, column_name, data_type, is_nullable, udt_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any(${tableNames})
    order by table_name, ordinal_position
  `
  const tables = new Map()
  for (const row of rows) {
    if (!tables.has(row.table_name)) {
      tables.set(row.table_name, new Map())
    }
    tables.get(row.table_name).set(row.column_name, {
      dataType: row.data_type,
      udtName: row.udt_name,
      notNull: row.is_nullable === 'NO',
    })
  }
  return tables
}

/**
 * 接続ロールでの各テーブルへの SELECT アクセス可否を検証するスモークチェック。
 * schema.ts の全テーブルへ「SELECT 1 件」のクエリを発行する。
 *
 * 背景（このチェックが必要な理由）:
 * information_schema の列照合が通っても、接続ロール（twica_app）が RLS / GRANT の
 * 設定不備でデータに到達できないケースは検出できない。特に一部テーブル
 * （storage_usage / blob_files / errors / support_codes / user_licenses）の RLS
 * ポリシーは JWT クレーム述語（auth.jwt() / auth.role()）で書かれており、
 * PostgREST の JWT を持たない pg 直結では述語が常に偽になる。BYPASSRLS を
 * 付与し忘れたロールで接続すると、これらのテーブルは「エラーなく 0 行」に
 * 見えてしまう（docs/db-driver-migration.md のセットアップ手順 1 参照）。
 *
 * 判定の設計（0 行を failure にしない理由）:
 * - RLS は SELECT ではエラーを出さず行を黙って隠すため、「RLS で全行不可視」と
 *   「本当に空のテーブル」はクエリ結果からは区別できない。空テーブルは 0 行が
 *   正常なので、0 行は情報表示（警告）に留め、運用者が preview の実データ量と
 *   突き合わせて判断する（例: storage_usage は 00006 で '_global_' 行を必ず
 *   初期挿入しているため、0 行なら RLS 断絶がほぼ確定）。
 * - 一方、権限エラー（SQLSTATE 42501 insufficient_privilege 等）は GRANT 不足が
 *   一意に確定する明確な失敗のため、failure（exit 1）として扱う。
 *
 * @returns {{ failures: Array<{ tableName: string, error: unknown }>, emptyTables: string[] }}
 */
async function smokeCheckTableAccess(sql, tableNames) {
  const failures = []
  const emptyTables = []
  for (const tableName of tableNames) {
    try {
      // sql(tableName) は postgres.js の識別子エスケープ（テーブル名はスキーマ由来の
      // 固定値だが、文字列連結ではなく識別子ヘルパーで安全に埋め込む）
      const rows = await sql`select 1 as ok from ${sql(tableName)} limit 1`
      if (rows.length === 0) {
        emptyTables.push(tableName)
      }
    } catch (error) {
      failures.push({ tableName, error })
    }
  }
  return { failures, emptyTables }
}

/** schema.ts と DB の列情報を照合し、差分の配列を返す */
function diffSchemas(schemaTables, dbTables, allDbTableNames = []) {
  const diffs = []
  const push = (table, column, kind, expected, actual) =>
    diffs.push({ table, column, kind, expected, actual })

  // DB の public スキーマにあるが schema.ts に定義が無いテーブル（定義漏れ）。
  // schema.ts は「実 DB への完全な型付け」を方針としているため差分として扱う。
  for (const tableName of allDbTableNames) {
    if (!schemaTables.has(tableName)) {
      push(tableName, '*', 'table missing in schema.ts', 'missing', 'exists')
    }
  }

  for (const [tableName, schemaColumns] of schemaTables) {
    const dbColumns = dbTables.get(tableName)
    if (!dbColumns) {
      push(tableName, '*', 'table missing in DB', 'exists', 'missing')
      continue
    }

    for (const [columnName, schemaCol] of schemaColumns) {
      const dbCol = dbColumns.get(columnName)
      if (!dbCol) {
        push(tableName, columnName, 'column missing in DB', schemaCol.dataType, 'missing')
        continue
      }
      // 型比較: ARRAY は udt_name（_text）まで見て text[] であることを確認する
      if (schemaCol.dataType === 'ARRAY') {
        if (dbCol.dataType !== 'ARRAY' || dbCol.udtName !== '_text') {
          push(tableName, columnName, 'type mismatch', 'text[] (ARRAY/_text)', `${dbCol.dataType}/${dbCol.udtName}`)
        }
      } else if (schemaCol.dataType !== dbCol.dataType) {
        push(tableName, columnName, 'type mismatch', schemaCol.dataType, dbCol.dataType)
      }
      if (schemaCol.notNull !== dbCol.notNull) {
        push(
          tableName,
          columnName,
          'nullability mismatch',
          schemaCol.notNull ? 'NOT NULL' : 'NULLABLE',
          dbCol.notNull ? 'NOT NULL' : 'NULLABLE'
        )
      }
    }

    // DB 側にだけ存在する列（schema.ts の定義漏れ）も差分として報告する。
    // schema.ts は「実 DB への完全な型付け」を方針としているため、片方向ではなく
    // 双方向で照合する。
    for (const columnName of dbColumns.keys()) {
      if (!schemaColumns.has(columnName)) {
        push(tableName, columnName, 'column missing in schema.ts', 'missing', dbColumns.get(columnName).dataType)
      }
    }
  }

  return diffs
}

/** 差分を表形式（列幅を揃えたプレーンテキスト）で出力する */
function printDiffTable(diffs) {
  const headers = ['TABLE', 'COLUMN', 'ISSUE', 'SCHEMA.TS', 'DB']
  const rows = diffs.map((d) => [d.table, d.column, d.kind, String(d.expected), String(d.actual)])
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')

  console.log(line(headers))
  console.log(line(widths.map((w) => '-'.repeat(w))))
  for (const row of rows) {
    console.log(line(row))
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Usage: DATABASE_URL="postgres://..." node scripts/verify-db-schema.js')
    console.error('DATABASE_URL is not set (use the Supabase Direct connection string).')
    process.exit(2)
  }

  const source = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const schemaTables = parseSchemaFile(source)
  console.log(`Parsed ${schemaTables.size} tables from src/lib/db/schema.ts`)

  // プロジェクトにインストール済みの postgres パッケージで接続する（新規依存なし）。
  // 検証用の単発接続なので max: 1。fetch_types は既定（true）のまま
  // （information_schema しか読まないが、配列パラメータの型解決を postgres.js に任せる）。
  // PlanetScale接続文字列が付与する sslrootcert パラメータは postgres.js が未知の
  // 接続オプションとしてサーバーへ送りつけてしまい接続失敗する
  // （core.stripPostgresJsIncompatibleSslParams のdocコメント参照。実機確認済み。
  // Major-2 Fableレビュー: このスクリプトが唯一この変換を通さず素の postgres() を
  // 呼んでいたため、実PlanetScale previewに対して実際に同じ接続失敗が再現していた）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const postgres = require('postgres')
  const sql = postgres(core.stripPostgresJsIncompatibleSslParams(databaseUrl), { max: 1, connect_timeout: 15 })

  // process.exit() は finally の await を待たずにプロセスを落とすため、
  // 終了コードを変数に持ち、接続クローズ後に一度だけ exit する
  let exitCode = 0
  try {
    const dbTables = await fetchDbColumns(sql, [...schemaTables.keys()])
    const allDbTableNames = await fetchDbTableNames(sql)
    const diffs = diffSchemas(schemaTables, dbTables, allDbTableNames)

    if (diffs.length === 0) {
      console.log('OK: schema.ts matches the database (column names, data types, NOT NULL).')
    } else {
      console.error(`\nFound ${diffs.length} difference(s):\n`)
      printDiffTable(diffs)
      exitCode = 1
    }

    // 列照合の後に、接続ロールで全テーブルへの SELECT アクセス可否を検証する
    // （failure / 情報表示の判定基準は smokeCheckTableAccess のコメント参照）
    const { failures, emptyTables } = await smokeCheckTableAccess(sql, [...schemaTables.keys()])
    if (failures.length === 0) {
      console.log(`OK: SELECT smoke query succeeded on all ${schemaTables.size} tables for the connecting role.`)
    } else {
      console.error(`\nSELECT smoke query failed on ${failures.length} table(s) (missing GRANT for the connecting role?):\n`)
      for (const { tableName, error } of failures) {
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
        const message = error instanceof Error ? error.message : String(error)
        console.error(`  ${tableName}: [${code}] ${message}`)
      }
      exitCode = 1
    }
    if (emptyTables.length > 0) {
      // 0 行は「空テーブル（正常）」と「RLS で全行不可視（BYPASSRLS 付与漏れ）」を
      // 区別できないため failure にはしない。運用者向けの警告表示に留める。
      console.warn(`\nWARN: ${emptyTables.length} table(s) returned 0 rows. Empty tables are normal, but if the`)
      console.warn('table should contain data, suspect RLS filtering for the connecting role')
      console.warn("(e.g. storage_usage always has the '_global_' seed row; 0 rows there means RLS is blocking):")
      console.warn(`  ${emptyTables.join(', ')}`)
    }
  } catch (error) {
    console.error('Failed to verify schema against the database:')
    console.error(error instanceof Error ? error.message : error)
    exitCode = 2
  } finally {
    await sql.end({ timeout: 5 })
  }
  process.exit(exitCode)
}

// 直接実行時のみ main を起動する。require された場合はパーサ・差分ロジックを
// 公開し、DB 接続なしで動作確認できるようにする
if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}

module.exports = { parseSchemaFile, diffSchemas }
