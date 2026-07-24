import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const {
  REQUIRED_AUX_WORKER_ARTIFACTS,
  REQUIRED_OPEN_NEXT_ARTIFACTS,
  findGeneratedBundleDependencies,
  findMissingRequiredFiles,
  findRetiredAstDependencies,
  stripComments,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../scripts/check-supabase-shutdown.js')

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
    'src/lib/supabase/client.ts',
    'src/lib/supabase/server.ts',
    'src/lib/supabase/index.ts',
    'src/lib/supabase/keys.ts',
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

  it('token-managerに削除済みdriver helperの説明が残らない', () => {
    const source = readFileSync(
      resolve(repositoryRoot, 'src/lib/twitch/token-manager.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/\b(?:isPgReadEnabled|isPgWriteEnabled|getGachaDbDriver)\b/)
  })

  it.each([
    [
      'named import aliasと別名client',
      `
        import { createClient as make } from '@supabase/supabase-js'
        const backend = make('https://example.invalid', 'secret')
        backend.from('users')
      `,
    ],
    [
      'namespace importと別名client',
      `
        import * as sdk from '@supabase/supabase-js'
        const api = sdk.createClient('https://example.invalid', 'secret')
        api.rpc('legacy_fn')
      `,
    ],
    [
      'dynamic import',
      `const sdk = await import('@supabase/supabase-js')`,
    ],
    [
      'CommonJS namespaceとdestructuring',
      `
        const sdk = require('@supabase/supabase-js')
        const { createClient: make } = sdk
        const backend = make('https://example.invalid', 'secret')
        backend.channel('legacy')
      `,
    ],
    [
      'local wrapperへ渡すre-export',
      `export { createClient as legacyClient } from '@supabase/supabase-js'`,
    ],
  ])('%s はAST provenance guardで拒否される', (_label, source) => {
    const detected = findRetiredAstDependencies('src/fixture.ts', source)

    expect(detected.length).toBeGreaterThan(0)
  })

  it('コメント・説明文字列・Drizzleの別名fromはSupabase clientと誤判定しない', () => {
    const source = `
      // supabase.from('history')
      const history = "supabase.from('history')"
      const api = getDrizzleDb()
      api.from(users)
    `

    expect(findRetiredAstDependencies('src/safe-fixture.ts', source)).toEqual([])
  })

  it('必須OpenNext artifactが1件でも無ければ欠落として返す', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'twica-shutdown-artifacts-'))
    try {
      expect(findMissingRequiredFiles(fixtureRoot, REQUIRED_OPEN_NEXT_ARTIFACTS))
        .toEqual(REQUIRED_OPEN_NEXT_ARTIFACTS)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('補助Workerのproduction/preview artifactが1件でも無ければ欠落として返す', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'twica-shutdown-aux-artifacts-'))
    try {
      expect(findMissingRequiredFiles(fixtureRoot, REQUIRED_AUX_WORKER_ARTIFACTS))
        .toEqual(REQUIRED_AUX_WORKER_ARTIFACTS)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it.each([
    '@supabase/supabase-js',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_URL',
    '/rest/v1/users',
    '/realtime/v1/websocket',
    '/auth/v1/token',
    '/storage/v1/object',
    '/functions/v1/task',
    'event:"phx_join"',
    'type:"postgres_changes"',
  ])('生成bundleのretired provider痕跡をliteral scanで拒否する: %s', (marker) => {
    expect(findGeneratedBundleDependencies(`const bundled = ${JSON.stringify(marker)}`))
      .not.toEqual([])
  })

  it('生成bundle内の単なる一般的なPostgreSQL処理は誤検知しない', () => {
    expect(findGeneratedBundleDependencies('const provider = "PlanetScale PostgreSQL"'))
      .toEqual([])
  })
})
