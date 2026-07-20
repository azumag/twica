import { describe, expect, it } from 'vitest'
import { evaluateDataLayer, quoteIdentifier, DEFAULT_CHUNK_SIZE } from '../../../scripts/db-cutover/layer-data.mjs'

/**
 * Issue #697 Chunk 2: layer-data.mjs（Layer 3件数/key range統計 + Layer 4 checksum）のテスト。
 *
 * evaluateDataLayer はDB接続を持たない純粋関数（layer-identity.mjsのevaluateIdentityLayerと
 * 同じ「pure decision + thin DB wrapper」流儀）のため、scanTableの戻り値を模したfixtureの
 * Mapを直接組み立ててテストできる（実DBでの検証はdocker-fault-injection.test.tsが担う）。
 */

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

describe('DEFAULT_CHUNK_SIZE', () => {
  it('正の整数である', () => {
    expect(Number.isInteger(DEFAULT_CHUNK_SIZE)).toBe(true)
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(0)
  })
})
