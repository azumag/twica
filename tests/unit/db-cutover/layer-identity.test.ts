import { describe, expect, it } from 'vitest'
import { evaluateSideState, evaluateIdentityLayer } from '../../../scripts/db-cutover/layer-identity.mjs'

// Minor-11（Fableレビュー）: `evaluateSideState` はfindingsを戻り値ではなく引数配列への
// pushで受け取る設計（呼び出し側でsource/target両方のfindingsを1つの配列に集約するため）。
// テスト側で毎回 `Record<string, unknown>[]` と書くよりも、finding の実際の形を表す型を
// 1つ定義して使い回す方が意図が明確になる。
type Finding = { severity: string; code: string; message: string; side: string }

const okState = (overrides = {}) => ({
  tableExists: true,
  rows: [{ environment: 'preview', provider: 'supabase', instance_id: 'uuid-source' }],
  bypassRls: true,
  ...overrides,
})

describe('evaluateSideState', () => {
  it('テーブル不存在なら IDENTITY_TABLE_MISSING でfail（bypassRlsが正常な場合はそれ単独）', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('source', { tableExists: false, rows: [], bypassRls: true }, { environment: 'preview', provider: 'supabase' }, findings)
    expect(result.ok).toBe(false)
    expect(result.identity).toBeNull()
    expect(findings).toEqual([expect.objectContaining({ code: 'IDENTITY_TABLE_MISSING', side: 'source' })])
  })

  it('テーブル不存在かつBYPASSRLSも無い場合、両方のfindingが1回の呼び出しで積まれる（オーケストレーターレビュー Minor-1対応、早期returnの撤廃確認）', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('source', { tableExists: false, rows: [], bypassRls: false }, { environment: 'preview', provider: 'supabase' }, findings)
    expect(result.ok).toBe(false)
    const codes = findings.map((f) => f.code)
    expect(codes).toEqual(expect.arrayContaining(['IDENTITY_TABLE_MISSING', 'BYPASSRLS_REQUIRED']))
    expect(codes).toHaveLength(2)
  })

  it('行が0件なら IDENTITY_ROW_MISSING でfail', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('target', { tableExists: true, rows: [], bypassRls: true }, { environment: 'preview', provider: 'planetscale' }, findings)
    expect(result.ok).toBe(false)
    expect(findings).toEqual([expect.objectContaining({ code: 'IDENTITY_ROW_MISSING', side: 'target' })])
  })

  it('行が複数件なら IDENTITY_MULTIPLE_ROWS でfail', () => {
    const findings: Finding[] = []
    const state = {
      tableExists: true,
      rows: [
        { environment: 'preview', provider: 'supabase', instance_id: 'a' },
        { environment: 'production', provider: 'supabase', instance_id: 'b' },
      ],
      bypassRls: true,
    }
    const result = evaluateSideState('source', state, { environment: 'preview', provider: 'supabase' }, findings)
    expect(result.ok).toBe(false)
    expect(findings).toEqual([expect.objectContaining({ code: 'IDENTITY_MULTIPLE_ROWS' })])
  })

  it('environment/provider/bypassRlsが全て期待通りならok=true・findingsは空', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('source', okState(), { environment: 'preview', provider: 'supabase' }, findings)
    expect(result.ok).toBe(true)
    expect(findings).toEqual([])
    expect(result.identity).toEqual({ environment: 'preview', provider: 'supabase', instanceId: 'uuid-source' })
  })

  it('--source-environment とDB上のenvironmentが食い違うと ENVIRONMENT_MISMATCH でfail', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('source', okState(), { environment: 'production', provider: 'supabase' }, findings)
    expect(result.ok).toBe(false)
    expect(findings).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH', side: 'source' })])
  })

  it('--source-provider とDB上のproviderが食い違うと PROVIDER_MISMATCH でfail', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('source', okState(), { environment: 'preview', provider: 'planetscale' }, findings)
    expect(result.ok).toBe(false)
    expect(findings).toEqual([expect.objectContaining({ code: 'PROVIDER_MISMATCH', side: 'source' })])
  })

  it('BYPASSRLSを持たない場合 BYPASSRLS_REQUIRED でfail（警告ではなくfail）', () => {
    const findings: Finding[] = []
    const result = evaluateSideState('target', okState({ bypassRls: false }), { environment: 'preview', provider: 'supabase' }, findings)
    expect(result.ok).toBe(false)
    expect(findings).toEqual([expect.objectContaining({ code: 'BYPASSRLS_REQUIRED', severity: 'fail' })])
  })

  it('複数の不一致は全てfindingsに積まれる（1つ検知したら打ち切りにしない）', () => {
    const findings: Finding[] = []
    evaluateSideState(
      'source',
      okState({ bypassRls: false }),
      { environment: 'production', provider: 'planetscale' },
      findings
    )
    const codes = findings.map((f) => f.code)
    expect(codes).toEqual(
      expect.arrayContaining(['ENVIRONMENT_MISMATCH', 'PROVIDER_MISMATCH', 'BYPASSRLS_REQUIRED'])
    )
    expect(codes).toHaveLength(3)
  })
})

describe('evaluateIdentityLayer', () => {
  const expected = { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'preview', targetProvider: 'planetscale' }

  it('source/targetが正しいidentityで一致すればpass', () => {
    const sourceState = okState({ rows: [{ environment: 'preview', provider: 'supabase', instance_id: 'uuid-source' }] })
    const targetState = okState({ rows: [{ environment: 'preview', provider: 'planetscale', instance_id: 'uuid-target' }] })
    const result = evaluateIdentityLayer({ sourceState, targetState, expected })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.source).toEqual({ environment: 'preview', provider: 'supabase', instanceId: 'uuid-source', bypassRls: true })
    expect(result.target).toEqual({ environment: 'preview', provider: 'planetscale', instanceId: 'uuid-target', bypassRls: true })
  })

  it('同一instance_id（source/targetが同じDB）なら IDENTITY_INSTANCE_ID_COLLISION でfail', () => {
    const sameInstanceRow = { environment: 'preview', provider: 'supabase', instance_id: 'same-uuid' }
    const sourceState = okState({ rows: [sameInstanceRow] })
    const targetState = okState({ rows: [{ ...sameInstanceRow, provider: 'planetscale' }] })
    const result = evaluateIdentityLayer({
      sourceState,
      targetState,
      expected: { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'preview', targetProvider: 'planetscale' },
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'IDENTITY_INSTANCE_ID_COLLISION', side: 'both' })])
    )
  })

  it('sourceのenvironmentがprod/preview逆転していたらfail（instance_id比較には進まない不整合と共存できる）', () => {
    const sourceState = okState({ rows: [{ environment: 'production', provider: 'supabase', instance_id: 'uuid-source' }] })
    const targetState = okState({ rows: [{ environment: 'preview', provider: 'planetscale', instance_id: 'uuid-target' }] })
    const result = evaluateIdentityLayer({ sourceState, targetState, expected })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH', side: 'source' })])
    )
  })

  it('片側のidentity行が無い場合、instance_id比較はスキップされ他のfindingのみになる（BYPASSRLS不備も同時に報告される）', () => {
    const sourceState = { tableExists: false, rows: [], bypassRls: false }
    const targetState = okState({ rows: [{ environment: 'preview', provider: 'planetscale', instance_id: 'uuid-target' }] })
    const result = evaluateIdentityLayer({ sourceState, targetState, expected })
    expect(result.pass).toBe(false)
    const codes = result.findings.map((f: { code: string }) => f.code)
    expect(codes).not.toContain('IDENTITY_INSTANCE_ID_COLLISION')
    expect(codes).toContain('IDENTITY_TABLE_MISSING')
    // オーケストレーターレビュー Minor-1対応: テーブル不存在で早期returnしなくなったため、
    // BYPASSRLSチェックも同じ実行で行われ、両方の問題が1回で報告される。
    expect(codes).toContain('BYPASSRLS_REQUIRED')
  })
})
