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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const posix = process.platform !== 'win32'
const wrapperSource = resolve(process.cwd(), 'scripts/vitest-agent.mjs')
const roots: string[] = []
const wrappers: ChildProcess[] = []

function createFixture(vitestSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'vitest-agent-main-'))
  roots.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
  copyFileSync(wrapperSource, join(root, 'scripts', 'vitest-agent.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'vitest-agent-fixture', private: true }))
  writeFileSync(
    join(root, 'node_modules', 'vitest', 'package.json'),
    JSON.stringify({ name: 'vitest', version: '0.0.0', bin: { vitest: 'bin.mjs' } }),
  )
  writeFileSync(join(root, 'node_modules', 'vitest', 'bin.mjs'), vitestSource)
  return root
}

function startWrapper(root: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, [join(root, 'scripts', 'vitest-agent.mjs'), ...args], {
    cwd: root,
    stdio: 'ignore',
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
    if (!name.endsWith('.json')) continue
    try {
      const { pgid } = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as { pgid?: number }
      if (Number.isInteger(pgid) && pgid! > 1) process.kill(-pgid!, 'SIGKILL')
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

  it('ラッパーへの SIGTERM を fake Vitest へ転送し、その終了コードと記録削除を維持する', async () => {
    const root = createFixture(`
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => process.exit(42))
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`)
    const readyFile = join(root, 'ready')
    const wrapper = startWrapper(root, [readyFile])
    const exit = once(wrapper, 'exit')

    await waitForFile(readyFile)
    expect(wrapper.kill('SIGTERM')).toBe(true)
    const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null]

    expect({ code, signal }).toEqual({ code: 42, signal: null })
    expect(readdirSync(join(root, 'node_modules', '.cache', 'twica-vitest-agent'))).toEqual([])
  })
})
