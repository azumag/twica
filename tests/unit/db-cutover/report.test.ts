import { describe, expect, it } from 'vitest'
import { buildReport } from '../../../scripts/db-cutover/report.mjs'

// IMPLEMENTED_LAYERS/KNOWN_FUTURE_LAYERSは cli-args.mjs 側に定義されている
// （Fableレビュー Minor-7対応。cli-args.test.ts でテスト済み。report.mjs の buildReport は
// これらの定数を一切参照しないため、report.test.ts からは削除した）。

const baseArgs = {
  operationId: 'op-123',
  generatedAt: '2026-07-20T00:00:00.000Z',
  sourceExpected: { environment: 'preview', provider: 'supabase' },
  targetExpected: { environment: 'preview', provider: 'planetscale' },
}

describe('buildReport: schemaVersion / 基本フィールド', () => {
  it('schemaVersionは常に1', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: [], executedLayerResults: [] })
    expect(report.schemaVersion).toBe(1)
  })

  it('operationId/generatedAtをそのまま反映する', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: [], executedLayerResults: [] })
    expect(report.operationId).toBe('op-123')
    expect(report.generatedAt).toBe('2026-07-20T00:00:00.000Z')
  })

  it('operationIdがnullでも許容する', () => {
    const report = buildReport({ ...baseArgs, operationId: null, requestedLayers: [], executedLayerResults: [] })
    expect(report.operationId).toBeNull()
  })
})

describe('buildReport: decision計算', () => {
  it('要求layerが0件なら not-evaluated', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: [], executedLayerResults: [] })
    expect(report.decision).toBe('not-evaluated')
  })

  it('要求した全layerが実行されすべてpassなら pass', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [
        { layer: 'identity', pass: true, findings: [] },
        { layer: 'schema', pass: true, findings: [] },
      ],
    })
    expect(report.decision).toBe('pass')
  })

  it('1つでもfailしたlayerがあれば fail（他がpassでも）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [
        { layer: 'identity', pass: true, findings: [] },
        { layer: 'schema', pass: false, findings: [{ code: 'X' }] },
      ],
    })
    expect(report.decision).toBe('fail')
  })

  it('identity layerがfailして後続layerが未実行の場合、fail優先で fail になる（not-evaluatedにはならない）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [{ layer: 'identity', pass: false, findings: [{ code: 'MISMATCH' }] }],
    })
    expect(report.decision).toBe('fail')
    expect(report.layers.schema).toEqual({ layer: 'schema', pass: null, findings: [], notEvaluated: true })
  })

  it('要求layerの一部が未実行だが実行済みが全てpassの場合は not-evaluated', () => {
    // 実運用では起こりにくい組み合わせだが、decision計算ロジック自体の境界値として検証する
    // （例: 将来的な部分実行モードの拡張に備えた回帰防止）。
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [{ layer: 'identity', pass: true, findings: [] }],
    })
    expect(report.decision).toBe('not-evaluated')
  })
})

describe('buildReport: source/target サマリ', () => {
  it('identity layerが実行されていれば実DBから読んだ値（instanceId込み）を使う', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [
        {
          layer: 'identity',
          pass: true,
          findings: [],
          source: { environment: 'preview', provider: 'supabase', instanceId: 'source-uuid', bypassRls: true },
          target: { environment: 'preview', provider: 'planetscale', instanceId: 'target-uuid', bypassRls: true },
        },
      ],
    })
    expect(report.source).toEqual({ environment: 'preview', provider: 'supabase', instanceId: 'source-uuid' })
    expect(report.target).toEqual({ environment: 'preview', provider: 'planetscale', instanceId: 'target-uuid' })
  })

  it('identity layerが未実行ならCLI宣言値のみを使い、instanceIdはnull', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: ['schema'], executedLayerResults: [{ layer: 'schema', pass: true, findings: [] }] })
    expect(report.source).toEqual({ environment: 'preview', provider: 'supabase', instanceId: null })
    expect(report.target).toEqual({ environment: 'preview', provider: 'planetscale', instanceId: null })
  })
})

describe('buildReport: layers構造の拡張性', () => {
  it('layersはlayer名をキーにしたオブジェクトである（配列ではない）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [{ layer: 'identity', pass: true, findings: [] }],
    })
    expect(report.layers).toEqual({ identity: { layer: 'identity', pass: true, findings: [] } })
    expect(Array.isArray(report.layers)).toBe(false)
  })

  it('requestedLayersをそのまま記録する（後続チャンクでの再現性のため）', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: ['identity', 'schema'], executedLayerResults: [] })
    expect(report.requestedLayers).toEqual(['identity', 'schema'])
  })
})

describe('buildReport: reportにconnection string等の生値が含まれない', () => {
  it('入力に接続文字列を一切渡していないため、JSON化してもURL/パスワードらしき文字列を含みようがない', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [
        {
          layer: 'identity',
          pass: false,
          findings: [{ severity: 'fail', code: 'ENVIRONMENT_MISMATCH', message: 'source: mismatch', side: 'source' }],
        },
      ],
    })
    const json = JSON.stringify(report)
    expect(json).not.toMatch(/postgres(ql)?:\/\//)
    expect(json).not.toMatch(/password/i)
  })
})
