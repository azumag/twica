import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripComments } = require('../../scripts/check-supabase-shutdown.js')

const repositoryRoot = resolve(__dirname, '../..')

/**
 * Supabase停止後の最小回帰テスト。
 *
 * 実装詳細をテスト用facadeで再現すると、削除した本番経路をテスト側だけで延命し、
 * 将来の再導入を見逃す。ここではruntime entrypointの物理削除とroot dependencyの
 * 削除を直接固定する。より広い文字列・binding・deploy path検査は
 * scripts/check-supabase-shutdown.jsをCIで実行する。
 */
describe('full Supabase shutdown runtime', () => {
  it('歴史説明の PostgREST .rpc() は除外し、実コードの Supabase client call は残す', () => {
    const source = [
      '// PostgREST .rpc() は旧経路の説明として許容する',
      '/* supabaseAdmin.from("streamers") も履歴コメントなら許容する */',
      'const endpoint = "https://example.supabase.co/rest/v1"',
      'const result = supabaseAdmin.rpc("rename_card_pack")',
    ].join('\n')

    const executableSource = stripComments(source)
    expect(executableSource).not.toMatch(/PostgREST\s*\.\s*rpc\(\)/)
    expect(executableSource).not.toMatch(/supabaseAdmin\.from/)
    expect(executableSource).toMatch(/https:\/\/example\.supabase\.co\/rest\/v1/)
    expect(executableSource).toMatch(/supabaseAdmin\.rpc/)
  })

  it.each([
    'src/lib/supabase/admin.ts',
    'src/lib/supabase/middleware.ts',
    'src/lib/supabase/retry.ts',
    'src/lib/db/flags.ts',
    'src/lib/db/target.ts',
  ])('%s は削除済みである', (relativePath) => {
    expect(existsSync(resolve(repositoryRoot, relativePath))).toBe(false)
  })

  it('root packageからSupabase SDKが削除済みである', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const packages = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }

    expect(packages).not.toHaveProperty('@supabase/ssr')
    expect(packages).not.toHaveProperty('@supabase/supabase-js')
    expect(packages).not.toHaveProperty('supabase')
  })
})
