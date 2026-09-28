#!/usr/bin/env node

/**
 * Vitest runner for `npm run test:agent` / `npm run test:cleanup` (#1677)
 *
 * 背景:
 * 以前の `test:cleanup` は `pkill -9 -f vitest` だった。これはプロセスの所有元や
 * 作業ディレクトリを区別しないため、同一ユーザーで並行実行している別 repository /
 * 別 worktree / 別エージェントセッションの Vitest まで SIGKILL し得た。
 *
 * 方針（プロセス管理の定石: 自分が作ったプロセスグループだけを管理する）:
 *   1. Vitest を `detached: true` で起動し、新しいプロセスグループ（POSIX では setsid による
 *      新セッション）のリーダーにする。forks プールのワーカーも同じグループに属するため、
 *      `process.kill(-pgid, sig)` でこの実行が作ったプロセスだけをまとめて扱える。
 *      コマンド文字列マッチ（pkill -f）は採用しない。Vitest は process.title を
 *      `node (vitest)` / `node (vitest N)` に書き換えるため ps 上にパスが残らず、worktree を区別できないことを
 *      実測で確認している。pgid は OS が割り当てた「この実行固有」の識別子なので誤爆しない。
 *   2. 起動した pgid と、そのリーダーの起動時刻を この worktree の `node_modules/.cache/` 配下に
 *      記録する。ラッパー自身が SIGKILL 等で異常終了して記録が残った場合だけ、次回の開始前
 *      （または `--cleanup`）にそのグループを終了する。記録したラッパーが生きている間は
 *      「実行中」とみなして触らない（同じ worktree で並行実行した test:agent を巻き込まない）。
 *      既知の制限: 記録は node_modules 配下なので `npm ci` をまたいだ残留は回収できない。
 *   3. PID 再利用対策: 終了させる前に、pid == pgid のプロセスの起動時刻が記録と一致するかを
 *      `ps -o lstart=` で確認する。リーダーが既に居ないのにグループが生きている場合は、POSIX が
 *      「同じ ID のプロセスグループが存在する間はその PID を再利用しない」ことを保証するため、
 *      残っているのは当時のワーカーと判断できる。一致しなければ何もしない
 *      （無関係なプロセスを殺すより、残留を見逃す方を安全側とする）。
 *   4. 終了は SIGTERM → 猶予 → それでも残る場合のみ SIGKILL の段階的終了にする。
 *      Vitest が正常終了してグループに生存メンバー（ゾンビ以外）が居なければ、シグナルは一切送らない。
 *
 * 対象 OS: macOS / Linux（`ps -o lstart= -p` / `ps -A -o pgid=,stat=` と負の PID への kill は両方で動作）。
 * Windows はプロセスグループへの kill をサポートしないため対象外（旧 pkill 版も同様に非対応）。
 *
 * 使い方:
 *   node scripts/vitest-agent.mjs [vitest args...]   # 残留掃除 → vitest 実行 → 残留掃除
 *   node scripts/vitest-agent.mjs --cleanup          # 残留掃除のみ
 */

import { spawn, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** SIGTERM 後に SIGKILL へ切り替えるまでの猶予。ここに来るのは「Vitest 本体が既に終了したのに
 * 残ったプロセス」か「前回の異常終了の残留」なので、テスト本体の teardown を待つ必要はない。 */
const TERM_GRACE_MS = 3000
const POLL_INTERVAL_MS = 100

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** kill(pid, 0) による生存確認（記録したラッパーが生きているかの判定に使う）。 */
function exists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM は「存在するが別ユーザー所有」。掃除しない側に倒すため生存扱いにする。
    return error.code === 'EPERM'
  }
}

/**
 * グループにゾンビ以外のメンバーが居るか。`kill(-pgid, 0)` はゾンビだけのグループでも成功し、
 * 親（PID 1）の回収が遅い環境（コンテナ等）では Vitest 終了後も esbuild / vitest のゾンビが
 * 数秒残ることを実測している。ゾンビにはシグナルが効かず掃除も不要なので、ps の STAT が
 * `Z` で始まるものを除外して判定する。psOutput はテスト用の差し替え口。
 */
export function hasLiveMembers(pgid, psOutput = readProcessGroups()) {
  // ps が使えない環境（procps の無い slim コンテナ等）では kill(-pgid, 0) に縮退する。
  // ゾンビを生存扱いする分だけ終了待ちが長くなり得るが、テスト結果や終了コードは失わない。
  if (psOutput === null) {
    try {
      process.kill(-pgid, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }
  return psOutput.split('\n').some((line) => {
    const [group, stat] = line.trim().split(/\s+/)
    return Number(group) === pgid && stat !== undefined && !stat.startsWith('Z')
  })
}

function readProcessGroups() {
  try {
    return execFileSync('ps', ['-A', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** プロセスの起動時刻（秒精度の文字列）。存在しなければ null。
 * 記録時と照合時で表記が揺れないよう、ロケールは LC_ALL=C、タイムゾーンは TZ=UTC に固定する。 */
export function readStartTime(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    // ps は該当 PID が無いと非ゼロ終了する
    return null
  }
}

/** 記録したグループが今も「当時起動したもの」か（PID 再利用されていないか）を判定する。 */
export function isOwnedGroup({ pgid, startTime }) {
  if (!Number.isInteger(pgid) || pgid <= 1 || !hasLiveMembers(pgid)) return false
  const leaderStart = readStartTime(pgid)
  // リーダー不在でグループが生存 = 当時のワーカーの残留（POSIX はグループ存続中の PID 再利用を禁止）
  if (leaderStart === null) return true
  return leaderStart === startTime
}

/** SIGTERM → 猶予 → 残っていれば SIGKILL。送ったシグナルを返す（テストと診断用）。 */
export async function terminateGroup(pgid, { graceMs = TERM_GRACE_MS, log = console.error } = {}) {
  const sent = []
  const send = (signal) => {
    try {
      process.kill(-pgid, signal)
      sent.push(signal)
      return true
    } catch {
      return false // 既に全員終了済み
    }
  }
  if (!hasLiveMembers(pgid) || !send('SIGTERM')) return sent
  for (let waited = 0; waited < graceMs; waited += POLL_INTERVAL_MS) {
    await sleep(POLL_INTERVAL_MS)
    if (!hasLiveMembers(pgid)) return sent
  }
  log(`[vitest-agent] process group ${pgid} ignored SIGTERM for ${graceMs}ms; sending SIGKILL`)
  send('SIGKILL')
  return sent
}

/**
 * 記録済みグループのうち「記録したラッパーが既に死んでいる」ものだけを終了する。
 * 戻り値は終了処理した pgid の一覧。
 */
export async function cleanupStale({ stateDir, graceMs = TERM_GRACE_MS, log = console.error }) {
  let names
  try {
    names = readdirSync(stateDir).filter((name) => name.endsWith('.json'))
  } catch {
    return [] // 記録ディレクトリが無い = 残留なし
  }
  const cleaned = []
  for (const name of names) {
    const file = join(stateDir, name)
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      rmSync(file, { force: true }) // 書き込み途中で落ちた等の壊れた記録は捨てる
      continue
    }
    // 記録したラッパーが生きている = 並行実行中の test:agent。触らない。
    // （PID 再利用で無関係なプロセスが生きている場合も「掃除しない」側に倒れるので安全）
    if (Number.isInteger(record.wrapperPid) && exists(record.wrapperPid)) continue
    if (isOwnedGroup(record)) {
      log(`[vitest-agent] terminating leftover Vitest process group ${record.pgid}`)
      await terminateGroup(record.pgid, { graceMs, log })
      cleaned.push(record.pgid)
    }
    rmSync(file, { force: true })
  }
  return cleaned
}

function resolvePaths() {
  const require = createRequire(join(repoRoot, 'package.json'))
  const vitestPkgPath = require.resolve('vitest/package.json')
  const vitestBin = JSON.parse(readFileSync(vitestPkgPath, 'utf8')).bin.vitest
  return {
    vitestEntry: resolve(dirname(vitestPkgPath), vitestBin),
    // worktree ごとに独立させるため、この checkout の node_modules 配下（gitignore 済み）に置く
    stateDir: join(repoRoot, 'node_modules', '.cache', 'twica-vitest-agent'),
  }
}

async function main(argv) {
  const { vitestEntry, stateDir } = resolvePaths()

  await cleanupStale({ stateDir })
  if (argv[0] === '--cleanup') return 0

  // シグナルハンドラは spawn より前に登録する。Vitest は別セッションにいるため端末の Ctrl+C は
  // 届かず、ハンドラ登録前（spawn 直後の ps / 記録書き込み中）にラッパーが既定動作で即死すると、
  // 記録の無い孤児グループが残って次回の cleanup でも回収できない（レビューで実測済み）。
  // pgid 確定前に届いたシグナルは保留し、確定直後に転送する。
  // なお SIGKILL だけは捕捉できないため、spawn から記録書き込みまでの数十 ms に
  // ラッパーが SIGKILL された場合の孤児は防げない（残余リスクとして許容）。
  let pgid
  const pending = []
  const forward = (signal) => {
    if (pgid === undefined) {
      pending.push(signal)
      return
    }
    try {
      process.kill(-pgid, signal)
    } catch {
      // 既に終了済み
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward)

  // npx / .bin シムを経由せず node で直接起動し、pgid == この子プロセスの PID にする。
  const child = spawn(process.execPath, [vitestEntry, ...argv], {
    stdio: 'inherit',
    detached: true,
  })
  if (child.pid === undefined) {
    // spawn 失敗（'error' イベントで通知される）。グループは作られていない。
    return await new Promise((r) =>
      child.once('error', (error) => {
        console.error(`[vitest-agent] failed to start Vitest: ${error.message}`)
        r(1)
      }),
    )
  }
  pgid = child.pid
  const recordFile = join(stateDir, `${pgid}.json`)
  mkdirSync(stateDir, { recursive: true })
  // 並行する cleanup が書き込み途中の空ファイルを「壊れた記録」として消さないよう、
  // 一時ファイルに書いてから rename で原子的に公開する（cleanup は *.json だけを読む）。
  writeFileSync(
    `${recordFile}.tmp`,
    JSON.stringify({ pgid, wrapperPid: process.pid, startTime: readStartTime(pgid) }),
  )
  renameSync(`${recordFile}.tmp`, recordFile)
  for (const signal of pending.splice(0)) forward(signal)

  const exitCode = await new Promise((r) =>
    child.once('exit', (code, signal) =>
      // シグナル終了はシェル慣習どおり 128 + シグナル番号を返す
      r(code ?? 128 + (osConstants.signals[signal] ?? 0)),
    ),
  )

  // Vitest 本体の終了後もグループ内に残ったワーカー等だけを段階的に終了する（空なら何も送らない）。
  await terminateGroup(pgid)
  rmSync(recordFile, { force: true })
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
