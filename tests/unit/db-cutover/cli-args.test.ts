import { describe, expect, it } from 'vitest'
import {
  parseVerifyArgs,
  parseLayers,
  resolveVerifyConfig,
  IMPLEMENTED_LAYERS,
  KNOWN_FUTURE_LAYERS,
} from '../../../scripts/db-cutover/cli-args.mjs'

const FULL_ARGV = [
  'node',
  'verify.mjs',
  '--source-environment=preview',
  '--source-provider=supabase',
  '--target-environment=preview',
  '--target-provider=planetscale',
  '--layers=identity,schema',
]

const ENV = { SOURCE_DATABASE_URL: 'postgres://u:p@source-host:5432/db', TARGET_DATABASE_URL: 'postgres://u:p@target-host:5432/db' }

describe('IMPLEMENTED_LAYERS / KNOWN_FUTURE_LAYERS', () => {
  it('Chunk 1 で実装済みなのは identity/schema のみ', () => {
    expect(IMPLEMENTED_LAYERS).toEqual(['identity', 'schema'])
  })
  it('後続チャンクで実装予定のlayerが定義されている（data/invariants/canary）', () => {
    expect(KNOWN_FUTURE_LAYERS).toEqual(['data', 'invariants', 'canary'])
  })
  it('IMPLEMENTED_LAYERS と KNOWN_FUTURE_LAYERS は重複しない', () => {
    const overlap = IMPLEMENTED_LAYERS.filter((l) => KNOWN_FUTURE_LAYERS.includes(l))
    expect(overlap).toEqual([])
  })
})

describe('parseVerifyArgs', () => {
  it('全フラグを正しく解析する', () => {
    const parsed = parseVerifyArgs(FULL_ARGV)
    expect(parsed).toMatchObject({
      help: false,
      sourceEnvironment: 'preview',
      sourceProvider: 'supabase',
      targetEnvironment: 'preview',
      targetProvider: 'planetscale',
      layersRaw: 'identity,schema',
      unknownArgs: [],
    })
  })

  it('--helpを検知する', () => {
    expect(parseVerifyArgs(['node', 'verify.mjs', '--help']).help).toBe(true)
  })

  it('未知のフラグは黙って無視せずunknownArgsに積む', () => {
    const parsed = parseVerifyArgs([...FULL_ARGV, '--typo-flag=x'])
    expect(parsed.unknownArgs).toEqual(['--typo-flag=x'])
  })

  it('同一フラグを重複指定すると黙って後勝ちにせずduplicateArgsに積む（オーケストレーターレビュー Minor-7対応）', () => {
    const parsed = parseVerifyArgs([...FULL_ARGV, '--layers=schema'])
    expect(parsed.duplicateArgs).toEqual(['--layers=schema'])
    // 最初に指定した値を採用し、重複分で上書きしない。
    expect(parsed.layersRaw).toBe('identity,schema')
  })
})

describe('parseLayers', () => {
  it('identity,schemaは有効', () => {
    expect(parseLayers('identity,schema')).toEqual({ layers: ['identity', 'schema'] })
  })

  it('空白を含む場合もtrimして解釈する', () => {
    expect(parseLayers(' identity , schema ')).toEqual({ layers: ['identity', 'schema'] })
  })

  it('順序を逆に指定してもidentity→schemaの固定順に正規化する', () => {
    expect(parseLayers('schema,identity')).toEqual({ layers: ['identity', 'schema'] })
  })

  it('identityのみの指定も有効', () => {
    expect(parseLayers('identity')).toEqual({ layers: ['identity'] })
  })

  it('未指定・空文字はエラー', () => {
    expect(parseLayers('')).toEqual({ error: expect.stringContaining('必須') })
    expect(parseLayers('  ')).toEqual({ error: expect.stringContaining('必須') })
  })

  it('data/invariants/canaryは「未実装」エラーメッセージになる（不明な引数エラーとは区別する）', () => {
    const result = parseLayers('identity,data')
    expect(result.error).toMatch(/未実装/)
  })

  it('完全に不明なlayer名は「不明なlayer」エラーになる', () => {
    const result = parseLayers('identity,bogus')
    expect(result.error).toMatch(/不明なlayer/)
  })
})

describe('resolveVerifyConfig', () => {
  it('全て正しく指定されていれば設定オブジェクトを返す', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, ENV)
    expect(resolved).toEqual({
      sourceEnvironment: 'preview',
      targetEnvironment: 'preview',
      sourceProvider: 'supabase',
      targetProvider: 'planetscale',
      layers: ['identity', 'schema'],
      operationId: null,
      sourceUrl: ENV.SOURCE_DATABASE_URL,
      targetUrl: ENV.TARGET_DATABASE_URL,
    })
  })

  it('--helpならhelp:trueのみを返す', () => {
    expect(resolveVerifyConfig(['node', 'verify.mjs', '--help'], ENV)).toEqual({ help: true })
  })

  it.each([
    ['--source-environment', FULL_ARGV.filter((a) => !a.startsWith('--source-environment'))],
    ['--target-environment', FULL_ARGV.filter((a) => !a.startsWith('--target-environment'))],
    ['--source-provider', FULL_ARGV.filter((a) => !a.startsWith('--source-provider'))],
    ['--target-provider', FULL_ARGV.filter((a) => !a.startsWith('--target-provider'))],
    ['--layers', FULL_ARGV.filter((a) => !a.startsWith('--layers'))],
  ])('%s が省略されるとエラーになる（デフォルト推測しない）', (_flag, argv) => {
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.error).toBeDefined()
  })

  it('不正なenvironment値はエラー', () => {
    const argv = FULL_ARGV.map((a) => (a.startsWith('--source-environment=') ? '--source-environment=staging' : a))
    expect(resolveVerifyConfig(argv, ENV).error).toMatch(/production\/preview/)
  })

  it('不正なprovider値はエラー', () => {
    const argv = FULL_ARGV.map((a) => (a.startsWith('--source-provider=') ? '--source-provider=aws-rds' : a))
    expect(resolveVerifyConfig(argv, ENV).error).toMatch(/supabase\/planetscale/)
  })

  it('source/targetいずれかがproductionなら --operation-id が必須', () => {
    const argv = FULL_ARGV.map((a) => (a.startsWith('--source-environment=') ? '--source-environment=production' : a))
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.error).toMatch(/operation-id/)
  })

  it('--operation-idを指定していればproductionでも通る', () => {
    const argv = [
      ...FULL_ARGV.map((a) => (a.startsWith('--source-environment=') ? '--source-environment=production' : a)),
      '--operation-id=cutover-2026-08-01',
    ]
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.operationId).toBe('cutover-2026-08-01')
  })

  it('両方previewならoperation-id無しでも通る', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, ENV)
    expect(resolved.error).toBeUndefined()
  })

  it('--operation-id= （空文字列）を渡すとoperationIdはnull扱いになる（オーケストレーターレビュー Minor-6対応）', () => {
    // `??`（nullish coalescing）は空文字列を「値あり」として扱ってしまうため、
    // 以前は `operationId: ''` のままreportまで伝播していた。
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--operation-id='], ENV)
    expect(resolved.error).toBeUndefined()
    expect(resolved.operationId).toBeNull()
  })

  it('--operation-id=production指定時に空文字列を渡すと、本番安全ガードにより弾かれる（既存挙動の回帰確認）', () => {
    const argv = [
      ...FULL_ARGV.map((a) => (a.startsWith('--source-environment=') ? '--source-environment=production' : a)),
      '--operation-id=',
    ]
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.error).toMatch(/operation-id/)
  })

  it('--layers=schema単独（identityを含まない）は --allow-skip-identity 無しだとエラー（Minor-6, Fableレビュー対応）', () => {
    const argv = FULL_ARGV.map((a) => (a.startsWith('--layers=') ? '--layers=schema' : a))
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.error).toMatch(/allow-skip-identity/)
  })

  it('--layers=schema単独でも --allow-skip-identity を指定すれば通る', () => {
    const argv = [...FULL_ARGV.map((a) => (a.startsWith('--layers=') ? '--layers=schema' : a)), '--allow-skip-identity']
    const resolved = resolveVerifyConfig(argv, ENV)
    expect(resolved.error).toBeUndefined()
    expect(resolved.layers).toEqual(['schema'])
  })

  it('--layers=identity,schema なら --allow-skip-identity は不要', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, ENV)
    expect(resolved.error).toBeUndefined()
  })

  it('SOURCE_DATABASE_URL 未設定はエラー', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, { TARGET_DATABASE_URL: ENV.TARGET_DATABASE_URL })
    expect(resolved.error).toMatch(/SOURCE_DATABASE_URL/)
  })

  it('TARGET_DATABASE_URL 未設定はエラー', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, { SOURCE_DATABASE_URL: ENV.SOURCE_DATABASE_URL })
    expect(resolved.error).toMatch(/TARGET_DATABASE_URL/)
  })

  it('未知のフラグがあればエラー', () => {
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--bogus=1'], ENV)
    expect(resolved.error).toMatch(/不明な引数/)
  })

  it('--source-urlのようなCLIフラグは実装されていない（未知の引数として拒否される）', () => {
    // Issue #697本文が案として示した --source-url/--target-url は、シェル履歴・ps aux等への
    // 秘密情報漏洩を避けるため実装しない設計判断（cli-args.mjs冒頭コメント参照）。
    // 誤って使おうとした場合、静かに無視されず明示的にエラーになることを確認する。
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--source-url=postgres://x'], ENV)
    expect(resolved.error).toMatch(/不明な引数/)
  })

  it('同一フラグの重複指定はエラー（オーケストレーターレビュー Minor-7対応、黙って後勝ちにしない）', () => {
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--source-provider=planetscale'], ENV)
    expect(resolved.error).toMatch(/重複/)
  })
})
