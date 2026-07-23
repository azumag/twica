import { describe, expect, it } from 'vitest'
import {
  CANARY_CHECK_IDS,
  buildFixtureIdentifiers,
  validateRowsShape,
  validateJsonbShape,
  verifyRollbackTraceless,
} from '../../../scripts/db-cutover/layer-canary.mjs'

/**
 * Issue #697 Chunk 4: layer-canary.mjs（Layer 6 runtime canary）の単体テスト。
 *
 * スコープについて（設計判断、意図的な線引き）: 本ファイルはDB接続を持たない純粋関数
 * （buildFixtureIdentifiers/validateRowsShape/validateJsonbShape）と、単純な問い合わせのみを
 * 行うverifyRollbackTracelessをfakeの`sql`タグ関数で検証する。runCanaryLayer自体の
 * フルオーケストレーション（savepoint隔離・fixtureセットアップ失敗時のskip伝播・
 * 6チェック全体の合成pass判定）は、postgres.jsのSAVEPOINT/トランザクション意味論を
 * 正確に模したfakeを用意するコストの割に実PostgreSQLでの検証以上の信頼性を持たない
 * （むしろfakeの不正確さが偽の安心感を生むリスクがある）と判断し、
 * tests/unit/db-cutover/docker-fault-injection.test.ts（実PG17、Docker opt-in）側で
 * E2E検証する設計とした（設計書テスト計画「Docker統合...SAVEPOINT隔離の実機検証」に
 * 対応）。この判断は最終報告で明示する。
 */

describe('CANARY_CHECK_IDS', () => {
  it('設計書の表と同じ6件・同じ順序', () => {
    expect(CANARY_CHECK_IDS).toEqual([
      'canary-dashboard-reads',
      'canary-gacha-rpc',
      'canary-updated-at-trigger',
      'canary-timestamp-shape',
      'canary-jsonb-array-parse',
      'canary-rollback-verification',
    ])
  })
})

describe('buildFixtureIdentifiers: fixture値生成（衝突回避形式）', () => {
  it('cutover-canary-<uuid>形式のstreamer/user識別子を生成する', () => {
    const identifiers = buildFixtureIdentifiers('11111111-1111-1111-1111-111111111111')
    expect(identifiers.streamerTwitchUserId).toBe('cutover-canary-11111111-1111-1111-1111-111111111111')
    expect(identifiers.userTwitchUserId).toBe('cutover-canary-11111111-1111-1111-1111-111111111111')
  })

  it('cutover-canary:<uuid>形式のevent_idを生成する（manual:プレフィックスの前例と同型）', () => {
    const identifiers = buildFixtureIdentifiers('22222222-2222-2222-2222-222222222222')
    expect(identifiers.eventId).toBe('cutover-canary:22222222-2222-2222-2222-222222222222')
  })

  it('非数字プレフィックスのため実際のTwitch数値IDと構造的に衝突しない', () => {
    const identifiers = buildFixtureIdentifiers('33333333-3333-3333-3333-333333333333')
    expect(/^[0-9]+$/.test(identifiers.streamerTwitchUserId)).toBe(false)
    expect(/^[0-9]+$/.test(identifiers.userTwitchUserId)).toBe(false)
  })

  it('異なるrunIdを渡せば異なる識別子になる（run毎の衝突回避）', () => {
    const a = buildFixtureIdentifiers('run-a')
    const b = buildFixtureIdentifiers('run-b')
    expect(a.streamerTwitchUserId).not.toBe(b.streamerTwitchUserId)
    expect(a.eventId).not.toBe(b.eventId)
  })

  it('runIdをそのまま含めて返す（呼び出し元がログ等で参照できるように）', () => {
    expect(buildFixtureIdentifiers('the-run-id').runId).toBe('the-run-id')
  })
})

describe('validateRowsShape: redaction規律を構造的に担保する純粋関数', () => {
  it('全行が期待型に一致すればok:true', () => {
    const rows = [{ id: 'uuid-1', active: true }]
    const result = validateRowsShape(rows, [
      { name: 'id', jsType: 'string', nullable: false },
      { name: 'active', jsType: 'boolean', nullable: false },
    ])
    expect(result).toEqual({ ok: true })
  })

  it('0行ならok:true（実データに依存しない設計、設計書「0行でも可」）', () => {
    expect(validateRowsShape([], [{ name: 'id', jsType: 'string', nullable: false }])).toEqual({ ok: true })
  })

  it('型不一致は列名・期待型・実際の型のみを返し、実際の値は含めない', () => {
    const rows = [{ secret_looking_value: 'super-secret-token-abc123' }]
    const result = validateRowsShape(rows, [{ name: 'secret_looking_value', jsType: 'number', nullable: false }])
    expect(result).toEqual({ ok: false, column: 'secret_looking_value', expectedType: 'number', actualType: 'string' })
    // redaction規律の直接確認: 戻り値のJSON化結果に元の値（'super-secret-token-abc123'）が
    // 一切含まれないこと。
    expect(JSON.stringify(result)).not.toContain('super-secret-token-abc123')
  })

  it('nullable:falseの列がnullだと期待型・actualType:nullを返す（値そのものは無い）', () => {
    const result = validateRowsShape([{ id: null }], [{ name: 'id', jsType: 'string', nullable: false }])
    expect(result).toEqual({ ok: false, column: 'id', expectedType: 'string', actualType: 'null' })
  })

  it('nullable:trueの列はnullを許容する', () => {
    expect(validateRowsShape([{ id: null }], [{ name: 'id', jsType: 'string', nullable: true }])).toEqual({ ok: true })
  })

  it('undefined（列がDBの実列に存在しない=schema drift）もnullと同様に扱う', () => {
    const result = validateRowsShape([{}], [{ name: 'missing_col', jsType: 'string', nullable: false }])
    expect(result).toEqual({ ok: false, column: 'missing_col', expectedType: 'string', actualType: 'undefined' })
  })

  it('jsType="date"はDateインスタンスかどうかで判定する（postgres.jsのtimestamptzデフォルト挙動に合わせる）', () => {
    expect(validateRowsShape([{ ts: new Date() }], [{ name: 'ts', jsType: 'date', nullable: false }])).toEqual({ ok: true })
    const result = validateRowsShape([{ ts: '2026-07-21T00:00:00.000Z' }], [{ name: 'ts', jsType: 'date', nullable: false }])
    expect(result).toEqual({ ok: false, column: 'ts', expectedType: 'date', actualType: 'string' })
  })

  it('複数行のうち後方の行に不一致があっても検出する', () => {
    const rows = [{ id: 'a' }, { id: 42 }]
    const result = validateRowsShape(rows, [{ name: 'id', jsType: 'string', nullable: false }])
    expect(result).toEqual({ ok: false, column: 'id', expectedType: 'string', actualType: 'number' })
  })
})

describe('validateJsonbShape: redaction規律を構造的に担保する純粋関数', () => {
  it('配列を期待しArray.isArrayならok:true', () => {
    expect(validateJsonbShape([], { kind: 'array' })).toEqual({ ok: true })
    expect(validateJsonbShape([1, 2, 3], { kind: 'array' })).toEqual({ ok: true })
  })

  it('配列を期待したがオブジェクトが返るとactualTypeのみ返す（値は含めない）', () => {
    const result = validateJsonbShape({ secret: 'value' }, { kind: 'array' })
    expect(result).toEqual({ ok: false, actualType: 'object' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('null/undefinedはactualType: "null"/"undefined"を返す', () => {
    expect(validateJsonbShape(null, { kind: 'array' })).toEqual({ ok: false, actualType: 'null' })
    expect(validateJsonbShape(undefined, { kind: 'object' })).toEqual({ ok: false, actualType: 'undefined' })
  })

  it('オブジェクトを期待し配列が返ると actualType: "array" を返す（Array.isArrayの罠を考慮）', () => {
    expect(validateJsonbShape([1, 2], { kind: 'object' })).toEqual({ ok: false, actualType: 'array' })
  })

  it('fieldsで指定した必須フィールドが揃い型も一致すればok:true', () => {
    const value = { total_draws: 10, card_stats: [], rarity_stats: [] }
    const result = validateJsonbShape(value, { kind: 'object', fields: { total_draws: 'number', card_stats: 'array', rarity_stats: 'array' } })
    expect(result).toEqual({ ok: true })
  })

  it('必須フィールドが欠けているとmissingFieldのみを返す', () => {
    const result = validateJsonbShape({ total_draws: 10 }, { kind: 'object', fields: { total_draws: 'number', card_stats: 'array' } })
    expect(result).toEqual({ ok: false, missingField: 'card_stats' })
  })

  it('フィールドの型が期待と異なるとfield/expectedKind/actualTypeのみを返す（値は含めない）', () => {
    const result = validateJsonbShape({ total: 'not-a-number' }, { kind: 'object', fields: { total: 'number' } })
    expect(result).toEqual({ ok: false, field: 'total', expectedKind: 'number', actualType: 'string' })
    expect(JSON.stringify(result)).not.toContain('not-a-number')
  })

  it('未知のspec.kindはfail-loudにthrowする', () => {
    expect(() => validateJsonbShape({}, { kind: 'weird' } as never)).toThrow(/unknown spec.kind/)
  })
})

/**
 * verifyRollbackTraceless（ROLLBACK後のトランザクション外からの痕跡ゼロ検証）のテスト。
 * fakeのタグ関数付きsqlは4回の独立したSELECTクエリ（streamers/users/gacha_history/cards）を
 * 呼び出し順に処理する。実SQLの内容自体は検証対象ではない（呼び出し元がどの列で検索するかは
 * 実装のコメントに委ねる）ため、fakeは「呼ばれた回数分だけ用意した行配列を順番に返す」という
 * 最小限の振る舞いのみを持つ。
 */
function makeFakeSelectSql(responses: unknown[][]) {
  let callIndex = 0
  const calls: string[] = []
  const sql = async (strings: TemplateStringsArray) => {
    calls.push(strings.raw.join('?'))
    const response = responses[callIndex] ?? []
    callIndex += 1
    return response
  }
  return { sql, calls }
}

describe('verifyRollbackTraceless', () => {
  const identifiers = {
    streamerTwitchUserId: 'cutover-canary-run-1',
    userTwitchUserId: 'cutover-canary-run-1',
    eventId: 'cutover-canary:run-1',
    cardId: '99999999-9999-9999-9999-999999999999',
  }

  it('全テーブルで0件なら空配列（findingなし）を返す', async () => {
    const { sql } = makeFakeSelectSql([[], [], [], []])
    const findings = await verifyRollbackTraceless(sql as never, identifiers)
    expect(findings).toEqual([])
  })

  it('streamers行が残存していればCANARY_ROLLBACK_TRACE_STREAMERSがfailで積まれる', async () => {
    const { sql } = makeFakeSelectSql([[{ id: 'leaked-streamer' }], [], [], []])
    const findings = await verifyRollbackTraceless(sql as never, identifiers)
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'fail', code: 'CANARY_ROLLBACK_TRACE_STREAMERS', side: 'target' }),
    ])
  })

  it('users/gacha_history/cardsそれぞれ独立にfindingを積む（4テーブル全て残存で4件）', async () => {
    const { sql } = makeFakeSelectSql([[{ id: 's' }], [{ id: 'u' }], [{ id: 'h' }], [{ id: 'c' }]])
    const findings = await verifyRollbackTraceless(sql as never, identifiers)
    expect(findings.map((f) => (f as { code: string }).code)).toEqual([
      'CANARY_ROLLBACK_TRACE_STREAMERS',
      'CANARY_ROLLBACK_TRACE_USERS',
      'CANARY_ROLLBACK_TRACE_GACHA_HISTORY',
      'CANARY_ROLLBACK_TRACE_CARDS',
    ])
  })

  it('cardId=null（fixtureセットアップ自体が失敗した場合）でも例外にならず0件として扱う', async () => {
    const { sql, calls } = makeFakeSelectSql([[], [], [], []])
    const findings = await verifyRollbackTraceless(sql as never, { ...identifiers, cardId: null })
    expect(findings).toEqual([])
    expect(calls).toHaveLength(4)
  })

  it('findingメッセージに復旧手順（DELETE/CASCADEの案内）を含む', async () => {
    const { sql } = makeFakeSelectSql([[{ id: 'leaked' }], [], [], []])
    const findings = await verifyRollbackTraceless(sql as never, identifiers)
    expect((findings[0] as { message: string }).message).toMatch(/DELETE/)
  })
})
