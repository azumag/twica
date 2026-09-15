import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(
  join(repositoryRoot, '.github/workflows/notify-discord-main-merge.yml'),
  'utf8',
)

describe('Discord promotion notification length contract', () => {
  it('keeps overlong release summaries bounded by 2000 UTF-16 code units', () => {
    // Discord's content limit is enforced in UTF-16 units. Keep the source-level
    // contract pinned here so a future refactor cannot silently switch to Python
    // code-point length or remove the post-truncation fail-closed guard.
    expect(workflow).toContain('          limit = 2000')
    expect(workflow).toContain('          def discord_length(value):')
    expect(workflow).toContain(
      '              return len(value.encode("utf-16-le")) // 2',
    )
    expect(workflow).toContain('          def truncate_utf16(value, max_units):')
    expect(workflow).toContain(
      '                  units = len(char.encode("utf-16-le")) // 2',
    )
    expect(workflow).toContain(
      '              available = limit - discord_length(prefix + marker + suffix)',
    )
    expect(workflow).toContain(
      '              release_text = truncate_utf16(release_text, max(0, available)).rstrip()',
    )
    expect(workflow).toContain(
      '          if discord_length(content) > limit:\n              raise SystemExit("Discord notification exceeds 2000 characters after trimming")',
    )
  })
})
