// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupStale,
  hasLiveMembers,
  isOwnedGroup,
  readStartTime,
  terminateGroup,
} from '../../scripts/vitest-agent.mjs'

/**
 * #1677: test:cleanup が「この worktree の test:agent が起動したプロセスグループ」だけを
 * 終了し、同一ユーザーの別 repository / 別 worktree の Vitest を巻き込まないことを、
 * 実プロセス（detached で作った独立グループ）を使って回帰確認する。
 * プロセスグループへの kill は POSIX 前提のため Windows ではスキップする。
 */
const posix = process.platform !== 'win32'

// 引数付きの常駐 node プロセスを独立したプロセスグループのリーダーとして起動する。
// ignoreTerm=true のときは SIGTERM を無視し、段階的終了の SIGKILL 経路を検証する。
// 子はハンドラ登録後に stdout へ ready を書くので、固定時間待ちに頼らず登録完了を待てる。
function spawnGroup({ ignoreTerm = false } = {}): ChildProcess {
  const code = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.write('ready'); setInterval(() => {}, 1000)`
  return spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pgid: number, timeoutMs = 3000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (!groupAlive(pgid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !groupAlive(pgid)
}

// 終了済みで PID が空いている（= 死んだラッパー役に使える）PID を得る
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => child.once('exit', r))
  return child.pid!
}

describe.skipIf(!posix)('scripts/vitest-agent.mjs (#1677)', () => {
  let stateDir: string
  const groups: ChildProcess[] = []

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'vitest-agent-test-'))
  })

  afterEach(() => {
    // テストが途中で失敗してもプロセスを残さない
    for (const child of groups.splice(0)) {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // 終了済み
      }
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function startGroup(options?: { ignoreTerm?: boolean }): Promise<number> {
    const child = spawnGroup(options)
    groups.push(child)
    await once(child.stdout!, 'data')
    return child.pid!
  }

  function record(pgid: number, fields: Record<string, unknown>) {
    writeFileSync(join(stateDir, `${pgid}.json`), JSON.stringify({ pgid, ...fields }))
  }

  it('ラッパーが死んだ記録済みグループだけを終了し、記録のない別 worktree 相当のグループは残す', async () => {
    const leftover = await startGroup()
    const unrelated = await startGroup() // 別 repository / 別 worktree の Vitest に相当（記録なし）
    record(leftover, { wrapperPid: await deadPid(), startTime: readStartTime(leftover) })

    const cleaned = await cleanupStale({ stateDir, log: () => {} })

    expect(cleaned).toEqual([leftover])
    expect(await waitUntilDead(leftover)).toBe(true)
    expect(groupAlive(unrelated)).toBe(true)
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('記録したラッパーが生存中（並行実行中の test:agent）なら触らず、記録も残す', async () => {
    const running = await startGroup()
    record(running, { wrapperPid: process.pid, startTime: readStartTime(running) })

    expect(await cleanupStale({ stateDir, log: () => {} })).toEqual([])
    expect(groupAlive(running)).toBe(true)
    expect(readdirSync(stateDir)).toEqual([`${running}.json`])
  })

  it('リーダーの起動時刻が記録と異なる（PID 再利用）グループは終了せず、記録だけ捨てる', async () => {
    const reused = await startGroup()
    record(reused, { wrapperPid: await deadPid(), startTime: 'Thu Jan  1 00:00:00 1970' })

    expect(isOwnedGroup({ pgid: reused, startTime: 'Thu Jan  1 00:00:00 1970' })).toBe(false)
    expect(await cleanupStale({ stateDir, log: () => {} })).toEqual([])
    expect(groupAlive(reused)).toBe(true)
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('壊れた記録や不正な pgid では何も終了しない', async () => {
    writeFileSync(join(stateDir, 'broken.json'), '{')
    record(1, { wrapperPid: await deadPid(), startTime: null })

    expect(await cleanupStale({ stateDir, log: () => {} })).toEqual([])
    expect(readdirSync(stateDir)).toEqual([])
  })

  it('SIGTERM で終わるグループには SIGKILL を送らない', async () => {
    const pgid = await startGroup()
    expect(await terminateGroup(pgid, { graceMs: 2000, log: () => {} })).toEqual(['SIGTERM'])
    expect(await waitUntilDead(pgid)).toBe(true)
  })

  it('SIGTERM を無視するグループには猶予後にだけ SIGKILL を送る', async () => {
    const pgid = await startGroup({ ignoreTerm: true })
    const logs: string[] = []
    expect(await terminateGroup(pgid, { graceMs: 300, log: (m: string) => logs.push(m) })).toEqual([
      'SIGTERM',
      'SIGKILL',
    ])
    expect(await waitUntilDead(pgid)).toBe(true)
    expect(logs.join('\n')).toContain('sending SIGKILL')
  })

  it('空のグループにはシグナルを送らない（正常終了時の不要な kill を防ぐ）', async () => {
    const pgid = await deadPid()
    expect(await terminateGroup(pgid, { log: () => {} })).toEqual([])
  })

  it('ゾンビだけが残るグループは生存メンバーなしと判定する（PID 1 の回収待ちで待たない）', () => {
    const ps = ['  100 Z', '  100 Z+', '  200 S', '  300 R+', ''].join('\n')
    expect(hasLiveMembers(100, ps)).toBe(false)
    expect(hasLiveMembers(200, ps)).toBe(true)
    expect(hasLiveMembers(300, ps)).toBe(true)
    expect(hasLiveMembers(400, ps)).toBe(false)
  })

  it('ps が使えない環境では kill(-pgid, 0) に縮退して判定する', async () => {
    const pgid = await startGroup()
    expect(hasLiveMembers(pgid, null)).toBe(true)
    expect(hasLiveMembers(await deadPid(), null)).toBe(false)
  })

  it('package.json の test:agent / test:cleanup は広域 pkill を使わずラッパー経由で実行する', () => {
    const { scripts } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(scripts['test:cleanup']).toMatch(/^node scripts\/vitest-agent\.mjs /)
    expect(scripts['test:agent']).toMatch(/^node scripts\/vitest-agent\.mjs /)
    expect(Object.values(scripts).join('\n')).not.toMatch(/pkill/)
  })
})
