import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('top page live-directory navigation', () => {
  it('keeps the secondary style on the /live link itself', () => {
    const home = readSource('src/app/page.tsx')
    const liveLinkMatch = home.match(/<Link\s+href="\/live"[\s\S]*?<\/Link>/)

    expect(liveLinkMatch, '/live Link should exist on the top page').not.toBeNull()
    expect(liveLinkMatch?.[0] ?? '').toContain('border-gray-600 bg-gray-800')
  })
})
