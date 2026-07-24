import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

/**
 * logger.server は `server-only` と DB 永続化を含むため、middleware の到達グラフへ
 * 混入させない。ビルド成果物の文字列検索では tree-shaking やキャッシュで偽陰性に
 * なり得るため、ここではレビュー対象の TypeScript source の import 宣言を直接固定する。
 */
describe('logger import runtime boundaries', () => {
  const middlewareReachableModules = [
    'src/middleware.ts',
    'src/lib/maintenance/guard.ts',
    'src/lib/rate-limit.ts',
  ]

  const serverOnlyModules = [
    'src/lib/r2-client.ts',
    'src/lib/session.ts',
    'src/lib/csrf.ts',
  ]

  it.each(middlewareReachableModules)('%s does not import logger.server', async (sourcePath) => {
    const source = await readSource(sourcePath)

    expect(source).not.toMatch(/from\s+['"][^'"]*logger\.server['"]/)
  })

  it.each(serverOnlyModules)('%s imports the server-only logger explicitly', async (sourcePath) => {
    const source = await readSource(sourcePath)

    expect(source).toMatch(/from\s+['"][^'"]*logger\.server['"]/)
  })

  it('server-only callers retain a representative error branch for the persistence logger', async () => {
    const [r2Client, session, csrf] = await Promise.all([
      readSource('src/lib/r2-client.ts'),
      readSource('src/lib/session.ts'),
      readSource('src/lib/csrf.ts'),
    ])

    // logger.server.test が logger.error -> logErrorFromLogger の実行時委譲を検証する。
    // ここでは各 caller がその entry point を経由する代表的な障害分岐を残していることを
    // source level で固定し、将来 shared logger への差し戻しで永続化が外れる回帰を防ぐ。
    expect(r2Client).toContain("logger.error('[R2] Failed to upload file:', error)")
    expect(session).toContain("logger.error('[Session] Failed to parse session cookie:', error)")
    expect(csrf).toContain("logger.error('CSRF validation failed: Unexpected error'")
  })
})
