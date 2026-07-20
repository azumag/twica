#!/usr/bin/env node

/**
 * src/lib/db/schema.ts から Layer 3/4（layer-data.mjs）が必要とするtable catalogを
 * 組み立てる / Issue #697 Chunk 2
 *
 * catalogの内容（テーブルごと）:
 *   - tableName
 *   - primaryKeyColumns: PK列名（複合PKの場合は宣言順、単一PKなら1要素）
 *   - columns: 列名昇順にソートされた `{ name, dataType, isSecret }` の配列
 *     （dataTypeは information_schema.columns.data_type 相当の文字列、
 *     isSecretは scripts/db-cutover/secret-columns.mjs の判定を利用）
 *
 * なぜ実DBへのinformation_schema問い合わせではなくschema.tsを正とするか:
 * scripts/db-cutover/secret-columns.mjs と同じ理由（同ファイル冒頭コメント参照）。
 * schema.tsはバージョン管理された安定した入力であり、CI上でDB接続無しに
 * catalogの妥当性（drift検知）を単体テストできる。実DBとの整合性はLayer 2
 * （schema比較）が別途担保する。
 *
 * PK抽出について（本ファイルの新規実装部分）:
 * `scripts/verify-db-schema.js` の `parseSchemaFile` は列の dataType/notNull は
 * 抽出するが、「どの列がPKか」（特に複合PKの列集合・順序）までは抽出しない
 * （.primaryKey() の有無を notNull 判定に使っているのみ）。本ファイルは
 * pgTable(...) 呼び出し全体（第2引数の列オブジェクトだけでなく、複合PKを
 * 宣言する第3引数のコールバックまで）を括弧の深さで自己完結的に抽出し、
 * 単一列PK（`.primaryKey()` チェーン）・複合PK（`primaryKey({ columns: [...] })`）
 * の両方を判定する。
 */

'use strict'

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

const require = createRequire(import.meta.url)
const { parseSchemaFile } = require('../verify-db-schema.js')
import { extractSecretColumnNames } from './secret-columns.mjs'

/**
 * schema.ts のソーステキストから解析の邪魔になる部分を除去する。
 * `scripts/verify-db-schema.js` の `stripNoise` と同じ処理をあえて重複定義している
 * （2行程度の軽微なロジックであり、PK抽出という別関心事のために本体スクリプトの
 * exportを増やすより、独立したモジュールとして完結させる方針を優先した）。
 * @param {string} source
 * @returns {string}
 */
function stripNoise(source) {
  return source.replace(/`[^`]*`/gs, '``').replace(/\/\/[^\n]*/g, '')
}

/**
 * `pgTable(` 呼び出し1つ分の全文（開き括弧の次の文字〜対応する閉じ括弧の直前まで）を
 * 括弧の深さカウントで切り出す。列オブジェクト（第2引数）だけでなく、複合PKを宣言する
 * 第3引数のコールバック関数まで含めて1つのテキストとして扱う。
 *
 * 制約（verify-db-schema.jsのparseSchemaFileと同じ簡易パーサ方針、Issue #697 Chunk2）:
 * 単純な括弧深さカウントのため、単一引用符の文字列リテラル内に未エスケープの `(`/`)` が
 * 含まれていた場合は誤動作しうる。実際の schema.ts を目視・grep確認し、該当箇所が
 * 無いことを確認済み（列定義のdefault値文字列に括弧を含むものは無い）。
 *
 * @param {string} strippedSource stripNoise適用後のソース全体
 * @returns {Map<string, string>} テーブル名 → pgTable呼び出し全文
 */
function extractPgTableCalls(strippedSource) {
  const calls = new Map()
  const callStartRe = /pgTable\(/g
  while (callStartRe.exec(strippedSource) !== null) {
    const openParenIndex = callStartRe.lastIndex - 1
    let depth = 0
    let end = -1
    for (let i = openParenIndex; i < strippedSource.length; i++) {
      const ch = strippedSource[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      throw new Error('extractPgTableCalls: unbalanced parentheses while scanning a pgTable(...) call')
    }
    const callText = strippedSource.slice(openParenIndex + 1, end)
    const nameMatch = /^\s*'([^']+)'/.exec(callText)
    if (!nameMatch) {
      throw new Error('extractPgTableCalls: could not find the table name string as the first argument')
    }
    calls.set(nameMatch[1], callText)
  }
  return calls
}

/**
 * pgTable呼び出し全文の中から、列に直接チェーンされた `.primaryKey()` を探す
 * （複合PKの場合はこの形は使われない前提。schema.ts目視確認済み）。
 * @param {string} callText
 * @returns {string[]} 見つかった列名（通常0または1件。複数見つかった場合は全て返す）
 */
// verify-db-schema.js の parseColumns と同じ前提: 列定義は「1行1列」というschema.tsの
// 実際のスタイルに依存する（正規表現が `(?:^|\n)\s*\w+:` で行頭からのみ列開始を検出するため）。
// 複数列を1行に詰め込むスタイルは検出対象外だが、schema.ts自体がそのスタイルを使っていない
// ため実害は無い。
function findChainedPrimaryKeyColumns(callText) {
  const columnStartRe = /(?:^|\n)\s*\w+:\s*(?:uuid|text|boolean|jsonb|timestamp|integer|numeric|bigint|smallint|varchar)\(\s*'([^']+)'/g
  const starts = []
  let m
  while ((m = columnStartRe.exec(callText)) !== null) {
    starts.push({ index: m.index, columnName: m[1] })
  }
  const pkColumns = []
  starts.forEach((col, i) => {
    const chunkEnd = i + 1 < starts.length ? starts[i + 1].index : callText.length
    const chunk = callText.slice(col.index, chunkEnd)
    if (/\.primaryKey\(\)/.test(chunk)) pkColumns.push(col.columnName)
  })
  return pkColumns
}

/**
 * pgTable呼び出し全文の中から、複合PK宣言 `primaryKey({ columns: [table.a, table.b] })` を
 * 探し、列名を宣言順で返す。見つからなければ null。
 * @param {string} callText
 * @returns {string[] | null}
 */
function findCompositePrimaryKeyColumns(callText) {
  const compositeMatch = /primaryKey\(\s*\{\s*columns:\s*\[([\s\S]*?)\]\s*\}\s*\)/.exec(callText)
  if (!compositeMatch) return null
  const columns = [...compositeMatch[1].matchAll(/table\.(\w+)/g)].map((m) => m[1])
  if (columns.length === 0) {
    throw new Error('findCompositePrimaryKeyColumns: primaryKey({ columns: [...] }) had no table.<column> references')
  }
  return columns
}

/**
 * schema.ts 全体から、テーブル名 → PK列名配列（宣言順）のMapを抽出する純粋関数。
 * @param {string} schemaSource src/lib/db/schema.ts の内容全体
 * @returns {Map<string, string[]>}
 */
export function extractPrimaryKeys(schemaSource) {
  const stripped = stripNoise(schemaSource)
  const calls = extractPgTableCalls(stripped)
  const result = new Map()
  for (const [tableName, callText] of calls) {
    const composite = findCompositePrimaryKeyColumns(callText)
    const pkColumns = composite ?? findChainedPrimaryKeyColumns(callText)
    if (pkColumns.length === 0) {
      throw new Error(`extractPrimaryKeys: no primary key found for table '${tableName}' (schema.ts style changed?)`)
    }
    result.set(tableName, pkColumns)
  }
  return result
}

/**
 * schema.ts のソーステキストから、layer-data.mjs が必要とするtable catalogを組み立てる純粋関数。
 * @param {string} schemaSource
 * @returns {Array<{ tableName: string, primaryKeyColumns: string[], columns: Array<{ name: string, dataType: string, isSecret: boolean }> }>}
 */
export function buildTableCatalog(schemaSource) {
  const tablesColumns = parseSchemaFile(schemaSource)
  const primaryKeys = extractPrimaryKeys(schemaSource)
  const secretColumns = new Set(extractSecretColumnNames(schemaSource))

  const catalog = []
  for (const [tableName, columnsMap] of tablesColumns) {
    const primaryKeyColumns = primaryKeys.get(tableName)
    if (!primaryKeyColumns || primaryKeyColumns.length === 0) {
      throw new Error(`buildTableCatalog: no primary key found for table '${tableName}'`)
    }
    const columns = [...columnsMap.entries()]
      .map(([columnName, meta]) => ({
        name: columnName,
        dataType: meta.dataType,
        isSecret: secretColumns.has(`${tableName}.${columnName}`),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    catalog.push({ tableName, primaryKeyColumns, columns })
  }
  return catalog.sort((a, b) => (a.tableName < b.tableName ? -1 : a.tableName > b.tableName ? 1 : 0))
}

/**
 * 実際の src/lib/db/schema.ts を読み込んでtable catalogを組み立てる（ファイルI/Oあり）。
 * layer-data.mjs / init-identity.mjs等のCLIエントリポイントから呼ばれる想定。
 * @returns {ReturnType<typeof buildTableCatalog>}
 */
export function loadTableCatalog() {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'db', 'schema.ts')
  const source = readFileSync(schemaPath, 'utf8')
  return buildTableCatalog(source)
}
