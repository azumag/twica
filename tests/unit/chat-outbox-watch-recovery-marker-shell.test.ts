import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WORKFLOW = '.github/workflows/chat-outbox-watch.yml'
const STEP_NAME = 'Notify Discord and conclude the run'

/**
 * `.github/workflows/chat-outbox-watch.yml` の recovery marker 書き込みは
 * `python3 - <<'PY'` の heredoc で埋め込んでいる。#1886 のレビューで、heredoc 本体と
 * 終端 `PY` が YAML run block の基準より 4 spaces 深いまま残り、YAML の dedent 後も
 * 字下げが残って shell が終端を認識せず、Notify step 全体が構文エラーになった。
 *
 * actionlint (CI) はこの class を検出できるが、抽出した実 shell を直接 `bash -n` に
 * かける回帰を置き、YAML 側の再発を CI より手前で固定する。
 */
function extractRunBlock(src: string, stepName: string): string {
  const lines = src.split('\n')
  const stepIdx = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  if (stepIdx < 0) throw new Error(`step not found: ${stepName}`)

  let runIdx = -1
  for (let i = stepIdx + 1; i < lines.length; i += 1) {
    if (/^\s*- name:/.test(lines[i])) break
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) {
      runIdx = i
      break
    }
  }
  if (runIdx < 0) throw new Error(`run block not found for step: ${stepName}`)

  // YAML block scalar の dedent 量は最初の非空行の字下げで決まる（+2 固定ではない）。
  let contentIndent = -1
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    contentIndent = lines[i].match(/^ */)![0].length
    break
  }
  if (contentIndent < 0) throw new Error('empty run block')

  const body: string[] = []
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.match(/^ */)![0].length < contentIndent) break
    body.push(line.slice(contentIndent))
  }
  return body.join('\n')
}

function extractHeredoc(script: string, marker: string): string {
  const lines = script.split('\n')
  const start = lines.findIndex((line) => line.includes(`<<'${marker}'`))
  if (start < 0) throw new Error(`heredoc not found: ${marker}`)
  const end = lines.indexOf(marker, start + 1)
  if (end < 0) throw new Error(`unterminated heredoc: ${marker}`)
  return lines.slice(start + 1, end).join('\n')
}

describe('chat-outbox-watch recovery marker shell (#1886)', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const script = extractRunBlock(workflow, STEP_NAME)

  it('run block が抽出できる', () => {
    expect(script).toContain('chat-outbox-watch/recovered')
  })

  it('抽出した実 shell が bash -n を通る', () => {
    expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow()
  })

  it('heredoc の終端 PY が行頭にあり、shell が終端を認識する', () => {
    const lines = script.split('\n')
    const start = lines.findIndex((line) => line.includes("<<'PY'"))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(lines.indexOf('PY', start + 1)).toBeGreaterThan(start)
  })

  it('埋め込んだ Python が構文として妥当', () => {
    const python = extractHeredoc(script, 'PY')
    expect(python).toContain('chat-outbox-watch/recovered')
    expect(() =>
      execFileSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: python }),
    ).not.toThrow()
  })
})
