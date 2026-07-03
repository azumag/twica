#!/usr/bin/env node

/**
 * Migration order checker / マイグレーション番号の順序チェッカー (#541)
 *
 * 背景:
 * supabase/migrations 配下のファイルは `NNNNN_name.sql` という連番プレフィックスを持つ。
 * 過去のインシデント (#525-527) では、複数の PR が並行してマイグレーションを追加した際に
 * マージ順序と番号の採番順序がズレ、番号の小さいファイルが後からマージされてしまった。
 * その結果 `supabase db push` が「番号が既に適用済みの最大番号より小さい」として拒否する
 * ("out of order") か、最悪の場合コードのデプロイがスキーマ変更より先行してしまう事故が起きた。
 * (根本原因である採番プロセス自体の見直しは #536 で別途トラッキングされており、
 *  本スクリプトはあくまで機械的な順序チェックのみを担う)
 *
 * このスクリプトは2つの不変条件を検証する:
 *
 *   ルール1 (常に実行): supabase/migrations/*.sql をファイル名の昇順でソートしたとき、
 *     抽出した番号が「重複なく厳密に増加」していること。
 *     欠番 (ファイル削除・リナンバーで飛ぶ) は許容する。
 *
 *   ルール2 (git のベースブランチ参照が可能な場合のみ実行): このブランチ/PR で新規に
 *     追加されたマイグレーションファイルの番号が、ベースブランチ (デフォルト origin/main) に
 *     現時点で存在する全マイグレーションの番号より大きいこと。
 *     → 採番は早いが実装に時間がかかっている PR が、その間に別の PR が確保した
 *       (=マージされ、場合によっては本番に適用済みの) より大きい番号を、
 *       後から追い抜いて低い番号でマージしてしまう #525-527 と同型の事故を防ぐ。
 *
 * 使い方:
 *   node scripts/check-migration-order.js [--base=<git-ref>]
 *   npm run check:migration-order
 *   npm run check:migration-order -- --base=origin/preview
 *
 * --base を省略した場合は origin/main を使う。指定したベースブランチの参照が
 * ローカルに存在しない (git fetch していない等) 場合、ルール2 のチェックは
 * 警告を出してスキップされる (ルール1 は常に実行され、失敗すれば非ゼロ終了する)。
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations')
const MIGRATIONS_GIT_PATH = 'supabase/migrations'
const MIGRATION_FILENAME_RE = /^(\d+)_.+\.sql$/

/**
 * ファイル名から先頭の数値プレフィックスを抽出する純粋関数。
 * @param {string} filename
 * @returns {{ raw: string, value: number } | null} マッチしない場合は null
 */
function extractMigrationNumber(filename) {
  const match = filename.match(MIGRATION_FILENAME_RE)
  if (!match) return null
  return { raw: match[1], value: parseInt(match[1], 10) }
}

/**
 * ファイル名の昇順ソート順に、抽出した番号が「重複なく厳密に増加」しているかを検証する。
 * git やファイルシステムに依存しない純粋関数 (unit test 対象)。
 *
 * @param {string[]} filenames 検証対象のファイル名一覧 (順不同で渡してよい。内部でソートする)
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMigrationOrder(filenames) {
  const errors = []
  const sorted = [...filenames].sort()
  const parsed = []

  for (const filename of sorted) {
    const info = extractMigrationNumber(filename)
    if (!info) {
      errors.push(`不正なファイル名 (数値プレフィックスがありません): ${filename}`)
      continue
    }
    parsed.push({ filename, ...info })
  }

  const firstSeenBy = new Map()
  for (const p of parsed) {
    const existing = firstSeenBy.get(p.value)
    if (existing) {
      errors.push(`番号が重複しています (${p.raw}): ${existing} と ${p.filename}`)
    } else {
      firstSeenBy.set(p.value, p.filename)
    }
  }

  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1]
    const curr = parsed[i]
    if (curr.value < prev.value) {
      errors.push(
        `番号が逆順です: ${curr.filename} (${curr.raw}) はファイル名の並び順で ` +
          `${prev.filename} (${prev.raw}) の後に来ますが、番号がそれより小さいです`
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * `git diff --name-status` の出力 ("A\tpath" / "D\tpath" 形式、1行1エントリ) を
 * 追加/削除された .sql ファイルのベース名一覧にパースする純粋関数 (unit test 対象)。
 *
 * @param {string} nameStatusOutput
 * @returns {{ added: string[], deleted: string[] }}
 */
function parseNameStatus(nameStatusOutput) {
  const added = []
  const deleted = []
  if (!nameStatusOutput) return { added, deleted }

  for (const line of nameStatusOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const [status, ...pathParts] = trimmed.split('\t')
    const filePath = pathParts.join('\t')
    if (!filePath.endsWith('.sql')) continue

    const basename = path.basename(filePath)
    if (status.startsWith('A')) {
      added.push(basename)
    } else if (status.startsWith('D')) {
      deleted.push(basename)
    }
  }

  return { added, deleted }
}

/**
 * 追加ファイルのうち、「同じ番号のファイルが同じ diff 内で削除されている」ものを除外する
 * 純粋関数 (unit test 対象)。
 *
 * 番号を変えずにファイル名の説明部分だけ直す (誤字修正など) その場リネームは、
 * `--no-renames` 指定下では削除+追加として現れる。この場合は新しい番号を
 * 要求しているわけではないため、ルール2 (新規番号は既存最大より大きい) の対象から除外する。
 * 番号自体を変える「リナンバー」(例: 00050 → 00070) は削除側と追加側で番号が異なるため、
 * このフィルタでは除外されず、引き続きルール2 の検証対象になる。
 *
 * @param {string[]} addedFilenames
 * @param {string[]} deletedFilenames
 * @returns {string[]}
 */
function excludeSameNumberRenames(addedFilenames, deletedFilenames) {
  const deletedNumbers = new Set(
    deletedFilenames
      .map(extractMigrationNumber)
      .filter(Boolean)
      .map((info) => info.value)
  )

  return addedFilenames.filter((filename) => {
    const info = extractMigrationNumber(filename)
    if (!info) return true // 不正なファイル名は除外せず後続のチェックで検出させる
    return !deletedNumbers.has(info.value)
  })
}

/**
 * 新規追加されたマイグレーションの番号が、既存の全マイグレーション番号より大きいかを検証する
 * 純粋関数 (unit test 対象)。
 *
 * @param {string[]} existingFilenames ベースブランチに既に存在するファイル名一覧
 * @param {string[]} newFilenames このブランチ/PRで新規追加されたファイル名一覧
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateNewMigrationsAreHighest(existingFilenames, newFilenames) {
  const errors = []

  const existingNumbers = existingFilenames
    .map(extractMigrationNumber)
    .filter(Boolean)
    .map((info) => info.value)
  const maxExisting = existingNumbers.length > 0 ? Math.max(...existingNumbers) : -1

  for (const filename of newFilenames) {
    const info = extractMigrationNumber(filename)
    if (!info) {
      errors.push(`不正なファイル名 (数値プレフィックスがありません): ${filename}`)
      continue
    }
    if (info.value <= maxExisting) {
      errors.push(
        `新規マイグレーション ${filename} (${info.raw}) の番号が、ベースブランチの最大番号 ` +
          `(${maxExisting}) 以下です。他の PR が先にマージされ、その番号を既に確保している可能性が` +
          'あります。番号を採番し直してください。'
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

/** 現在のファイルシステム上の supabase/migrations/*.sql 一覧を返す。 */
function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
}

function runGit(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/** git コマンドの出力 (改行区切りのパス) を .sql ファイルのベース名一覧に変換する。 */
function toSqlBasenames(gitOutput) {
  if (!gitOutput) return []
  return gitOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'))
    .map((line) => path.basename(line))
}

function getBaseArg(argv) {
  const arg = argv.find((a) => a.startsWith('--base='))
  return arg ? arg.slice('--base='.length) : 'origin/main'
}

function main() {
  const baseRef = getBaseArg(process.argv.slice(2))
  const allErrors = []

  // ルール1: ファイル名順に番号が重複なく厳密に増加しているか (常に実行)
  const filenames = listMigrationFiles()
  const orderResult = validateMigrationOrder(filenames)
  allErrors.push(...orderResult.errors)

  // ルール2: 新規追加分の番号がベースブランチの既存最大番号より大きいか (git が使える場合のみ)
  //
  // まずベースブランチの参照可否だけを確認する。ここで失敗するのはローカルで
  // git fetch していない等の「想定内」のケースなので、警告を出してルール2 全体を
  // スキップするだけに留める。一方、ベースブランチが解決できたにもかかわらず
  // 後続の ls-tree / diff が失敗する場合は想定外のエラーなので、握りつぶさずに
  // 例外として伝播させ、CI を確実に失敗させる (silent green を防ぐ)。
  let rule2Skipped = false
  try {
    runGit(['rev-parse', '--verify', baseRef])
  } catch (err) {
    rule2Skipped = true
    const message = err && err.message ? err.message.split('\n')[0] : String(err)
    console.warn(
      `[check-migration-order] 警告: ベースブランチ "${baseRef}" を参照できないため、` +
        `新規マイグレーション番号の比較チェック (ルール2) をスキップしました (${message})`
    )
  }

  if (!rule2Skipped) {
    const existingOutput = runGit(['ls-tree', '-r', '--name-only', baseRef, '--', MIGRATIONS_GIT_PATH])
    const existingFilenames = toSqlBasenames(existingOutput)

    const diffOutput = runGit([
      'diff',
      '--no-renames',
      '--diff-filter=AD',
      '--name-status',
      `${baseRef}...HEAD`,
      '--',
      MIGRATIONS_GIT_PATH,
    ])
    const { added, deleted } = parseNameStatus(diffOutput)
    // 番号を変えずにファイル名だけ変えた「その場リネーム」は新規の番号取得とみなさない
    const newFilenames = excludeSameNumberRenames(added, deleted)

    const newHighestResult = validateNewMigrationsAreHighest(existingFilenames, newFilenames)
    allErrors.push(...newHighestResult.errors)
  }

  if (allErrors.length > 0) {
    console.error('マイグレーション番号のチェックに失敗しました:\n')
    for (const error of allErrors) {
      console.error(`  - ${error}`)
    }
    console.error(
      '\nsupabase/migrations/*.sql は NNNNN_name.sql の連番で、重複なく厳密に増加している必要があります。' +
        '新規ファイルの番号は、マージ先ブランチに既にある全マイグレーションより大きい番号を採番してください。'
    )
    process.exit(1)
  }

  console.log(
    `[check-migration-order] OK: ${filenames.length} 件のマイグレーションを検証しました` +
      (rule2Skipped ? ' (ルール2 はスキップ)' : '')
  )
}

if (require.main === module) {
  main()
}

module.exports = {
  extractMigrationNumber,
  validateMigrationOrder,
  validateNewMigrationsAreHighest,
  parseNameStatus,
  excludeSameNumberRenames,
}
