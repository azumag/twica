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
 * 全てを同時に積算するため、テーブルあたりの読み込みは1回で済む（列ごとのcanonical化も
 * `canonicalizeCell` を1回呼ぶだけで、checksum用の値とtimestamp最大値追跡の両方に使い回す。
 * Fableレビュー Major-3対応: 以前はtimestamp最大値追跡のために`canonicalizeTimestamp`を
 * 二重に呼んでいた）。
 *
 * 一貫性のスコープについて（Issue #697本文の前提を踏襲）:
 * source側・target側それぞれ、全テーブルを「1つの」`withReadOnlySnapshot`
 * トランザクション内で走査する（Layer 1と同じ `REPEATABLE READ READ ONLY`）。これにより
 * source側の25テーブル全てが同一スナップショットを見る（source内では強い一貫性）。
 * source/target間（2つの別接続・別トランザクション）では厳密な同時刻性は無いが、これは
 * Layer 2のコメントで説明した前提と同じ: 本layerはcutoverのwrite freeze期間中の実行を
 * 前提とする。source/target2つのトランザクションは互いに独立（別サーバーへの別接続）のため
 * `Promise.all`で並行実行する（Fableレビュー Minor対応: 以前は逐次実行しており、
 * write freeze時間を不必要に倍化させていた）。
 *
 * text系PK列のcollationについて（Fableレビュー Critical-1対応、重要）:
 * `ORDER BY`・keyset paginationの`WHERE`句がPK列のデフォルトcollationに依存すると、
 * source（Supabase）とtarget（PlanetScale）でサーバーのlocale設定
 * （`lc_collate`／glibc版・ICU差等）が異なる場合、**内容が完全に同一のデータでも
 * text型PK列（`blob_files.url`・`storage_usage.user_prefix`・
 * `channel_point_usage_stats`/`card_owner_stats`の`user_twitch_id`）の行順序が
 * source/targetで変わり、chunk境界がずれてchecksumが不一致になる**（偽陽性）。
 * これはPostgreSQL移行ツールの業界標準的な既知の落とし穴であり
 * （logical replication・pg_dump/restore後の差分検証ツールでも同種の問題が報告されている）、
 * 対策としてtext/varchar型のPK列には明示的に `COLLATE "C"`（バイト順比較、
 * ロケール非依存）を強制する。uuid等の非collatable型にCOLLATEを付けると構文エラーに
 * なるため、`dataType`がtext系の列にのみ適用する（`pkColumnExpr`参照）。
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
import { canonicalizeCell, hashChunk, hashChunkList } from './canonicalize.mjs'

/** `--chunk-size` 未指定時のデフォルト値（Issue #697本文「chunk sizeを指定可能」）。 */
export const DEFAULT_CHUNK_SIZE = 1000

/**
 * `--chunk-size` に指定可能な上限（Fableレビュー Minor対応）。上限を設けない場合、
 * 誤って巨大な値を指定するとテーブルの全行を1chunkとして一括保持してしまい、
 * メモリ枯渇のリスクがある。cli-args.mjsのparseChunkSizeがこの定数でバリデートする。
 */
export const MAX_CHUNK_SIZE = 100_000

const TIMESTAMP_DATA_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone'])

/** COLLATE "C" を強制する対象のdataType（text系。collatableな型のみ）。 */
const TEXT_LIKE_DATA_TYPES = new Set(['text', 'character varying'])

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
 * PK列1つ分のSQL式（識別子 + text系なら`COLLATE "C"`）を組み立てる純粋関数。
 * ファイル冒頭コメント「text系PK列のcollationについて」参照。
 * @param {{ name: string, dataType: string }} columnMeta
 * @returns {string}
 */
export function pkColumnExpr(columnMeta) {
  const quoted = quoteIdentifier(columnMeta.name)
  return TEXT_LIKE_DATA_TYPES.has(columnMeta.dataType) ? `${quoted} COLLATE "C"` : quoted
}

/**
 * テーブルが（接続先DBに）存在するかを確認する。
 * @param {import('postgres').Sql} tx
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
export async function tableExists(tx, tableName) {
  const [{ reg }] = await tx`select to_regclass(${'public.' + tableName}) as reg`
  return reg !== null
}

/**
 * 1chunk分の行を、keyset pagination（PK昇順COLLATE "C"固定、直前chunkの最終行のPK値より後ろ）
 * で取得する。
 * @param {import('postgres').Sql} tx
 * @param {string} quotedTable
 * @param {string[]} pkColumnExprs pkColumnExprで組み立て済みのSQL式（identifier + 必要ならCOLLATE）
 * @param {number} chunkSize
 * @param {unknown[] | null} lastPkValues 初回チャンクは null
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchChunk(tx, quotedTable, pkColumnExprs, chunkSize, lastPkValues) {
  const orderBy = pkColumnExprs.join(', ')
  const params = lastPkValues ? [...lastPkValues, chunkSize] : [chunkSize]
  const whereClause = lastPkValues
    ? `WHERE (${orderBy}) > (${pkColumnExprs.map((_, i) => `$${i + 1}`).join(', ')})`
    : ''
  const limitParamIndex = params.length
  const queryText = `SELECT * FROM ${quotedTable} ${whereClause} ORDER BY ${orderBy} LIMIT $${limitParamIndex}`
  return tx.unsafe(queryText, params)
}

/**
 * 1テーブルを1回スキャンし、Layer 3（件数・key range・timestamp最大値・nullカウント）と
 * Layer 4（chunkごとのcanonical checksum・table root hash）を同時に計算する。
 *
 * 列ごとの処理は1行につき1回のループ（`columns`を1回だけ走査）にまとめている
 * （Fableレビュー Major-3対応: 以前はcanonicalizeRow・timestamp最大値追跡・nullカウントの
 * 3つの独立したループがあり、timestamp列の値を2回canonicalizeしていた）。
 *
 * secret列をtimestamp最大値追跡から除外する理由（Fableレビュー Major-1対応、重要）:
 * `twitch_token_expires_at`のようなsecret指定のtimestamp列は、checksum計算では
 * `canonicalizeCell`がhash化して生値を出さないが、以前の実装は`maxTimestamps`の
 * 集計だけ別ループでsecret判定を見ずに生のtimestamp値を報告に含めてしまっていた
 * （「secret列の値をreportに出さない」という設計不変条件違反）。本実装は
 * `!col.isSecret`を1箇所でチェックし、secret列はtimestamp最大値追跡からも除外する。
 *
 * @param {import('postgres').Sql} tx
 * @param {{ tableName: string, primaryKeyColumns: string[], columns: Array<{name:string,dataType:string,isSecret:boolean}> }} tableSpec
 * @param {number} chunkSize
 */
export async function scanTable(tx, tableSpec, chunkSize) {
  const { tableName, primaryKeyColumns, columns } = tableSpec
  const quotedTable = quoteIdentifier(tableName)
  const columnsByName = new Map(columns.map((c) => [c.name, c]))
  const pkColumnMetas = primaryKeyColumns.map((name) => {
    const meta = columnsByName.get(name)
    if (!meta) throw new Error(`scanTable: primary key column '${name}' not found in table '${tableName}' catalog columns`)
    return meta
  })
  const pkColumnExprs = pkColumnMetas.map(pkColumnExpr)

  // Issue #697本文「null count等の重要列統計」: FK相当（`_id`で終わる）列を「重要列」として
  // 扱う。全列のnullカウントを取ると列数の多いテーブル（例: streamers 28列）でreportが
  // 肥大するため、Layer 5（業務invariant、次チャンク）が検証するorphan FK参照の事前観測として
  // 意味のある列に絞る。
  const maxTimestamps = Object.fromEntries(
    columns.filter((c) => TIMESTAMP_DATA_TYPES.has(c.dataType) && !c.isSecret).map((c) => [c.name, null])
  )
  const nullCounts = Object.fromEntries(columns.filter((c) => c.name.endsWith('_id')).map((c) => [c.name, 0]))

  const chunks = []
  let rowCount = 0
  let lastPkValues = null
  const startedAt = Date.now()

  for (;;) {
    const rows = await fetchChunk(tx, quotedTable, pkColumnExprs, chunkSize, lastPkValues)
    if (rows.length === 0) break

    const canonicalRows = []
    for (const row of rows) {
      const canonicalRow = []
      for (const col of columns) {
        const rawValue = row[col.name]
        const value = canonicalizeCell(rawValue, col)
        canonicalRow.push([col.name, value])
        // timestamp最大値追跡: canonicalizeCellが既にISO 8601 UTC文字列へ正規化済みのため、
        // 文字列比較のままchronological orderの比較として成立する（ISO 8601 UTCは
        // レキシコグラフィック順=時系列順になる性質を利用）。
        if (!col.isSecret && TIMESTAMP_DATA_TYPES.has(col.dataType) && value !== null) {
          if (maxTimestamps[col.name] === null || value > maxTimestamps[col.name]) maxTimestamps[col.name] = value
        }
        if (col.name.endsWith('_id') && rawValue === null) {
          nullCounts[col.name] += 1
        }
      }
      canonicalRows.push(canonicalRow)
    }

    chunks.push({
      index: chunks.length,
      startKey: primaryKeyColumns.map((col) => rows[0][col]),
      endKey: primaryKeyColumns.map((col) => rows[rows.length - 1][col]),
      hash: hashChunk(canonicalRows),
    })
    rowCount += rows.length

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
 * @param {'source' | 'target'} side ログ用のラベル（onTableScannedへ渡すのみ）
 * @param {((info: { side: string, table: string, rowCount: number, scanDurationMs: number }) => void) | undefined} onTableScanned
 * @returns {Promise<Map<string, { exists: boolean } & Partial<Awaited<ReturnType<typeof scanTable>>>>>}
 */
async function readSideTableData(tx, tableCatalog, chunkSize, side, onTableScanned) {
  const results = new Map()
  for (const tableSpec of tableCatalog) {
    const exists = await tableExists(tx, tableSpec.tableName)
    if (!exists) {
      results.set(tableSpec.tableName, { exists: false })
      continue
    }
    const scan = await scanTable(tx, tableSpec, chunkSize)
    results.set(tableSpec.tableName, { exists: true, ...scan })
    if (onTableScanned) {
      onTableScanned({ side, table: tableSpec.tableName, rowCount: scan.rowCount, scanDurationMs: scan.scanDurationMs })
    }
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
 * source/targetの走査は互いに独立した別接続・別トランザクションのため`Promise.all`で
 * 並行実行する（ファイル冒頭コメント参照。write freeze時間の短縮）。
 * @param {{
 *   sourceSql: import('postgres').Sql,
 *   targetSql: import('postgres').Sql,
 *   chunkSize?: number,
 *   tableCatalog?: ReturnType<typeof loadTableCatalog>,
 *   onTableScanned?: (info: { side: string, table: string, rowCount: number, scanDurationMs: number }) => void,
 * }} args
 */
export async function runDataLayer({ sourceSql, targetSql, chunkSize = DEFAULT_CHUNK_SIZE, tableCatalog, onTableScanned }) {
  const catalog = tableCatalog ?? loadTableCatalog()
  const [sourceResults, targetResults] = await Promise.all([
    withReadOnlySnapshot(sourceSql, (tx) => readSideTableData(tx, catalog, chunkSize, 'source', onTableScanned)),
    withReadOnlySnapshot(targetSql, (tx) => readSideTableData(tx, catalog, chunkSize, 'target', onTableScanned)),
  ])
  return evaluateDataLayer({ tableCatalog: catalog, sourceResults, targetResults, chunkSize })
}
