import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const WORKFLOW = '.github/workflows/planetscale-migrate.yml'
const STEP_NAME = 'Apply PlanetScale migrations'

/**
 * contract migration（#1965 の DROP FUNCTION）が pending にあると、db-migrate.js の
 * 非加法ガードが apply 全体を止め、後続の additive migration も適用されなくなる。
 * その解除は workflow_dispatch の allow_non_additive input だけに限り、push では
 * 常にガードを効かせる。ここでは step の実 shell を node のスタブで実行し、
 * input の有無で db-migrate.js へ渡る引数が変わることを固定する。
 */
function extractRunBlock(src: string, stepName: string): string {
  const lines = src.split('\n')
  const stepIdx = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  if (stepIdx < 0) throw new Error(`step not found: ${stepName}`)
  const runIdx = lines.findIndex((line, i) => i > stepIdx && /^\s*run:\s*\|\s*$/.test(line))
  if (runIdx < 0) throw new Error(`run block not found for step: ${stepName}`)
  const contentIndent = lines[runIdx + 1].match(/^ */)![0].length
  const body: string[] = []
  for (const line of lines.slice(runIdx + 1)) {
    if (line.trim() !== '' && line.match(/^ */)![0].length < contentIndent) break
    body.push(line.slice(contentIndent))
  }
  return body.join('\n')
}

const workflow = readFileSync(WORKFLOW, 'utf8')
const script = extractRunBlock(workflow, STEP_NAME)
const stubDir = mkdtempSync(join(tmpdir(), 'twica-migrate-dispatch-'))
const callLog = join(stubDir, 'calls.log')
// STUB_FAIL_COMMAND に一致する db-migrate.js サブコマンドだけ失敗させる。
writeFileSync(
  join(stubDir, 'node'),
  `#!/bin/sh\necho "$*" >> "${callLog}"\n[ "$2" = "\${STUB_FAIL_COMMAND:-}" ] && exit 1\nexit 0\n`,
)
chmodSync(join(stubDir, 'node'), 0o755)

afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

function runStep(env: Record<string, string>): { status: number; calls: string[] } {
  rmSync(callLog, { force: true })
  let status = 0
  try {
    execFileSync('bash', ['-e', '-c', script], {
      // 親の環境を引き継がず、ALLOW_NON_ADDITIVE 等はケースで渡したものだけにする。
      env: { NODE_ENV: 'test', PATH: `${stubDir}:/usr/bin:/bin`, ...env },
      stdio: 'pipe',
    })
  } catch (error) {
    status = (error as { status: number }).status
  }
  let calls: string[] = []
  try {
    calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    calls = []
  }
  return { status, calls }
}

describe('planetscale-migrate non-additive dispatch', () => {
  it.each([
    ['false', { ALLOW_NON_ADDITIVE: 'false' }],
    ['空文字', { ALLOW_NON_ADDITIVE: '' }],
    ['未設定', {}],
  ])('ALLOW_NON_ADDITIVE が %s なら非加法ガードを外さない', (_label, env) => {
    expect(runStep({ GITHUB_REF: 'refs/heads/preview', ...env })).toEqual({
      status: 0,
      calls: ['scripts/db-migrate.js apply --provider=planetscale', 'scripts/db-migrate.js verify --provider=planetscale'],
    })
  })

  it('dispatch で許可したときだけ plan を出してから --allow-non-additive で apply する', () => {
    expect(runStep({ GITHUB_REF: 'refs/heads/preview', ALLOW_NON_ADDITIVE: 'true' })).toEqual({
      status: 0,
      calls: [
        'scripts/db-migrate.js plan --provider=planetscale --allow-non-additive',
        'scripts/db-migrate.js apply --provider=planetscale --allow-non-additive',
        'scripts/db-migrate.js verify --provider=planetscale',
      ],
    })
  })

  it('plan が失敗したら apply しない', () => {
    expect(
      runStep({ GITHUB_REF: 'refs/heads/preview', ALLOW_NON_ADDITIVE: 'true', STUB_FAIL_COMMAND: 'plan' }),
    ).toEqual({ status: 1, calls: ['scripts/db-migrate.js plan --provider=planetscale --allow-non-additive'] })
  })

  it('main/preview 以外の ref では許可していても db-migrate.js を起動しない', () => {
    expect(runStep({ GITHUB_REF: 'refs/heads/feature', ALLOW_NON_ADDITIVE: 'true' })).toEqual({ status: 1, calls: [] })
  })

  it('input は既定 false で、push では常に false を渡す', () => {
    expect(workflow).toMatch(/allow_non_additive:\n\s+description: .+\n\s+type: boolean\n\s+default: false/)
    expect(workflow).toContain(
      "ALLOW_NON_ADDITIVE: ${{ github.event_name == 'workflow_dispatch' && inputs.allow_non_additive && 'true' || 'false' }}",
    )
  })
})
