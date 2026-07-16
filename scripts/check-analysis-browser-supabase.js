#!/usr/bin/env node

/**
 * analysis browser Supabase 直接依存の再導入防止チェッカー (#701 サブタスク7 CI guard)
 *
 * 背景:
 * #701で `analysis/src/lib/supabase.ts` を削除し、ブラウザ側のデータ取得は
 * `/__admin` API 経由（`analysis/src/lib/adminApi.ts`）に一本化した。しかし
 * `analysis/` パッケージ自体には `@supabase/supabase-js` 依存が残っている
 * （`analysis/dev/localAdminApi.ts` という Node dev-server 側コードが、
 * `ANALYSIS_DB_DRIVER` 未設定時の現行デフォルト経路としてまだ実際に使っている
 * ため。#700 で追加した postgres.js 直結経路はオプトインのみで、Phase 2 DB
 * 切替のオーナーGO判断が出るまでは Supabase 経路がデフォルトのまま）。
 *
 * このため「analysis/ 全体で @supabase import 禁止」という単純なルールは
 * 適用できない（`dev/` 配下の正当な現行利用を誤検知する）。このスクリプトは
 * ブラウザに配信される `analysis/src/**` 配下のみをチェック対象とし、
 * 将来誰かがこのスコープの区別を知らずに `src/` 配下へ直接Supabase参照を
 * 再導入してしまう事故を機械的に防ぐ（ブラウザ bundle への再混入防止）。
 *
 * `analysis/dev/**`（Node dev-server側）は意図的にチェック対象外。そちらの
 * Supabase依存を削除する場合は Phase 2 DB 切替後の別対応とする
 * （#701 issue コメント参照）。
 *
 * 検出する2パターン:
 *   1. `@supabase/...` パッケージのimport/require/動的import
 *      (例: `import { createClient } from '@supabase/supabase-js'`)
 *   2. `VITE_*SUPABASE*` という命名の環境変数文字列
 *      (ブラウザに露出するVite環境変数の命名規約。#701で削除済みのものが
 *      コピペや復元で再度紛れ込むのを防ぐ)
 *
 * 使い方:
 *   node scripts/check-analysis-browser-supabase.js
 *   npm run check:analysis-browser-supabase
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')
const ANALYSIS_SRC_DIR = path.join(REPO_ROOT, 'analysis', 'src')
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx'])

const SUPABASE_IMPORT_RE = /['"`]@supabase\//
const VITE_SUPABASE_ENV_RE = /VITE_[A-Za-z0-9_]*SUPABASE[A-Za-z0-9_]*/

/**
 * 1ファイル分のソースを走査し、違反を行番号付きで返す純粋関数 (unit test 対象)。
 * @param {string} content
 * @returns {{ line: number, kind: 'supabase-import' | 'vite-supabase-env', text: string }[]}
 */
function findViolations(content) {
  const violations = []
  const lines = content.split('\n')

  lines.forEach((lineText, index) => {
    if (SUPABASE_IMPORT_RE.test(lineText)) {
      violations.push({ line: index + 1, kind: 'supabase-import', text: lineText.trim() })
    }
    if (VITE_SUPABASE_ENV_RE.test(lineText)) {
      violations.push({ line: index + 1, kind: 'vite-supabase-env', text: lineText.trim() })
    }
  })

  return violations
}

/**
 * ディレクトリを再帰的に走査し、対象拡張子のファイルパス一覧を返す。
 * @param {string} dir
 * @returns {string[]}
 */
function listScannableFiles(dir) {
  if (!fs.existsSync(dir)) return []

  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listScannableFiles(fullPath))
    } else if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath)
    }
  }
  return results
}

function describeViolation(violation) {
  const label =
    violation.kind === 'supabase-import'
      ? '@supabaseパッケージへの直接import/require'
      : 'VITE_*SUPABASE*環境変数の参照'
  return `${label} (行${violation.line}): ${violation.text}`
}

function main() {
  const files = listScannableFiles(ANALYSIS_SRC_DIR)

  // fail-closed: analysis/src が将来リネーム/移動/削除されると listScannableFiles() が
  // 静かに空配列を返し、「0件検証してOK」という偽の緑になってガードが機能しなくなる
  // (fail-open)。0件は「本当にファイルが無い」ではなく「走査対象を見失った」ことを示す
  // シグナルとして扱い、ここで明示的に失敗させる
  if (files.length === 0) {
    console.error(
      `[check-analysis-browser-supabase] ${ANALYSIS_SRC_DIR} 配下に走査対象ファイル` +
        '(.ts/.tsx)が1件も見つかりませんでした。ディレクトリのリネーム/移動により' +
        'このガードが対象を見失っている可能性があります(fail-open防止のため意図的に失敗させています)。'
    )
    process.exit(1)
  }

  const allErrors = []

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8')
    const violations = findViolations(content)
    if (violations.length === 0) continue

    const relativePath = path.relative(REPO_ROOT, filePath)
    for (const violation of violations) {
      allErrors.push(`  - ${relativePath}: ${describeViolation(violation)}`)
    }
  }

  if (allErrors.length > 0) {
    console.error(
      'analysis/src (ブラウザ配信コード) にSupabase直接依存が見つかりました:\n'
    )
    console.error(allErrors.join('\n'))
    console.error(
      '\nブラウザ側のデータ取得は analysis/src/lib/adminApi.ts 経由の /__admin API に' +
        '一本化されています(#701)。analysis/dev/**(Node dev-server側)での利用は対象外です。' +
        '詳細: https://github.com/azumag/twica/issues/701'
    )
    process.exit(1)
  }

  console.log(`[check-analysis-browser-supabase] OK: ${files.length} 件のファイルを検証しました`)
}

if (require.main === module) {
  main()
}

module.exports = {
  findViolations,
  listScannableFiles,
}
