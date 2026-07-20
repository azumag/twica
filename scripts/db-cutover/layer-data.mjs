#!/usr/bin/env node

/**
 * Layer 3（件数/key range統計）+ Layer 4（deterministic data checksum） / Issue #697 Chunk 2
 *
 * Issue #697本文はLayer 3とLayer 4を別々の節で説明しているが、両方とも「テーブルを1回
 * 走査して統計を取る」という同じ作業から得られる情報であるため、本ファイルは1回の
 * 全行スキャンで両方の値を同時に計算する（`scanTable`）。CLIの `--layers` 上でもこの2つは
 * 分離せず、単一の `data` layer として提供する（`cli-args.mjs` の KNOWN_FUTURE_LAYERS に
 * 元々 `data` という単一の名前で予約されていたことと整合させた）。
 *
 * 「1テーブルにつき1回の全表scanで済ませる」設計にした理由:
 * Layer 3（件数・key range・timestamp最大値・nullカウント）だけを別クエリで集計しようとすると、
 * `count(*)`・`min/max`・`count(*) filter (...)` 等の集計クエリでテーブルを1回読み、
 * Layer 4（checksum）でchunkごとに全行を取得してさらにもう1回読む、という二重読み込みになる。
 * 本実装はchunkを取得するSELECTの結果からrow count・key range・timestamp最大値・null数の
 * 全てを同時に積算するため、テーブルあたりの読み込みは1回で済む。
 *
 * 一貫性のスコープについて（Issue #697本文の前提を踏襲）:
 * source側・target側それぞれ、全テーブルを「1つの」`withReadOnlySnapshot`
 * トランザクション内で走査する（Layer 1と同じ `REPEATABLE READ READ ONLY`）。これにより
 * source側の25テーブル全てが同一スナップショットを見る（source内では強い一貫性）。
 * source/target間（2つの別接続・別トランザクション）では厳密な同時刻性は無いが、これは
 * Layer 2のコメントで説明した前提と同じ: 本layerはcutoverのwrite freeze期間中の実行を
 * 前提とする。
 *
 * chunk単位の差分特定について（既知の限界、意図的な単純化）:
 * chunkはoffsetではなくkeyset（PK昇順の「次のchunkSize件」）で区切るため、境界は常に
 * 「ソート順でi番目のブロック」という位置ベースになる。行数が一致していれば、ある1行が
 * 同じ位置で値だけ変わった（＝Issue #697本文の代表的な検知対象「同件数だが異なるrow」）場合、
 * その行を含むchunkだけが不一致になり正しく局所化できる。一方、行数は変わらないが
 * 「途中の1行が削除され、末尾に別の1行が挿入された」ような構成変化が起きた場合、
 * 削除位置以降の全chunkが玉突き的に不一致となり、実際に異なる内容は僅かでも
 * 「以降の全chunkが差分」と報告されうる。これはposition-basedなchunk分割の既知の限界であり、
 * Issue #697本文が要求するのは「差分chunkを特定できる」ことであって「差分1行そのものを
 * 一意特定する」ことではないため、許容している（真の行単位diffが必要な場合は、報告された
 * key range内で運用者が個別に調査する）。
 */

'use strict'

import { withReadOnlySnapshot } from './snapshot.mjs'
import { loadTableCatalog } from './table-catalog.mjs'
import { canonicalizeRow, canonicalizeTimestamp, hashChunk, hashChunkList } from './canonicalize.mjs'

/** `--chunk-size` 未指定時のデフォルト値（Issue #697本文「chunk sizeを指定可能」）。 */
export const DEFAULT_CHUNK_SIZE = 1000

const TIMESTAMP_DATA_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone'])

/**
 * SQL識別子（テーブル名・列名）を安全にダブルクォートで囲む。テーブル名・列名は
 * schema.tsの静的パース結果のみに由来する（実行時のユーザー入力は経由しない）ため
 * インジェクションの実害は無いはずだが、想定外の文字（schema.tsの将来的なスタイル変更等）が
 * 紛れ込んだ場合に無警告でSQL構文が壊れる/意図しないクエリになる事故を防ぐため、
 * 想定する識別子の形（英小文字・数字・アンダースコアのみ、先頭は英字かアンダースコア）
 * 以外はfail-loudにエラーとする。
 * @param {string} name
 * @returns {string}
 */
export function quoteIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`quoteIdentifier: unexpected identifier shape (possible schema drift): ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

/**
 * テーブルが（接続先DBに）存在するかを確認する。
 * @param {import('postgres').Sql} tx
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
async function tableExists(tx, tableName) {
  const [{ reg }] = await tx`select to_regclass(${'public.' + tableName}) as reg`
  return reg !== null
}

/**
 * 1chunk分の行を、keyset pagination（PK昇順、直前chunkの最終行のPK値より後ろ）で取得する。
 * @param {import('postgres').Sql} tx
 * @param {string} quotedTable
 * @param {string} orderByClause
 * @param {string[]} primaryKeyColumns
 * @param {number} chunkSize
 * @param {unknown[] | null} lastPkValues 初回チャンクは null
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchChunk(tx, quotedTable, orderByClause, primaryKeyColumns, chunkSize, lastPkValues) {
  const params = lastPkValues ? [...lastPkValues, chunkSize] : [chunkSize]
  const whereClause = lastPkValues
    ? `WHERE (${primaryKeyColumns.map(quoteIdentifier).join(', ')}) > (${primaryKeyColumns.map((_, i) => `$${i + 1}`).join(', ')})`
    : ''
  const limitParamIndex = params.length
  const queryText = `SELECT * FROM ${quotedTable} ${whereClause} ORDER BY ${orderByClause} LIMIT $${limitParamIndex}`
  return tx.unsafe(queryText, params)
}

/**
 * 1テーブルを1回スキャンし、Layer 3（件数・key range・timestamp最大値・nullカウント）と
 * Layer 4（chunkごとのcanonical checksum・table root hash）を同時に計算する。
 * @param {import('postgres').Sql} tx
 * @param {{ tableName: string, primaryKeyColumns: string[], columns: Array<{name:string,dataType:string,isSecret:boolean}> }} tableSpec
 * @param {number} chunkSize
 */
async function scanTable(tx, tableSpec, chunkSize) {
  const { tableName, primaryKeyColumns, columns } = tableSpec
  const quotedTable = quoteIdentifier(tableName)
  const orderByClause = primaryKeyColumns.map(quoteIdentifier).join(', ')
  const timestampColumns = columns.filter((c) => TIMESTAMP_DATA_TYPES.has(c.dataType))
  // Issue #697本文「null count等の重要列統計」: FK相当（`_id`で終わる）列を「重要列」として
  // 扱う。全列のnullカウントを取ると列数の多いテーブル（例: streamers 28列）でreportが
  // 肥大するため、Layer 5（業務invariant、次チャンク）が検証するorphan FK参照の事前観測として
  // 意味のある列に絞る。
  const idColumns = columns.filter((c) => c.name.endsWith('_id'))

  const maxTimestamps = Object.fromEntries(timestampColumns.map((c) => [c.name, null]))
  const nullCounts = Object.fromEntries(idColumns.map((c) => [c.name, 0]))

  const chunks = []
  let rowCount = 0
  let lastPkValues = null
  const startedAt = Date.now()

  for (;;) {
    const rows = await fetchChunk(tx, quotedTable, orderByClause, primaryKeyColumns, chunkSize, lastPkValues)
    if (rows.length === 0) break

    const canonicalRows = rows.map((row) => canonicalizeRow(row, columns))
    chunks.push({
      index: chunks.length,
      startKey: primaryKeyColumns.map((col) => rows[0][col]),
      endKey: primaryKeyColumns.map((col) => rows[rows.length - 1][col]),
      hash: hashChunk(canonicalRows),
    })
    rowCount += rows.length

    for (const col of timestampColumns) {
      for (const row of rows) {
        const value = canonicalizeTimestamp(row[col.name])
        if (value !== null && (maxTimestamps[col.name] === null || value > maxTimestamps[col.name])) {
          maxTimestamps[col.name] = value
        }
      }
    }
    for (const col of idColumns) {
      for (const row of rows) {
        if (row[col.name] === null) nullCounts[col.name] += 1
      }
    }

    const lastRow = rows[rows.length - 1]
    lastPkValues = primaryKeyColumns.map((col) => lastRow[col])
    if (rows.length < chunkSize) break
  }

  return {
    rowCount,
    minKey: chunks.length > 0 ? chunks[0].startKey : null,
    maxKey: chunks.length > 0 ? chunks[chunks.length - 1].endKey : null,
    maxTimestamps,
    nullCounts,
    chunks,
    rootHash: hashChunkList(chunks.map((c) => c.hash)),
    scanDurationMs: Date.now() - startedAt,
  }
}

/**
 * source または target 1接続分、catalog内の全テーブルを走査する（DB接続あり）。
 * @param {import('postgres').Sql} tx
 * @param {ReturnType<typeof loadTableCatalog>} tableCatalog
 * @param {number} chunkSize
 * @returns {Promise<Map<string, { exists: boolean } & Partial<Awaited<ReturnType<typeof scanTable>>>>>}
 */
async function readSideTableData(tx, tableCatalog, chunkSize) {
  const results = new Map()
  for (const tableSpec of tableCatalog) {
    const exists = await tableExists(tx, tableSpec.tableName)
    if (!exists) {
      results.set(tableSpec.tableName, { exists: false })
      continue
    }
    const scan = await scanTable(tx, tableSpec, chunkSize)
    results.set(tableSpec.tableName, { exists: true, ...scan })
  }
  return results
}

/** report用に、内部専用の`chunks`配列（全chunkのhash・key range）を除いたサマリへ変換する。 */
function summarizeTableScan(scan) {
  return {
    rowCount: scan.rowCount,
    minKey: scan.minKey,
    maxKey: scan.maxKey,
    maxTimestamps: scan.maxTimestamps,
    nullCounts: scan.nullCounts,
    rootHash: scan.rootHash,
    chunkCount: scan.chunks.length,
    scanDurationMs: scan.scanDurationMs,
  }
}

/**
 * @typedef {{
 *   rowCount: number,
 *   minKey: unknown[] | null,
 *   maxKey: unknown[] | null,
 *   maxTimestamps: Record<string, string | null>,
 *   nullCounts: Record<string, number>,
 *   rootHash: string,
 *   chunkCount: number,
 *   scanDurationMs: number,
 * }} TableScanSummary
 *
 * @typedef {{
 *   table: string,
 *   sourceExists: boolean,
 *   targetExists: boolean,
 *   source?: TableScanSummary,
 *   target?: TableScanSummary,
 *   rowCountMatch?: boolean,
 *   checksumMatch?: boolean,
 *   mismatchedChunks?: Array<{
 *     chunkIndex: number,
 *     sourceKeyRange: { start: unknown[], end: unknown[] },
 *     targetKeyRange: { start: unknown[], end: unknown[] },
 *   }>,
 * }} DataLayerTableResult
 */

/**
 * Layer 3+4 の判定ロジック本体（純粋関数、DB接続なし）。
 * @param {{
 *   tableCatalog: ReturnType<typeof loadTableCatalog>,
 *   sourceResults: Map<string, object>,
 *   targetResults: Map<string, object>,
 *   chunkSize: number,
 * }} args
 * @returns {{
 *   layer: 'data',
 *   pass: boolean,
 *   findings: Array<{ severity: string, code: string, message: string, side: string }>,
 *   chunkSize: number,
 *   tables: DataLayerTableResult[],
 * }}
 */
export function evaluateDataLayer({ tableCatalog, sourceResults, targetResults, chunkSize }) {
  const findings = []
  const tables = []

  for (const tableSpec of tableCatalog) {
    const name = tableSpec.tableName
    const s = sourceResults.get(name)
    const t = targetResults.get(name)
    if (!s || !t) {
      throw new Error(`evaluateDataLayer: missing scan result for table '${name}' (internal wiring error)`)
    }

    if (!s.exists || !t.exists) {
      const side = !s.exists && !t.exists ? 'both' : !s.exists ? 'source' : 'target'
      findings.push({
        severity: 'fail',
        code: 'DATA_TABLE_MISSING',
        message: `${name}: テーブルが${side === 'both' ? 'source/target双方' : side === 'source' ? 'source' : 'target'}に存在しません。`,
        side,
      })
      tables.push({ table: name, sourceExists: s.exists, targetExists: t.exists })
      continue
    }

    const rowCountMatch = s.rowCount === t.rowCount
    if (!rowCountMatch) {
      findings.push({
        severity: 'fail',
        code: 'DATA_ROW_COUNT_MISMATCH',
        message: `${name}: 行数が一致しません（source=${s.rowCount}, target=${t.rowCount}）`,
        side: 'both',
      })
    }

    const checksumMatch = s.rootHash === t.rootHash
    const mismatchedChunks = []
    if (!checksumMatch) {
      if (rowCountMatch) {
        for (let i = 0; i < s.chunks.length; i++) {
          if (s.chunks[i].hash !== t.chunks[i].hash) {
            mismatchedChunks.push({
              chunkIndex: i,
              sourceKeyRange: { start: s.chunks[i].startKey, end: s.chunks[i].endKey },
              targetKeyRange: { start: t.chunks[i].startKey, end: t.chunks[i].endKey },
            })
          }
        }
      }
      findings.push({
        severity: 'fail',
        code: 'DATA_CHECKSUM_MISMATCH',
        message: rowCountMatch
          ? `${name}: root hashが一致しません（${mismatchedChunks.length}/${s.chunks.length} chunkで差分検出）`
          : `${name}: root hashが一致しません（行数不一致のためchunk単位の差分特定は行っていません。DATA_ROW_COUNT_MISMATCHを参照）`,
        side: 'both',
      })
    }

    tables.push({
      table: name,
      sourceExists: true,
      targetExists: true,
      source: summarizeTableScan(s),
      target: summarizeTableScan(t),
      rowCountMatch,
      checksumMatch,
      mismatchedChunks,
    })
  }

  return { layer: 'data', pass: findings.length === 0, findings, chunkSize, tables }
}

/**
 * Layer 3+4 本体（DB接続あり）。source/targetそれぞれのtable catalog全体を
 * withReadOnlySnapshot経由で走査し、evaluateDataLayer（純粋関数）へ委譲する。
 * @param {{
 *   sourceSql: import('postgres').Sql,
 *   targetSql: import('postgres').Sql,
 *   chunkSize?: number,
 *   tableCatalog?: ReturnType<typeof loadTableCatalog>,
 * }} args
 */
export async function runDataLayer({ sourceSql, targetSql, chunkSize = DEFAULT_CHUNK_SIZE, tableCatalog }) {
  const catalog = tableCatalog ?? loadTableCatalog()
  const sourceResults = await withReadOnlySnapshot(sourceSql, (tx) => readSideTableData(tx, catalog, chunkSize))
  const targetResults = await withReadOnlySnapshot(targetSql, (tx) => readSideTableData(tx, catalog, chunkSize))
  return evaluateDataLayer({ tableCatalog: catalog, sourceResults, targetResults, chunkSize })
}
