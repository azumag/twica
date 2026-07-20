import { describe, expect, it } from 'vitest'
import type { Sql } from 'postgres'
import {
  evaluateDataLayer,
  quoteIdentifier,
  pkColumnExpr,
  scanTable,
  tableExists,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
} from '../../../scripts/db-cutover/layer-data.mjs'
import { hashChunkList } from '../../../scripts/db-cutover/canonicalize.mjs'

/**
 * Issue #697 Chunk 2: layer-data.mjs（Layer 3件数/key range統計 + Layer 4 checksum）のテスト。
 *
 * evaluateDataLayer はDB接続を持たない純粋関数（layer-identity.mjsのevaluateIdentityLayerと
 * 同じ「pure decision + thin DB wrapper」流儀）のため、scanTableの戻り値を模したfixtureの
 * Mapを直接組み立ててテストできる（実DBでの検証はdocker-fault-injection.test.tsが担う）。
 *
 * scanTable（DB接続を要する関数）は、`tx.unsafe(queryText, params)`のみを呼ぶという
 * 薄いインターフェースに依存しているため、それだけを模したfake txでCI上でも
 * pagination境界条件を検証できる（Fableレビュー Major対応: 以前はDocker実機テスト
 * （opt-in、このサンドボックスでは実行不可）でしか検証されていなかった）。
 * fakeは実際の`Sql`型が持つ全プロパティを実装しないため、呼び出し箇所で`as unknown as Sql`
 * にキャストする（実装ではなく型の便宜上のキャストであることを明示するため`unknown`経由）。
 *
 * scanTableはカーソルベース（`DECLARE ... CURSOR` → `FETCH FORWARD N FROM ...` を
 * chunk数だけ繰り返す → `CLOSE ...`）でpaginationする（2回目のFableレビュー
 * Major-N1対応: COLLATE "C"強制によりPK indexが使えない場合でも全表スキャン+ソートを
 * 1回で済ませるため）。fake txはqueryTextの先頭が`FETCH`かどうかで応答を振り分ける
 * （`FETCH`以外＝DECLARE/CLOSEは行を返さない実際のPostgreSQL挙動を模す）。
 */
type MockCall = { queryText: string; params: unknown[] }

function makeMockTx(pages: Array<Array<Record<string, unknown>>>): Sql & { calls: MockCall[] } {
  const calls: MockCall[] = []
  let fetchIndex = 0
  const fake = {
    calls,
    unsafe: async (queryText: string, params: unknown[]) => {
      calls.push({ queryText, params })
      if (!queryText.trim().startsWith('FETCH')) return [] // DECLARE CURSOR / CLOSE
      const page = fetchIndex < pages.length ? pages[fetchIndex] : []
      fetchIndex += 1
      return page
    },
  }
  return fake as unknown as Sql & { calls: MockCall[] }
}

/**
 * `` tx`select ...` `` というタグ付きテンプレート呼び出しを模したfake tx（tableExists用）。
 * `tableExists`は`.unsafe()`ではなくタグ付きテンプレート形式でtxを呼ぶため、
 * `makeMockTx`とは別の形のfakeが必要。
 */
function makeMockTaggedTemplateTx(rows: Array<Record<string, unknown>>): Sql {
  const fake = async () => rows
  return fake as unknown as Sql
}

const catalog = [
  { tableName: 'widgets', primaryKeyColumns: ['id'], columns: [{ name: 'id', dataType: 'uuid', isSecret: false }] },
]

function makeScan(overrides: Partial<{ rowCount: number; chunks: Array<{ startKey: unknown[]; endKey: unknown[]; hash: string }>; rootHash: string }> = {}) {
  return {
    exists: true,
    rowCount: 0,
    minKey: null,
    maxKey: null,
    maxTimestamps: {},
    nullCounts: {},
    chunks: [],
    rootHash: 'empty-hash',
    scanDurationMs: 5,
    ...overrides,
  }
}

describe('evaluateDataLayer', () => {
  it('source/targetが完全一致すればpass', () => {
    const chunk = { startKey: ['1'], endKey: ['3'], hash: 'hash-a' }
    const scan = makeScan({ rowCount: 3, chunks: [chunk], rootHash: 'root-a' })
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', scan]]),
      targetResults: new Map([['widgets', scan]]),
      chunkSize: 100,
    })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.tables).toEqual([
      expect.objectContaining({ table: 'widgets', rowCountMatch: true, checksumMatch: true, mismatchedChunks: [] }),
    ])
  })

  it('テーブルがsource側に存在しない場合 DATA_TABLE_MISSING でfail（side=source）', () => {
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', { exists: false }]]),
      targetResults: new Map([['widgets', makeScan()]]),
      chunkSize: 100,
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ code: 'DATA_TABLE_MISSING', side: 'source' })])
  })

  it('テーブルがtarget側に存在しない場合 DATA_TABLE_MISSING でfail（side=target、Fableレビュー Minor対応: source側のみのテストしか無かった）', () => {
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', makeScan()]]),
      targetResults: new Map([['widgets', { exists: false }]]),
      chunkSize: 100,
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ code: 'DATA_TABLE_MISSING', side: 'target' })])
  })

  it('テーブルが双方に存在しない場合はside=both', () => {
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', { exists: false }]]),
      targetResults: new Map([['widgets', { exists: false }]]),
      chunkSize: 100,
    })
    expect(result.findings).toEqual([expect.objectContaining({ code: 'DATA_TABLE_MISSING', side: 'both' })])
  })

  it('行数が異なれば DATA_ROW_COUNT_MISMATCH でfail', () => {
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', makeScan({ rowCount: 3, rootHash: 'r' })]]),
      targetResults: new Map([['widgets', makeScan({ rowCount: 5, rootHash: 'r' })]]),
      chunkSize: 100,
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DATA_ROW_COUNT_MISMATCH', message: expect.stringContaining('source=3, target=5') })])
    )
  })

  it('同件数だがchecksumが異なれば DATA_CHECKSUM_MISMATCH でfail し、差分chunkを特定できる（Issue本文の代表的検知対象）', () => {
    const sourceChunks = [
      { startKey: ['1'], endKey: ['2'], hash: 'same' },
      { startKey: ['3'], endKey: ['4'], hash: 'differs-source' },
    ]
    const targetChunks = [
      { startKey: ['1'], endKey: ['2'], hash: 'same' },
      { startKey: ['3'], endKey: ['4'], hash: 'differs-target' },
    ]
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', makeScan({ rowCount: 4, chunks: sourceChunks, rootHash: 'root-source' })]]),
      targetResults: new Map([['widgets', makeScan({ rowCount: 4, chunks: targetChunks, rootHash: 'root-target' })]]),
      chunkSize: 2,
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DATA_CHECKSUM_MISMATCH', message: expect.stringContaining('1/2 chunk') })])
    )
    const table = result.tables[0]
    expect(table.mismatchedChunks).toEqual([
      expect.objectContaining({
        chunkIndex: 1,
        sourceKeyRange: { start: ['3'], end: ['4'] },
        targetKeyRange: { start: ['3'], end: ['4'] },
      }),
    ])
  })

  it('行数不一致の場合はchunk単位の差分特定を行わない（境界が対応しないため）', () => {
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([
        ['widgets', makeScan({ rowCount: 3, chunks: [{ startKey: ['1'], endKey: ['3'], hash: 'a' }], rootHash: 'root-a' })],
      ]),
      targetResults: new Map([
        ['widgets', makeScan({ rowCount: 4, chunks: [{ startKey: ['1'], endKey: ['4'], hash: 'b' }], rootHash: 'root-b' })],
      ]),
      chunkSize: 100,
    })
    const table = result.tables[0]
    expect(table.mismatchedChunks).toEqual([])
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DATA_CHECKSUM_MISMATCH', message: expect.stringContaining('行数不一致') })])
    )
  })

  it('report結果に内部専用のchunks配列（全chunkのhash等）を含めない（サマリのみ）', () => {
    const scan = makeScan({ rowCount: 1, chunks: [{ startKey: ['1'], endKey: ['1'], hash: 'h' }], rootHash: 'root' })
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', scan]]),
      targetResults: new Map([['widgets', scan]]),
      chunkSize: 100,
    })
    expect(result.tables[0].source).not.toHaveProperty('chunks')
    expect(result.tables[0].source?.chunkCount).toBe(1)
  })

  it('複数テーブルを扱い、それぞれ独立して判定する', () => {
    const twoTables = [
      { tableName: 'a', primaryKeyColumns: ['id'], columns: [] },
      { tableName: 'b', primaryKeyColumns: ['id'], columns: [] },
    ]
    const okScan = makeScan({ rowCount: 1, rootHash: 'ok' })
    const badScan = makeScan({ rowCount: 2, rootHash: 'bad' })
    const result = evaluateDataLayer({
      tableCatalog: twoTables,
      sourceResults: new Map([
        ['a', okScan],
        ['b', okScan],
      ]),
      targetResults: new Map([
        ['a', okScan],
        ['b', badScan],
      ]),
      chunkSize: 100,
    })
    expect(result.pass).toBe(false)
    expect(result.tables.find((t) => t.table === 'a')).toEqual(expect.objectContaining({ rowCountMatch: true }))
    expect(result.tables.find((t) => t.table === 'b')).toEqual(expect.objectContaining({ rowCountMatch: false }))
  })

  it('chunkSizeがreportに反映される', () => {
    const scan = makeScan({ rowCount: 0, rootHash: 'empty' })
    const result = evaluateDataLayer({
      tableCatalog: catalog,
      sourceResults: new Map([['widgets', scan]]),
      targetResults: new Map([['widgets', scan]]),
      chunkSize: 777,
    })
    expect(result.chunkSize).toBe(777)
  })
})

describe('quoteIdentifier', () => {
  it('英小文字・数字・アンダースコアのみの識別子はダブルクォートで囲む', () => {
    expect(quoteIdentifier('gacha_history')).toBe('"gacha_history"')
    expect(quoteIdentifier('id')).toBe('"id"')
    expect(quoteIdentifier('_leading_underscore')).toBe('"_leading_underscore"')
    expect(quoteIdentifier('col123')).toBe('"col123"')
  })

  it('想定外の文字（ダブルクォート・スペース・大文字等）を含む識別子は例外を投げる', () => {
    expect(() => quoteIdentifier('bad"name')).toThrow(/unexpected identifier shape/)
    expect(() => quoteIdentifier('bad name')).toThrow(/unexpected identifier shape/)
    expect(() => quoteIdentifier('BadName')).toThrow(/unexpected identifier shape/)
    expect(() => quoteIdentifier('1leading_digit')).toThrow(/unexpected identifier shape/)
    expect(() => quoteIdentifier('')).toThrow(/unexpected identifier shape/)
  })
})

describe('DEFAULT_CHUNK_SIZE / MAX_CHUNK_SIZE', () => {
  it('DEFAULT_CHUNK_SIZEは正の整数である', () => {
    expect(Number.isInteger(DEFAULT_CHUNK_SIZE)).toBe(true)
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(0)
  })

  it('MAX_CHUNK_SIZEはDEFAULT_CHUNK_SIZEより大きい正の整数である', () => {
    expect(Number.isInteger(MAX_CHUNK_SIZE)).toBe(true)
    expect(MAX_CHUNK_SIZE).toBeGreaterThan(DEFAULT_CHUNK_SIZE)
  })
})

describe('pkColumnExpr（Fableレビュー Critical-1対応: text系PK列のCOLLATE "C"強制）', () => {
  it('text型にはCOLLATE "C"を付与する', () => {
    expect(pkColumnExpr({ name: 'url', dataType: 'text' })).toBe('"url" COLLATE "C"')
  })

  it('character varying型（varchar）にもCOLLATE "C"を付与する', () => {
    expect(pkColumnExpr({ name: 'user_prefix', dataType: 'character varying' })).toBe('"user_prefix" COLLATE "C"')
  })

  it('uuid等のcollatableでない型にはCOLLATEを付与しない（付与すると構文エラーになるため）', () => {
    expect(pkColumnExpr({ name: 'id', dataType: 'uuid' })).toBe('"id"')
    expect(pkColumnExpr({ name: 'count', dataType: 'integer' })).toBe('"count"')
  })
})

describe('tableExists', () => {
  it('to_regclassがnullを返せばfalse（テーブル不存在）', async () => {
    const fakeTx = makeMockTaggedTemplateTx([{ reg: null }])
    expect(await tableExists(fakeTx, 'nonexistent_table')).toBe(false)
  })

  it('to_regclassが値を返せばtrue（テーブル存在）', async () => {
    const fakeTx = makeMockTaggedTemplateTx([{ reg: '16388' }])
    expect(await tableExists(fakeTx, 'cards')).toBe(true)
  })
})

describe('scanTable（fake txによるpagination境界条件のテスト、Fableレビュー Major-5対応）', () => {
  const simpleSpec = {
    tableName: 'widgets',
    primaryKeyColumns: ['id'],
    columns: [
      { name: 'id', dataType: 'uuid', isSecret: false },
      { name: 'name', dataType: 'text', isSecret: false },
    ],
  }

  it('空テーブルはDECLARE→FETCH(空)→CLOSEの3呼び出しだけで終わり、chunks=0件・決定的なrootHashになる', async () => {
    const tx = makeMockTx([[]])
    const result = await scanTable(tx, simpleSpec, 2)
    expect(result.rowCount).toBe(0)
    expect(result.chunks).toEqual([])
    expect(result.minKey).toBeNull()
    expect(result.maxKey).toBeNull()
    expect(result.rootHash).toBe(hashChunkList([]))
    expect(tx.calls).toHaveLength(3)
    expect(tx.calls[0].queryText).toMatch(/^DECLARE cutover_scan_cursor CURSOR FOR SELECT \* FROM "widgets" ORDER BY "id"$/)
    expect(tx.calls[1].queryText).toBe('FETCH FORWARD 2 FROM cutover_scan_cursor')
    expect(tx.calls[2].queryText).toBe('CLOSE cutover_scan_cursor')
  })

  it('単一行のテーブルは1chunkになる（DECLARE→FETCH(1行)→CLOSE、chunkSize未満なので追加fetchは発生しない）', async () => {
    const tx = makeMockTx([[{ id: 'a', name: 'A' }]])
    const result = await scanTable(tx, simpleSpec, 10)
    expect(result.rowCount).toBe(1)
    expect(result.chunks).toHaveLength(1)
    expect(result.minKey).toEqual(['a'])
    expect(result.maxKey).toEqual(['a'])
    expect(tx.calls).toHaveLength(3)
  })

  it('行数がchunkSizeの整数倍のとき、最後に空ページを1回追加fetchしてから終了する（余分なchunkは作らない）', async () => {
    const rows = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]
    const tx = makeMockTx([rows, []])
    const result = await scanTable(tx, simpleSpec, 2)
    expect(result.rowCount).toBe(2)
    expect(result.chunks).toHaveLength(1)
    // DECLARE + FETCH(2行) + FETCH(空) + CLOSE
    expect(tx.calls).toHaveLength(4)
    expect(tx.calls[3].queryText).toBe('CLOSE cutover_scan_cursor')
  })

  it('chunkSize=1で3行なら3chunkになり、FETCHをカーソル経由で3回+空判定1回繰り返す', async () => {
    const rows = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]
    const tx = makeMockTx([[rows[0]], [rows[1]], [rows[2]], []])
    const result = await scanTable(tx, simpleSpec, 1)
    expect(result.chunks).toHaveLength(3)
    expect(result.rowCount).toBe(3)
    // DECLARE + FETCH*4（3回分の行 + 最後の空判定） + CLOSE
    expect(tx.calls).toHaveLength(6)
    expect(tx.calls.filter((c) => c.queryText.startsWith('FETCH'))).toHaveLength(4)
    for (const call of tx.calls.filter((c) => c.queryText.startsWith('FETCH'))) {
      expect(call.queryText).toBe('FETCH FORWARD 1 FROM cutover_scan_cursor')
    }
  })

  it('複合PKでCOLLATE付きのDECLARE文が1回だけ生成される（keysetのWHERE句は不要になった）', async () => {
    const compositeSpec = {
      tableName: 'links',
      primaryKeyColumns: ['a_id', 'b_id'],
      columns: [
        { name: 'a_id', dataType: 'uuid', isSecret: false },
        { name: 'b_id', dataType: 'text', isSecret: false },
      ],
    }
    const tx = makeMockTx([[{ a_id: 'u1', b_id: 'x' }], []])
    await scanTable(tx, compositeSpec, 1)
    expect(tx.calls[0].queryText).toBe('DECLARE cutover_scan_cursor CURSOR FOR SELECT * FROM "links" ORDER BY "a_id", "b_id" COLLATE "C"')
    expect(tx.calls.filter((c) => c.queryText.includes('WHERE'))).toHaveLength(0)
  })

  it('chunkSizeが正の整数でなければfail-loudに例外を投げる（SQL文字列へ直接埋め込むため、Fableレビュー Major-N1対応）', async () => {
    const tx = makeMockTx([[]])
    await expect(scanTable(tx, simpleSpec, 0)).rejects.toThrow(/positive integer/)
    await expect(scanTable(tx, simpleSpec, 1.5)).rejects.toThrow(/positive integer/)
    await expect(scanTable(tx, simpleSpec, Number.NaN)).rejects.toThrow(/positive integer/)
  })

  it('スキャン中に例外が起きた場合はCLOSEを試みず、根本原因の例外をそのまま伝播する（3回目のFableレビュー Minor-P1対応: 実DBではabortedトランザクション中のCLOSE自体が失敗し例外を上書きしうるため）', async () => {
    // 実DBでは、走査中の例外でトランザクションがaborted状態になった後にCLOSEを試みると
    // `25P02: current transaction is aborted`で失敗する。このfake txはその状況を模し、
    // CLOSEが呼ばれたら（呼ばれること自体がP-1の回帰）別のエラーを投げるようにしてある。
    const badTimestampSpec = {
      tableName: 'widgets',
      primaryKeyColumns: ['id'],
      columns: [
        { name: 'id', dataType: 'uuid', isSecret: false },
        { name: 'created_at', dataType: 'timestamp with time zone', isSecret: false },
      ],
    }
    const calls: MockCall[] = []
    const tx = {
      unsafe: async (queryText: string, params: unknown[]) => {
        calls.push({ queryText, params })
        if (queryText.trim().startsWith('CLOSE')) {
          throw new Error('25P02: current transaction is aborted (simulated)')
        }
        if (queryText.trim().startsWith('FETCH')) {
          return [{ id: 'a', created_at: 'not-a-valid-timestamp' }]
        }
        return []
      },
    } as unknown as Sql

    await expect(scanTable(tx, badTimestampSpec, 10)).rejects.toThrow(/invalid timestamp/)
    // CLOSEが実際に呼ばれていないこと（呼ばれていたら、上のrejects.toThrowは
    // simulated CLOSE失敗の方のメッセージにすり替わってテストが失敗するはずだが、
    // 呼び出し自体が発生していないことも明示的に確認する）。
    expect(calls.some((c) => c.queryText.startsWith('CLOSE'))).toBe(false)
  })

  it('secret指定のtimestamp列はmaxTimestampsから除外される（Fableレビュー Major-1対応、生値をreportへ出さない）', async () => {
    const spec = {
      tableName: 'users',
      primaryKeyColumns: ['id'],
      columns: [
        { name: 'id', dataType: 'uuid', isSecret: false },
        { name: 'created_at', dataType: 'timestamp with time zone', isSecret: false },
        { name: 'twitch_token_expires_at', dataType: 'timestamp with time zone', isSecret: true },
      ],
    }
    const rows = [
      {
        id: 'u1',
        created_at: new Date('2026-01-01T00:00:00Z'),
        twitch_token_expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    ]
    const tx = makeMockTx([rows, []])
    const result = await scanTable(tx, spec, 10)
    expect(result.maxTimestamps).toEqual({ created_at: '2026-01-01T00:00:00.000Z' })
    expect(result.maxTimestamps).not.toHaveProperty('twitch_token_expires_at')
    // 生値がreport（scanTableの戻り値全体）のどこにも文字列として出現しないこと。
    expect(JSON.stringify(result)).not.toContain('2099-01-01')
  })

  it('_id列のnullカウントを行ごとに積算する', async () => {
    const spec = {
      tableName: 'user_cards',
      primaryKeyColumns: ['id'],
      columns: [
        { name: 'id', dataType: 'uuid', isSecret: false },
        { name: 'card_id', dataType: 'uuid', isSecret: false },
      ],
    }
    const rows = [
      { id: '1', card_id: 'c1' },
      { id: '2', card_id: null },
      { id: '3', card_id: null },
    ]
    const tx = makeMockTx([rows, []])
    const result = await scanTable(tx, spec, 10)
    expect(result.nullCounts).toEqual({ card_id: 2 })
  })
})
