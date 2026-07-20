#!/usr/bin/env node

/**
 * secret列（token/secret/password/hash）の抽出・既知リスト管理 / Issue #697 Chunk 1 タスク7
 *
 * 背景:
 * cutover検証ツールのreport・ログ・エラーメッセージは、接続文字列・パスワード・トークンの
 * 生値を一切含めてはならない（Issue #697本文「安全性」節）。Chunk 1（identity + schema
 * レイヤー）は行データそのものを扱わないため、この時点で実際にsecret列の「値」がreportに
 * 混入するリスクは無い（schema比較は列名・型のみを扱う）。しかし後続チャンク（Layer 4:
 * 行データchecksum）ではsecret列の値をhash化せず生のままcanonical化してしまう事故が
 * 起こりうるため、「どの列がsecretか」を機械的に特定できるリストを今のうちに用意し、
 * 単体テストで「schema.tsの実際の列と乖離していないか」を継続的に検知できるようにする
 * （Issue #697本文の要求: 「将来の列追加で検知漏れが起きないように」）。
 *
 * 実装方針（YAGNI）:
 * schema.ts の列定義パーサを新規に書かず、scripts/verify-db-schema.js が既に持つ
 * `parseSchemaFile`（Drizzle pgTable() 定義の正規表現ベースパーサ）をそのまま再利用する
 * （車輪の再発明を避ける。同モジュールは `require.main === module` ガードを持つため、
 * require するだけでは main() が実行されずDB接続も発生しない）。
 */

'use strict'

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

const require = createRequire(import.meta.url)
const { parseSchemaFile } = require('../verify-db-schema.js')

/**
 * secret列名とみなす正規表現。Issue #697本文の指定パターンそのまま
 * （`/token|secret|password|hash/i`）。
 */
export const SECRET_COLUMN_NAME_PATTERN = /token|secret|password|hash/i

/**
 * schema.ts のソーステキストから、SECRET_COLUMN_NAME_PATTERN にマッチする列を
 * `テーブル名.列名` 形式（table-qualified）で抽出する純粋関数（DB接続なし、ファイルI/Oもしない。
 * 呼び出し側がソーステキストを読み込んで渡す）。
 *
 * table-qualifiedにする理由（Fableレビュー M-7対応）: 当初は列名のみで重複除去していたため、
 * 例えば `twitch_access_token` は既に users/twitch_bot_accounts の2テーブルで共有されており、
 * 「将来別の新テーブルに同名のsecret列が追加されても抽出結果の集合が変わらず、乖離検知テストが
 * すり抜ける」という穴があった。table.column形式にすることで、テーブル単位の追加・削除を
 * 正確に検知できる。
 *
 * @param {string} schemaSource src/lib/db/schema.ts の内容全体
 * @returns {string[]} `テーブル名.列名` 形式でマッチしたもの（重複除去・ソート済み）
 */
export function extractSecretColumnNames(schemaSource) {
  const tables = parseSchemaFile(schemaSource)
  const names = new Set()
  for (const [tableName, columns] of tables) {
    for (const columnName of columns.keys()) {
      if (SECRET_COLUMN_NAME_PATTERN.test(columnName)) {
        names.add(`${tableName}.${columnName}`)
      }
    }
  }
  return [...names].sort()
}

/**
 * 現時点（Issue #697 Chunk 1実装時点）で schema.ts を目視確認して確定した、既知のsecret列名リスト。
 * `tests/unit/db-cutover/secret-columns.test.ts` が
 * `extractSecretColumnNames(実際のschema.tsソース)` と本定数の一致をテストする。
 *
 * このリストと実際の抽出結果が乖離したら（＝新しいtoken/secret/password/hash列がschema.tsに
 * 追加されたら）、そのテストが失敗する。テストが失敗した場合、開発者はこの定数を更新し、
 * かつ後続チャンク（Layer 4データchecksum実装時）でその新列がhash化対象に含まれることを
 * 確認する必要がある（本定数はあくまで「検知」のためのものであり、更新するだけでは
 * 自動的に安全になるわけではないことに注意）。
 *
 * 内訳（2026-07-20時点、src/lib/db/schema.ts目視確認、実際に
 * `node scripts/db-cutover/secret-columns.mjs` を実行して確認済み）:
 *   - users.twitch_access_token / users.twitch_refresh_token / users.twitch_token_expires_at
 *   - twitch_bot_accounts.twitch_access_token / twitch_bot_accounts.twitch_refresh_token /
 *     twitch_bot_accounts.twitch_token_expires_at
 *   - support_codes.code_hash
 *
 * `*.twitch_token_expires_at` について: 値自体はトークンではなく有効期限のtimestamp
 * （非機密）だが、列名に "token" を含むためパターンにマッチする。本リストの目的は
 * 「意味的にsecretと確定した列」の管理ではなく「パターンマッチで拾われる列を漏れなく
 * 棚卸しし、後続チャンクでの判断（hash化対象に含めるか、非機密として除外するかを
 * 明示的に決める）を強制する」ことなので、非機密と分かっていてもここには含める
 * （リストから外すとテストの「乖離検知」機能が働かなくなるため）。
 */
export const KNOWN_SECRET_COLUMNS = [
  'support_codes.code_hash',
  'twitch_bot_accounts.twitch_access_token',
  'twitch_bot_accounts.twitch_refresh_token',
  'twitch_bot_accounts.twitch_token_expires_at',
  'users.twitch_access_token',
  'users.twitch_refresh_token',
  'users.twitch_token_expires_at',
]

// CLIとしても直接実行できるようにしておく（`node scripts/db-cutover/secret-columns.mjs` で
// 現在のschema.tsから抽出したsecret列一覧を確認できる。デバッグ・監査目的の補助コマンド）。
function main() {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'db', 'schema.ts')
  const source = readFileSync(schemaPath, 'utf8')
  const found = extractSecretColumnNames(source)
  console.log('[secret-columns] schema.ts から抽出したsecret列名:')
  for (const name of found) console.log(`  ${name}`)
  const knownSet = new Set(KNOWN_SECRET_COLUMNS)
  const foundSet = new Set(found)
  const missing = found.filter((n) => !knownSet.has(n))
  const stale = KNOWN_SECRET_COLUMNS.filter((n) => !foundSet.has(n))
  if (missing.length > 0 || stale.length > 0) {
    console.error(
      '[secret-columns] KNOWN_SECRET_COLUMNS が実際のschema.tsと乖離しています。' +
        'scripts/db-cutover/secret-columns.mjs の KNOWN_SECRET_COLUMNS を更新してください。'
    )
    if (missing.length > 0) console.error(`  未登録（新規検知）: ${missing.join(', ')}`)
    if (stale.length > 0) console.error(`  リストにあるが実在しない（削除された列?）: ${stale.join(', ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
