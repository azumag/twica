import { describe, expect, it } from 'vitest'
import type { Sql } from 'postgres'
import { evaluateInvariantsLayer, readSideInvariants } from '../../../scripts/db-cutover/layer-invariants.mjs'
import { TIER_A, TIER_B } from '../../../scripts/db-cutover/invariant-checks.mjs'

/**
 * Issue #697 Chunk 3: layer-invariants.mjs（Layer 5実行本体）のテスト。
 *
 * evaluateInvariantsLayer はDB接続を持たない純粋関数（layer-data.mjsのevaluateDataLayerと
 * 同じ「pure decision + thin DB wrapper」流儀）のため、readSideInvariantsの戻り値を模した
 * fixtureのMapを直接組み立ててテストできる。readSideInvariants自体は`tx.unsafe()`と
 * タグ付きテンプレート（tableExists用）のみを呼ぶ薄いインターフェースに依存しているため、
 * それだけを模したfake txでpagination/スキップ分岐をCI上で検証できる
 * （layer-data.test.tsのmakeMockTxと同じ考え方）。
 */

// invariant-checks.mjs のJSDoc typedef（InvariantDef/InvariantCheckDef）をそのまま参照する。
// 単純な `const x = [{ tier: 'A', ... }]` のオブジェクトリテラルはTypeScriptに
// `tier: string` へ型を広げられてしまい（コンテキスト型が無いため）、evaluateInvariantsLayer/
// readSideInvariantsの引数型（`tier: 'A'|'B'`のリテラルユニオン）と一致しなくなる。
// fixtureの宣言時点でこの型を明示することでコンテキスト型付けを効かせ、広がりを防ぐ。
type InvariantDef = import('../../../scripts/db-cutover/invariant-checks.mjs').InvariantDef

function makeCheck(overrides: Partial<{ code: string; tier: 'A' | 'B'; violationCount: number; samples: string[]; digest: string | null; durationMs: number }> = {}) {
  return {
    code: 'FAKE_CHECK',
    tier: TIER_A as 'A' | 'B',
    violationCount: 0,
    samples: [],
    digest: null,
    durationMs: 5,
    ...overrides,
  }
}

const fakeInvariantDefs: InvariantDef[] = [
  {
    id: 'inv-a',
    description: 'Tier Aのfake invariant',
    requiredTables: ['t_a'],
    checks: [{ code: 'FAKE_TIER_A', tier: TIER_A, countSql: '', sampleSql: '', digestSql: null }],
  },
  {
    id: 'inv-b',
    description: 'Tier Bのfake invariant',
    requiredTables: ['t_b'],
    checks: [{ code: 'FAKE_TIER_B', tier: TIER_B, countSql: '', sampleSql: '', digestSql: '' }],
  },
]

describe('evaluateInvariantsLayer: Tier A（絶対値判定、source/target独立）', () => {
  it('両側とも0件ならpass、findingは空', () => {
    const sourceResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 0 })], durationMs: 1 }]])
    const targetResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 0 })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.invariants[0]).toEqual(expect.objectContaining({ id: 'inv-a', pass: true, allowlisted: false }))
  })

  it('source側のみ違反があればsource側のfindingのみ積む（target側は正常でも独立にfail）', () => {
    const sourceResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 3, samples: ['id-1'] })], durationMs: 1 }]])
    const targetResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 0 })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'FAKE_TIER_A', side: 'source' })])
    expect(result.invariants[0].pass).toBe(false)
    expect(result.invariants[0].checks[0]).toEqual(
      expect.objectContaining({ code: 'FAKE_TIER_A', tier: TIER_A, pass: false, crossCheck: null })
    )
  })

  it('両側に違反があれば両側分のfindingを個別に積む', () => {
    const sourceResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 1 })], durationMs: 1 }]])
    const targetResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 2 })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })
    expect(result.findings).toHaveLength(2)
    expect(result.findings.map((f) => f.side)).toEqual(expect.arrayContaining(['source', 'target']))
  })
})

describe('evaluateInvariantsLayer: Tier B（source/target両側一致型）', () => {
  it('両側とも0件ならfindingを出さない（S/N比を保つ、設計書rev2レビューMinor-4）', () => {
    const sourceResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 0, digest: null })], durationMs: 1 }]])
    const targetResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 0, digest: null })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[1]] })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('件数・digestが両側一致すればseverity=infoでpass', () => {
    const check = makeCheck({ tier: TIER_B, violationCount: 4, digest: 'digest-xyz', samples: ['a', 'b'] })
    const sourceResults = new Map([['inv-b', { tablesOk: true, checks: [check], durationMs: 1 }]])
    const targetResults = new Map([['inv-b', { tablesOk: true, checks: [check], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[1]] })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'info', code: 'FAKE_TIER_B', side: 'both' })])
    expect(result.invariants[0].checks[0].crossCheck).toEqual({ equal: true, sourceDigest: 'digest-xyz', targetDigest: 'digest-xyz' })
  })

  it('件数が異なればseverity=failでpass=false', () => {
    const sourceResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 3, digest: 'd' })], durationMs: 1 }]])
    const targetResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 5, digest: 'd' })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[1]] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'FAKE_TIER_B', side: 'both' })])
  })

  it('件数が同じでもdigestが異なればseverity=failでpass=false（違反の中身が違う）', () => {
    const sourceResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 3, digest: 'source-digest' })], durationMs: 1 }]])
    const targetResults = new Map([['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 3, digest: 'target-digest' })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[1]] })
    expect(result.pass).toBe(false)
    expect(result.invariants[0].checks[0].crossCheck).toEqual({ equal: false, sourceDigest: 'source-digest', targetDigest: 'target-digest' })
  })
})

describe('evaluateInvariantsLayer: テーブル不在 + allowlist', () => {
  it('両側不在 + allowlist該当（実際のbattle-stats-consistency）ならseverity=infoでpass=true、checksは空', () => {
    const battleInv: InvariantDef = { id: 'battle-stats-consistency', description: 'desc', requiredTables: ['battles', 'battle_stats'], checks: [] }
    const sourceResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battles', 'battle_stats'], durationMs: 1 }]])
    const targetResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battles', 'battle_stats'], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [battleInv] })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: 'info', code: 'INVARIANT_REQUIRED_TABLE_MISSING', allowlisted: true, side: 'both' }),
    ])
    expect(result.invariants[0]).toEqual(expect.objectContaining({ pass: true, allowlisted: true, checks: [] }))
    expect(result.invariants[0].reason).toBeTruthy()
  })

  it('両側不在だがallowlist非該当（架空のinvariantId）ならfail', () => {
    const fakeInv: InvariantDef = { id: 'no-such-allowlist-entry', description: 'desc', requiredTables: ['x'], checks: [] }
    const sourceResults = new Map([['no-such-allowlist-entry', { tablesOk: false, missingTables: ['x'], durationMs: 1 }]])
    const targetResults = new Map([['no-such-allowlist-entry', { tablesOk: false, missingTables: ['x'], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInv] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', side: 'source' }),
      expect.objectContaining({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', side: 'target' }),
    ])
  })

  it('片側のみ不在（移行漏れの疑い）はallowlist該当invariantIdであっても必ずfail（設計書のdata layerと同じ非対称ルール）', () => {
    const battleInv: InvariantDef = { id: 'battle-stats-consistency', description: 'desc', requiredTables: ['battles', 'battle_stats'], checks: [] }
    const sourceResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battles', 'battle_stats'], durationMs: 1 }]])
    const targetResults = new Map([['battle-stats-consistency', { tablesOk: true, checks: [], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [battleInv] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', side: 'source' })])
  })

  it('両側とも不在だが欠落テーブル集合が非対称（source=[battles,battle_stats]、target=[battle_stats]のみ）ならallowlist該当でも必ずfail（オーケストレーターレビュー Minor-2対応）', () => {
    const battleInv: InvariantDef = { id: 'battle-stats-consistency', description: 'desc', requiredTables: ['battles', 'battle_stats'], checks: [] }
    const sourceResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battles', 'battle_stats'], durationMs: 1 }]])
    const targetResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battle_stats'], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [battleInv] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', side: 'source' }),
      expect.objectContaining({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', side: 'target' }),
    ])
    // allowlisted:true になっていないこと（誤ってinfo降格されていない）を明示的に確認する。
    expect(result.invariants[0]).toEqual(expect.objectContaining({ allowlisted: false, pass: false }))
  })

  it('両側とも不在で欠落テーブル集合の順序だけが異なる場合は集合として一致とみなしallowlist該当ならinfo（順序非依存の確認）', () => {
    const battleInv: InvariantDef = { id: 'battle-stats-consistency', description: 'desc', requiredTables: ['battles', 'battle_stats'], checks: [] }
    const sourceResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battles', 'battle_stats'], durationMs: 1 }]])
    const targetResults = new Map([['battle-stats-consistency', { tablesOk: false, missingTables: ['battle_stats', 'battles'], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [battleInv] })
    expect(result.pass).toBe(true)
    expect(result.invariants[0]).toEqual(expect.objectContaining({ allowlisted: true, pass: true }))
  })
})

describe('evaluateInvariantsLayer: 実行時エラー（INVARIANT_RUNTIME_ERROR）', () => {
  it('source側のみエラーならINVARIANT_RUNTIME_ERRORが1件、pass=false', () => {
    const sourceResults = new Map([['inv-a', { error: 'boom', durationMs: 1 }]])
    const targetResults = new Map([['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 0 })], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'INVARIANT_RUNTIME_ERROR', side: 'source', message: expect.stringContaining('boom') })])
    expect(result.invariants[0]).toEqual(expect.objectContaining({ pass: false, checks: [] }))
  })

  it('両側エラーなら2件のINVARIANT_RUNTIME_ERROR', () => {
    const sourceResults = new Map([['inv-a', { error: 'boom-source', durationMs: 1 }]])
    const targetResults = new Map([['inv-a', { error: 'boom-target', durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })
    expect(result.findings).toHaveLength(2)
  })

  it('1つのinvariantのエラーが他のinvariantの判定に影響しない（invariantごとのtry/catchの目的）', () => {
    const sourceResults = new Map([
      ['inv-a', { error: 'boom', durationMs: 1 }],
      ['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 0 })], durationMs: 1 }],
    ])
    const targetResults = new Map([
      ['inv-a', { tablesOk: true, checks: [makeCheck({ violationCount: 0 })], durationMs: 1 }],
      ['inv-b', { tablesOk: true, checks: [makeCheck({ tier: TIER_B, violationCount: 0 })], durationMs: 1 }],
    ])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: fakeInvariantDefs })
    expect(result.invariants.find((i) => i.id === 'inv-a')?.pass).toBe(false)
    expect(result.invariants.find((i) => i.id === 'inv-b')?.pass).toBe(true)
  })
})

describe('evaluateInvariantsLayer: 内部整合性', () => {
  it('sourceResults/targetResultsに対応する結果が無いinvariantがあれば例外を投げる（内部配線エラー）', () => {
    const sourceResults = new Map()
    const targetResults = new Map()
    expect(() => evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[0]] })).toThrow(/internal wiring error/)
  })

  it('severity=infoのfindingのみではlayer全体のpassを壊さない（severityベースのpass計算）', () => {
    const check = makeCheck({ tier: TIER_B, violationCount: 2, digest: 'same-digest' })
    const sourceResults = new Map([['inv-b', { tablesOk: true, checks: [check], durationMs: 1 }]])
    const targetResults = new Map([['inv-b', { tablesOk: true, checks: [check], durationMs: 1 }]])
    const result = evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs: [fakeInvariantDefs[1]] })
    expect(result.findings.every((f) => f.severity === 'info')).toBe(true)
    expect(result.pass).toBe(true)
  })
})

/**
 * readSideInvariants（fake txによる分岐カバレッジ、layer-data.test.tsのmakeMockTxと同じ考え方）。
 * tableExists（layer-data.mjs、タグ付きテンプレート呼び出し）と、count/sample/digestの
 * `tx.unsafe()`呼び出しの両方を模したfake txを使う。
 */
function makeFakeTx(options: { tableExistsMap: Record<string, boolean>; responses: Map<string, unknown[]> }) {
  const calls: string[] = []
  // tableExists: `` await tx`select to_regclass(${'public.' + tableName}) as reg` ``
  const fake = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const qualified = String(values[0])
    const tableName = qualified.replace(/^public\./, '')
    calls.push(`tableExists:${tableName}`)
    return [{ reg: options.tableExistsMap[tableName] ? 'stub-oid' : null }]
  }
  ;(fake as unknown as { unsafe: (sql: string) => Promise<unknown[]> }).unsafe = async (sql: string) => {
    calls.push(`unsafe`)
    if (!options.responses.has(sql)) {
      throw new Error(`unexpected sql passed to fake tx.unsafe: ${sql}`)
    }
    const response = options.responses.get(sql)
    if (response instanceof Error) throw response
    return response as unknown[]
  }
  return { tx: fake as unknown as Sql, calls }
}

describe('readSideInvariants（fake txによる分岐カバレッジ）', () => {
  it('requiredTablesが揃っていなければcheckを実行せずtablesOk=falseを返す', async () => {
    const { tx, calls } = makeFakeTx({ tableExistsMap: { t_a: false }, responses: new Map() })
    const results = await readSideInvariants(tx, [fakeInvariantDefs[0]], 'source', (t: string) => t, undefined)
    expect(results.get('inv-a')).toEqual(expect.objectContaining({ tablesOk: false, missingTables: ['t_a'] }))
    expect(calls.filter((c) => c === 'unsafe')).toHaveLength(0)
  })

  it('違反0件ならsample/digestクエリを実行しない（最適化）', async () => {
    const inv: InvariantDef = {
      id: 'inv-zero',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C1', tier: TIER_A, countSql: 'COUNT_SQL', sampleSql: 'SAMPLE_SQL', digestSql: null }],
    }
    const responses = new Map<string, unknown[]>([['COUNT_SQL', [{ count: 0 }]]])
    const { tx, calls } = makeFakeTx({ tableExistsMap: { t: true }, responses })
    const results = await readSideInvariants(tx, [inv], 'source', (t: string) => t, undefined)
    expect(results.get('inv-zero')).toEqual(
      expect.objectContaining({ tablesOk: true, checks: [expect.objectContaining({ violationCount: 0, samples: [], digest: null })] })
    )
    // COUNT_SQLの1回のみ（SAMPLE_SQLは呼ばれない）
    expect(calls.filter((c) => c === 'unsafe')).toHaveLength(1)
  })

  it('Tier Aで違反ありならsampleは実行するがdigestは実行しない（digestSql=nullのため）', async () => {
    const inv: InvariantDef = {
      id: 'inv-tier-a',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C1', tier: TIER_A, countSql: 'COUNT_SQL', sampleSql: 'SAMPLE_SQL', digestSql: null }],
    }
    const responses = new Map<string, unknown[]>([
      ['COUNT_SQL', [{ count: 2 }]],
      ['SAMPLE_SQL', [{ identifier: 'id-1' }, { identifier: 'id-2' }]],
    ])
    const { tx, calls } = makeFakeTx({ tableExistsMap: { t: true }, responses })
    const results = await readSideInvariants(tx, [inv], 'source', (t: string) => t, undefined)
    expect(results.get('inv-tier-a')).toEqual(
      expect.objectContaining({ checks: [expect.objectContaining({ violationCount: 2, samples: ['id-1', 'id-2'], digest: null })] })
    )
    expect(calls.filter((c) => c === 'unsafe')).toHaveLength(2)
  })

  it('Tier Bで違反ありならsampleとdigestの両方を実行する', async () => {
    const inv: InvariantDef = {
      id: 'inv-tier-b',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C1', tier: TIER_B, countSql: 'COUNT_SQL', sampleSql: 'SAMPLE_SQL', digestSql: 'DIGEST_SQL' }],
    }
    const responses = new Map<string, unknown[]>([
      ['COUNT_SQL', [{ count: 1 }]],
      ['SAMPLE_SQL', [{ identifier: 'id-1' }]],
      ['DIGEST_SQL', [{ digest: 'abc123' }]],
    ])
    const { tx, calls } = makeFakeTx({ tableExistsMap: { t: true }, responses })
    const results = await readSideInvariants(tx, [inv], 'source', (t: string) => t, undefined)
    expect(results.get('inv-tier-b')).toEqual(
      expect.objectContaining({ checks: [expect.objectContaining({ violationCount: 1, samples: ['id-1'], digest: 'abc123' })] })
    )
    expect(calls.filter((c) => c === 'unsafe')).toHaveLength(3)
  })

  it('SQL実行中の例外はredactErrorを通してerrorとして記録され、他のinvariantは継続する', async () => {
    const invError: InvariantDef = {
      id: 'inv-error',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C1', tier: TIER_A, countSql: 'BAD_SQL', sampleSql: 'SAMPLE_SQL', digestSql: null }],
    }
    const invOk: InvariantDef = {
      id: 'inv-ok',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C2', tier: TIER_A, countSql: 'GOOD_SQL', sampleSql: 'SAMPLE_SQL', digestSql: null }],
    }
    const responses = new Map<string, unknown[]>([
      ['BAD_SQL', new Error('secret-password-in-error postgres://u:p@host/db') as unknown as unknown[]],
      ['GOOD_SQL', [{ count: 0 }]],
    ])
    const { tx } = makeFakeTx({ tableExistsMap: { t: true }, responses })
    const redactError = (text: string) => text.replace('secret-password-in-error postgres://u:p@host/db', '***REDACTED***')
    const results = await readSideInvariants(tx, [invError, invOk], 'source', redactError, undefined)
    expect(results.get('inv-error')).toEqual(expect.objectContaining({ error: expect.stringContaining('***REDACTED***') }))
    expect(results.get('inv-ok')).toEqual(expect.objectContaining({ tablesOk: true }))
  })

  it('onInvariantCheckedがside/invariantId/durationMsを伴って呼ばれる', async () => {
    const inv: InvariantDef = {
      id: 'inv-callback',
      description: 'd',
      requiredTables: ['t'],
      checks: [{ code: 'C1', tier: TIER_A, countSql: 'COUNT_SQL', sampleSql: 'SAMPLE_SQL', digestSql: null }],
    }
    const responses = new Map<string, unknown[]>([['COUNT_SQL', [{ count: 0 }]]])
    const { tx } = makeFakeTx({ tableExistsMap: { t: true }, responses })
    const calls: unknown[] = []
    await readSideInvariants(tx, [inv], 'target', (t: string) => t, (info) => calls.push(info))
    expect(calls).toEqual([expect.objectContaining({ side: 'target', invariantId: 'inv-callback', tablesOk: true })])
  })
})
