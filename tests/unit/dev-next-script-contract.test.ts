import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('dev:next script contract (#1672)', () => {
  it('defaults the Next.js app URL to localhost:3000 without changing the Worker dev command', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['dev:next']).toContain(
      'NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-http://localhost:3000}'
    )
    expect(packageJson.scripts['dev:next']).toContain('TURBOPACK=0 next dev')
    expect(packageJson.scripts['workers:dev']).toBe('npx wrangler dev')
  })
})
