import { describe, expect, it } from 'vitest'
import {
  parseVerifyArgs,
  parseLayers,
  parseChunkSize,
  resolveVerifyConfig,
  IMPLEMENTED_LAYERS,
  KNOWN_FUTURE_LAYERS,
} from '../../../scripts/db-cutover/cli-args.mjs'
import { DEFAULT_CHUNK_SIZE } from '../../../scripts/db-cutover/layer-data.mjs'

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
  it('Chunk 2 時点で実装済みなのは identity/schema/data', () => {
    expect(IMPLEMENTED_LAYERS).toEqual(['identity', 'schema', 'data'])
  })
  it('後続チャンクで実装予定のlayerが定義されている（invariants/canary）', () => {
    expect(KNOWN_FUTURE_LAYERS).toEqual(['invariants', 'canary'])
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

  it('dataはChunk 2で実装済みのため有効', () => {
    expect(parseLayers('identity,data')).toEqual({ layers: ['identity', 'data'] })
  })

  it('invariants/canaryは「未実装」エラーメッセージになる（不明な引数エラーとは区別する）', () => {
    const result = parseLayers('identity,invariants')
    expect(result.error).toMatch(/未実装/)
  })

  it('完全に不明なlayer名は「不明なlayer」エラーになる', () => {
    const result = parseLayers('identity,bogus')
    expect(result.error).toMatch(/不明なlayer/)
  })

  it('identity,schema,dataの3つ指定時もidentity→schema→dataの固定順に正規化する', () => {
    expect(parseLayers('data,identity,schema')).toEqual({ layers: ['identity', 'schema', 'data'] })
  })
})

describe('parseChunkSize', () => {
  it('未指定ならDEFAULT_CHUNK_SIZEを返す', () => {
    expect(parseChunkSize(undefined)).toEqual({ chunkSize: DEFAULT_CHUNK_SIZE })
  })

  it('正の整数文字列は数値へ変換される', () => {
    expect(parseChunkSize('500')).toEqual({ chunkSize: 500 })
    expect(parseChunkSize('1')).toEqual({ chunkSize: 1 })
  })

  it('前後の空白は許容する', () => {
    expect(parseChunkSize(' 250 ')).toEqual({ chunkSize: 250 })
  })

  it.each(['0', '-1', '1.5', '1e3', 'abc', '', '  '])('不正な値 "%s" はエラーになる', (raw) => {
    const result = parseChunkSize(raw)
    expect(result.error).toMatch(/正の整数/)
    expect(result.chunkSize).toBeUndefined()
  })
})

describe('resolveVerifyConfig', () => {
  it('全て正しく指定されていれば設定オブジェクトを返す（chunk-size省略時はDEFAULT_CHUNK_SIZE）', () => {
    const resolved = resolveVerifyConfig(FULL_ARGV, ENV)
    expect(resolved).toEqual({
      sourceEnvironment: 'preview',
      targetEnvironment: 'preview',
      sourceProvider: 'supabase',
      targetProvider: 'planetscale',
      layers: ['identity', 'schema'],
      operationId: null,
      chunkSize: DEFAULT_CHUNK_SIZE,
      sourceUrl: ENV.SOURCE_DATABASE_URL,
      targetUrl: ENV.TARGET_DATABASE_URL,
    })
  })

  it('--chunk-sizeを指定すればその値が反映される', () => {
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--chunk-size=250'], ENV)
    expect(resolved.error).toBeUndefined()
    expect(resolved.chunkSize).toBe(250)
  })

  it('--chunk-sizeに不正な値を指定するとエラー', () => {
    const resolved = resolveVerifyConfig([...FULL_ARGV, '--chunk-size=0'], ENV)
    expect(resolved.error).toMatch(/正の整数/)
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
