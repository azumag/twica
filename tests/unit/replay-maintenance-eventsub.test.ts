import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  resolveConfig,
  buildRequestBody,
  addCounts,
} from '../../scripts/replay-maintenance-eventsub.js'

/**
 * scripts/replay-maintenance-eventsub.js の純粋関数（parseArgs/resolveConfig/
 * buildRequestBody/addCounts）に対する単体テスト（低-9）。
 * scripts/probe-maintenance-write-surfaces.js と同様に、ネットワークI/Oを伴わない
 * 純粋関数だけを対象にする（requestBatch/main はテスト対象外）。
 */

describe('parseArgs', () => {
  it('引数が無い場合は全てデフォルト値', () => {
    expect(parseArgs(['node', 'script.js'])).toEqual({
      help: false,
      url: undefined,
      dryRun: false,
      limit: undefined,
      limitError: undefined,
    })
  })

  it('--help / -h を検出する', () => {
    expect(parseArgs(['node', 'script.js', '--help']).help).toBe(true)
    expect(parseArgs(['node', 'script.js', '-h']).help).toBe(true)
  })

  it('--dry-run を検出する', () => {
    expect(parseArgs(['node', 'script.js', '--dry-run']).dryRun).toBe(true)
  })

  it('--url= 形式のフラグからURLを取り出す', () => {
    expect(parseArgs(['node', 'script.js', '--url=https://example.com']).url).toBe(
      'https://example.com'
    )
  })

  it('--limit= から正の整数を取り出す', () => {
    const result = parseArgs(['node', 'script.js', '--limit=50'])
    expect(result.limit).toBe(50)
    expect(result.limitError).toBeUndefined()
  })

  it('--limit= が数値でない場合は limitError を設定し limit は undefined', () => {
    const result = parseArgs(['node', 'script.js', '--limit=abc'])
    expect(result.limit).toBeUndefined()
    expect(result.limitError).toContain('正の整数')
  })

  it('--limit= が0以下の場合は limitError を設定する', () => {
    expect(parseArgs(['node', 'script.js', '--limit=0']).limitError).toBeDefined()
    expect(parseArgs(['node', 'script.js', '--limit=-5']).limitError).toBeDefined()
  })

  it('--limit= が非整数（小数）の場合は limitError を設定する', () => {
    expect(parseArgs(['node', 'script.js', '--limit=1.5']).limitError).toBeDefined()
  })
})

describe('resolveConfig', () => {
  it('--help があれば { help: true } を返す（他のバリデーションより優先）', () => {
    expect(resolveConfig(['node', 'script.js', '--help'], {})).toEqual({ help: true })
  })

  it('--limit が不正な場合は limitError をそのまま返す（--url指定の有無に関わらず優先）', () => {
    const result = resolveConfig(
      ['node', 'script.js', '--url=https://example.com', '--limit=abc'],
      { EVENTSUB_REPLAY_SECRET: 'secret' }
    )
    expect('error' in result).toBe(true)
  })

  it('--url が無い場合はエラーを返す', () => {
    const result = resolveConfig(['node', 'script.js'], { EVENTSUB_REPLAY_SECRET: 'secret' })
    expect('error' in result).toBe(true)
  })

  it('URLが http:// または https:// で始まらない場合はエラーを返す', () => {
    const result = resolveConfig(['node', 'script.js', '--url=ftp://example.com'], {
      EVENTSUB_REPLAY_SECRET: 'secret',
    })
    expect('error' in result).toBe(true)
  })

  it('EVENTSUB_REPLAY_SECRET が未設定の場合はエラーを返す（CLI引数では渡せない）', () => {
    const result = resolveConfig(['node', 'script.js', '--url=https://example.com'], {})
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('EVENTSUB_REPLAY_SECRET')
  })

  it('EVENTSUB_REPLAY_SECRET が空文字の場合もエラーを返す', () => {
    const result = resolveConfig(['node', 'script.js', '--url=https://example.com'], {
      EVENTSUB_REPLAY_SECRET: '   ',
    })
    expect('error' in result).toBe(true)
  })

  it('正常系: baseUrlの末尾スラッシュを除去し、secret/dryRun/limitを反映する', () => {
    const result = resolveConfig(
      ['node', 'script.js', '--url=https://example.com/', '--dry-run', '--limit=30'],
      { EVENTSUB_REPLAY_SECRET: 'my-secret' }
    )
    expect(result).toEqual({
      baseUrl: 'https://example.com',
      secret: 'my-secret',
      dryRun: true,
      limit: 30,
    })
  })

  it('--limit を省略した場合は limit: undefined のまま（サーバー側既定値に委ねる）', () => {
    const result = resolveConfig(['node', 'script.js', '--url=https://example.com'], {
      EVENTSUB_REPLAY_SECRET: 'secret',
    })
    expect((result as { limit: number | undefined }).limit).toBeUndefined()
  })
})

describe('buildRequestBody', () => {
  it('dryRun/limit/cursorが全て未指定なら空オブジェクト', () => {
    expect(buildRequestBody({ dryRun: false, limit: undefined, cursor: undefined })).toEqual({})
  })

  it('dryRun=trueのときのみ dryRun フィールドを含める', () => {
    expect(buildRequestBody({ dryRun: true, limit: undefined, cursor: undefined })).toEqual({
      dryRun: true,
    })
  })

  it('limitが指定されていればそのまま含める（0も含めて）', () => {
    expect(buildRequestBody({ dryRun: false, limit: 10, cursor: undefined })).toEqual({ limit: 10 })
  })

  it('cursorが指定されていればそのまま含める', () => {
    expect(buildRequestBody({ dryRun: false, limit: undefined, cursor: 'next-cursor' })).toEqual({
      cursor: 'next-cursor',
    })
  })

  it('全フィールドが指定されていれば全て含める', () => {
    expect(buildRequestBody({ dryRun: true, limit: 5, cursor: 'c1' })).toEqual({
      dryRun: true,
      limit: 5,
      cursor: 'c1',
    })
  })
})

describe('addCounts', () => {
  it('succeeded/skipped/failed/totalを単純加算する', () => {
    const totals = { succeeded: 1, skipped: 2, failed: 3, unknownType: 0, invalidPayload: 0, total: 6 }
    const batch = { succeeded: 4, skipped: 5, failed: 6, unknownType: 0, invalidPayload: 0, total: 15 }
    expect(addCounts(totals, batch)).toEqual({
      succeeded: 5,
      skipped: 7,
      failed: 9,
      unknownType: 0,
      invalidPayload: 0,
      total: 21,
    })
  })

  it('unknownType/invalidPayload（中-2/低-6で新設されたカテゴリ）も加算する', () => {
    const totals = { succeeded: 0, skipped: 0, failed: 0, unknownType: 1, invalidPayload: 2, total: 3 }
    const batch = { succeeded: 0, skipped: 0, failed: 0, unknownType: 3, invalidPayload: 4, total: 7 }
    expect(addCounts(totals, batch)).toEqual({
      succeeded: 0,
      skipped: 0,
      failed: 0,
      unknownType: 4,
      invalidPayload: 6,
      total: 10,
    })
  })

  it('batchCountsにunknownType/invalidPayloadが無くても0として加算する（後方互換）', () => {
    const totals = { succeeded: 0, skipped: 0, failed: 0, unknownType: 1, invalidPayload: 1, total: 2 }
    // 古いサーバーレスポンスを想定し、新設フィールドが欠落したオブジェクトを渡す
    const batch = { succeeded: 1, skipped: 0, failed: 0, total: 1 } as unknown as {
      succeeded: number
      skipped: number
      failed: number
      unknownType: number
      invalidPayload: number
      total: number
    }
    expect(addCounts(totals, batch)).toEqual({
      succeeded: 1,
      skipped: 0,
      failed: 0,
      unknownType: 1,
      invalidPayload: 1,
      total: 3,
    })
  })
})
