import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const posix = process.platform !== 'win32'
const wrapperSource = resolve(process.cwd(), 'scripts/vitest-agent.mjs')
const roots: string[] = []
const wrappers: ChildProcess[] = []

/** 停止・再開の観測に使うハートビートの追記間隔。 */
const HEARTBEAT_INTERVAL_MS = 20
/** 「進捗が止まった」と断定するために観測する無進捗ウィンドウ。ハートビート間隔の 20 倍を取り、
 *  高負荷な CI ランナーで実行中プロセスを停止と誤認しないようにする。間隔側だけを変えても
 *  比が崩れないよう、間隔の定数から導出する。 */
const FROZEN_WINDOW_MS = HEARTBEAT_INTERVAL_MS * 20
const HEARTBEAT_ENV = 'VITEST_AGENT_HEARTBEAT'

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/**
 * プロセスの「実行が進んでいるか」を ps に依存せず観測するための preload。
 * NODE_OPTIONS の --require はラッパーが spawn する fake Vitest にもそのまま継承されるため、
 * 1 か所の指定でラッパーと fake Vitest の両方に効く。各プロセスは自身の PID を名前に含む
 * ファイルへ一定間隔で 1 バイト追記する。SIGSTOP されると user 空間のタイマーも止まるので、
 * 「ファイルサイズの増加が止まる = 実際に停止している」「増加が再開する = 再開している」を
 * 直接観測できる。ps -o stat= による状態フラグは、サンドボックス化された実行環境では
 * /bin/ps の exec が EPERM となり取得できない（実行中でも stat=null になる）ため使わない。
 * unref しているためイベントループを延命せず、ラッパー本来の終了挙動を変えない。
 */
function writeHeartbeatPreload(root: string): void {
  writeFileSync(
    join(root, 'heartbeat-preload.cjs'),
    [
      `const { appendFileSync } = require('node:fs')`,
      `const base = process.env.${HEARTBEAT_ENV}`,
      `if (base) {`,
      `  setInterval(() => {`,
      `    try { appendFileSync(base + '.' + process.pid, 'h') } catch {}`,
      `  }, ${HEARTBEAT_INTERVAL_MS}).unref()`,
      `}`,
      '',
    ].join('\n'),
  )
}

function heartbeatFile(root: string, pid: number): string {
  return join(root, `heartbeat.${pid}`)
}

function heartbeatSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

async function waitForHeartbeat(file: string, timeoutMs = 3000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (heartbeatSize(file) > 0) return
    await delay(25)
  }
  throw new Error(`timed out waiting for heartbeat ${file}`)
}

/** 無進捗ウィンドウを観測して「user 空間の実行が止まった」ことを確認する。 */
async function waitForHeartbeatFrozen(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const before = heartbeatSize(file)
    await delay(FROZEN_WINDOW_MS)
    if (heartbeatSize(file) === before) return
  }
  throw new Error(
    `timed out waiting for heartbeat to freeze: ${file} (size=${heartbeatSize(file)})`,
  )
}

/** 停止したプロセスが再開して実行を再開したことを確認する。 */
async function waitForHeartbeatGrowth(file: string, timeoutMs = 3000): Promise<void> {
  const before = heartbeatSize(file)
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (heartbeatSize(file) > before) return
    await delay(25)
  }
  throw new Error(
    `timed out waiting for heartbeat to grow: ${file} (size=${heartbeatSize(file)})`,
  )
}

function createFixture(vitestSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'vitest-agent-main-'))
  roots.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
  copyFileSync(wrapperSource, join(root, 'scripts', 'vitest-agent.mjs'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'vitest-agent-fixture', private: true }),
  )
  writeFileSync(
    join(root, 'node_modules', 'vitest', 'package.json'),
    JSON.stringify({ name: 'vitest', version: '0.0.0', bin: { vitest: 'bin.mjs' } }),
  )
  writeFileSync(join(root, 'node_modules', 'vitest', 'bin.mjs'), vitestSource)
  writeHeartbeatPreload(root)
  return root
}

function startWrapper(root: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, [join(root, 'scripts', 'vitest-agent.mjs'), ...args], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${join(root, 'heartbeat-preload.cjs')}`]
        .filter(Boolean)
        .join(' '),
      [HEARTBEAT_ENV]: join(root, 'heartbeat'),
    },
  })
  wrappers.push(child)
  return child
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (existsSync(path)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  throw new Error(`timed out waiting for ${path}`)
}

function killRecordedGroups(root: string) {
  const stateDir = join(root, 'node_modules', '.cache', 'twica-vitest-agent')
  if (!existsSync(stateDir)) return
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith('.json') && !name.endsWith('.json.tmp')) continue
    try {
      const { pgid } = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as { pgid?: number }
      if (typeof pgid === 'number' && Number.isInteger(pgid) && pgid > 1) {
        process.kill(-pgid, 'SIGKILL')
      }
    } catch {
      // The fixture may already have exited or removed its state file.
    }
  }
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) {
    killRecordedGroups(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(!posix)('vitest-agent main integration (#1695)', () => {
  it('fake Vitest の終了コードを返し、所有記録を削除する', async () => {
    const root = createFixture(`process.exit(Number(process.argv[2] ?? '0'))\n`)
    const wrapper = startWrapper(root, ['7'])
    const [code, signal] = (await once(wrapper, 'exit')) as [number | null, NodeJS.Signals | null]

    expect({ code, signal }).toEqual({ code: 7, signal: null })
    expect(readdirSync(join(root, 'node_modules', '.cache', 'twica-vitest-agent'))).toEqual([])
  })

  it('SIGTSTP でラッパーと fake Vitest を停止し、SIGCONT で両方を再開する', async () => {
    const root = createFixture(`
import { writeFileSync } from 'node:fs'
process.on('SIGINT', () => process.exit(43))
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`)
    const readyFile = join(root, 'job-control-ready')
    const wrapper = startWrapper(root, [readyFile])
    const exit = once(wrapper, 'exit')

    await waitForFile(readyFile)
    const vitestPid = Number(readFileSync(readyFile, 'utf8'))
    expect(Number.isInteger(vitestPid)).toBe(true)

    // 停止の観測は ps の状態フラグ（-o stat=）ではなく、両プロセスが実際に実行を進めて
    // いるか（ハートビートの進捗）で行う。ラッパー自身も SIGSTOP で停止するため、
    // 「停止した / 再開した」を両プロセスについて直接確認できる。
    const wrapperHeartbeat = heartbeatFile(root, wrapper.pid!)
    const vitestHeartbeat = heartbeatFile(root, vitestPid)
    await waitForHeartbeat(wrapperHeartbeat)
    await waitForHeartbeat(vitestHeartbeat)

    expect(wrapper.kill('SIGTSTP')).toBe(true)
    await waitForHeartbeatFrozen(wrapperHeartbeat)
    await waitForHeartbeatFrozen(vitestHeartbeat)

    expect(wrapper.kill('SIGCONT')).toBe(true)
    await waitForHeartbeatGrowth(wrapperHeartbeat)
    await waitForHeartbeatGrowth(vitestHeartbeat)

    expect(wrapper.kill('SIGINT')).toBe(true)
    const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null]
    expect({ code, signal }).toEqual({ code: 43, signal: null })
    expect(readdirSync(join(root, 'node_modules', '.cache', 'twica-vitest-agent'))).toEqual([])
  })

  it('ラッパーへの SIGINT を fake Vitest へ転送し、その終了コードと記録削除を維持する', async () => {
    const root = createFixture(`
import { writeFileSync } from 'node:fs'
process.on('SIGINT', () => process.exit(42))
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`)
    const readyFile = join(root, 'ready')
    const wrapper = startWrapper(root, [readyFile])
    const exit = once(wrapper, 'exit')

    await waitForFile(readyFile)
    expect(wrapper.kill('SIGINT')).toBe(true)
    const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null]

    expect({ code, signal }).toEqual({ code: 42, signal: null })
    expect(readdirSync(join(root, 'node_modules', '.cache', 'twica-vitest-agent'))).toEqual([])
  })
})
