#!/usr/bin/env node

/**
 * analysis Supabase 直接依存の再導入防止チェッカー (#701, #708 CI guard)
 *
 * 背景:
 * #701でブラウザ側を `/__admin` API に一本化し、#708でNode dev-server側も
 * postgres.js専用にした。以後は `analysis/src/**` と `analysis/dev/**` の
 * どちらにもSupabase SDKや資格情報を戻してはならない。
 *
 * 検出する2パターン:
 *   1. `@supabase/...` パッケージのimport/require/動的import
 *      (例: `import { createClient } from '@supabase/supabase-js'`)
 *   2. `*SUPABASE*` という命名の環境変数文字列
 *      (ブラウザ用Vite変数とNode側service-role変数の双方を対象にする)
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
const ANALYSIS_DIR = path.join(REPO_ROOT, 'analysis')
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx'])

const SUPABASE_IMPORT_RE = /['"`]@supabase\//
const SUPABASE_ENV_RE = /[A-Za-z0-9_]*SUPABASE[A-Za-z0-9_]*/

/**
 * 1ファイル分のソースを走査し、違反を行番号付きで返す純粋関数 (unit test 対象)。
 * @param {string} content
 * @returns {{ line: number, kind: 'supabase-import' | 'supabase-env', text: string }[]}
 */
function findViolations(content) {
  const violations = []
  const lines = content.split('\n')

  lines.forEach((lineText, index) => {
    if (SUPABASE_IMPORT_RE.test(lineText)) {
      violations.push({ line: index + 1, kind: 'supabase-import', text: lineText.trim() })
    }
    if (SUPABASE_ENV_RE.test(lineText)) {
      violations.push({ line: index + 1, kind: 'supabase-env', text: lineText.trim() })
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
      : '*SUPABASE*環境変数の参照'
  return `${label} (行${violation.line}): ${violation.text}`
}

function main() {
  const files = [
    ...listScannableFiles(path.join(ANALYSIS_DIR, 'src')),
    ...listScannableFiles(path.join(ANALYSIS_DIR, 'dev')),
  ]

  // fail-closed: analysis/src が将来リネーム/移動/削除されると listScannableFiles() が
  // 静かに空配列を返し、「0件検証してOK」という偽の緑になってガードが機能しなくなる
  // (fail-open)。0件は「本当にファイルが無い」ではなく「走査対象を見失った」ことを示す
  // シグナルとして扱い、ここで明示的に失敗させる
  if (files.length === 0) {
    console.error(
      `[check-analysis-browser-supabase] ${ANALYSIS_DIR} 配下に走査対象ファイル` +
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
      'analysis/src または analysis/dev にSupabase直接依存が見つかりました:\n'
    )
    console.error(allErrors.join('\n'))
    console.error(
      '\nブラウザ側は /__admin API、Node dev-server側はpostgres.jsへ一本化されています。' +
        '詳細: https://github.com/azumag/twica/issues/708'
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
