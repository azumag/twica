import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(
  join(repositoryRoot, '.github/workflows/notify-discord-main-merge.yml'),
  'utf8',
)

function truncateMarkdown(value: string, maxUnits: number): string {
  const script = [
    'import os, sys',
    'sys.path.insert(0, ".github/scripts")',
    'import release_summary',
    'print(release_summary.truncate_markdown_utf16(os.environ["VALUE"], int(os.environ["MAX_UNITS"])), end="")',
  ].join('\n')

  return execFileSync('python3', ['-c', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      VALUE: value,
      MAX_UNITS: String(maxUnits),
    },
  })
}

describe('Discord promotion notification length contract', () => {
  it('keeps overlong release summaries bounded by 2000 UTF-16 code units', () => {
    // Discord's content limit is enforced in UTF-16 units. Keep the source-level
    // contract pinned here so a future refactor cannot silently switch to Python
    // code-point length or remove the post-truncation fail-closed guard.
    expect(workflow).toContain('          limit = 2000')
    expect(workflow).toContain(
      '          if release_summary.utf16_length(content) > limit:',
    )
    expect(workflow).toContain(
      '              release_text = release_summary.truncate_markdown_utf16(',
    )
    expect(workflow).toContain(
      '              available = limit - release_summary.utf16_length(prefix + marker + suffix)',
    )
    expect(workflow).toContain(
      '          if release_summary.utf16_length(content) > limit:\n              raise SystemExit("Discord notification exceeds 2000 characters after trimming")',
    )
  })

  it('truncates at a complete line instead of splitting inline Markdown', () => {
    const firstLine = '1行目 😀'
    const value = [firstLine, '2行目 **強調**', '3行目'].join('\n')
    const maxUnits = `${firstLine}\n2行`.length

    expect(truncateMarkdown(value, maxUnits)).toBe(firstLine)
  })

  it('rolls back before an opening fence when the closing fence does not fit', () => {
    const value = ['intro', '```text', 'inside', '```', 'after'].join('\n')
    const maxUnits = 'intro\n```text\ninside\n'.length

    expect(truncateMarkdown(value, maxUnits)).toBe('intro')
  })
})
