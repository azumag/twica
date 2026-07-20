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
 * `ORDER BY`がPK列のデフォルトcollationに依存すると、source（Supabase）とtarget
 * （PlanetScale）でサーバーのlocale設定（`lc_collate`／glibc版・ICU差等）が異なる場合、
 * **内容が完全に同一のデータでもtext型PK列（`blob_files.url`・`storage_usage.user_prefix`・
 * `channel_point_usage_stats`/`card_owner_stats`の`user_twitch_id`）の行順序が
 * source/targetで変わり、chunk境界がずれてchecksumが不一致になる**（偽陽性）。
 * これはPostgreSQL移行ツールの業界標準的な既知の落とし穴であり
 * （logical replication・pg_dump/restore後の差分検証ツールでも同種の問題が報告されている）、
 * 対策としてtext/varchar型のPK列には明示的に `COLLATE "C"`（バイト順比較、
 * ロケール非依存）を強制する。uuid等の非collatable型にCOLLATEを付けると構文エラーに
 * なるため、`dataType`がtext系の列にのみ適用する（`pkColumnExpr`参照）。
 *
 * カーソルベースのpaginationを採用する理由（2回目のFableレビュー Major-N1対応、重要）:
 * 当初はkeyset pagination（`WHERE (pk...) > ($1...) ORDER BY pk... LIMIT $N`）を
 * chunkごとに再実行していたが、上記の`COLLATE "C"`強制と組み合わせると重大な性能問題が
 * 露見した。PK制約が作る一意indexは列のデフォルトcollationで構築されているため、
 * クエリ側で`COLLATE "C"`を指定するとPlannerはそのindexを使えず、
 * 毎回「全表シーケンシャルスキャン + ソート」を行うことをEXPLAINで実機確認した
 * （`text`型PKを持つtableでは、chunk数だけ全表走査が繰り返されるO(N²/chunkSize)の
 * 性能劣化になり、cutoverのwrite freeze時間を不必要に延伸させるリスクがあった）。
 * 対策として、1テーブルにつき`DECLARE ... CURSOR FOR SELECT * FROM ... ORDER BY ...`で
 * ソートを1回だけ実行し、`FETCH FORWARD chunkSize FROM ...`でchunkを取り出す方式へ変更した。
 * カーソルは最初の`DECLARE`時点で実行計画（Sort等）を確定させ、以降の`FETCH`はその結果を
 * 順番に読み進めるだけなので、`COLLATE "C"`でindexが使えない場合でも全表スキャン+ソートは
 * 1回で済む（実機のEXPLAINで`Seq Scan` + `Sort`が1回だけ現れることを確認済み）。
 * カーソルはトランザクションスコープ（`WITHOUT HOLD`が既定）のため、`withReadOnlySnapshot`の
 * トランザクション内で開いて使い切り、最後に`CLOSE`する（例外時もfinallyで確実にCLOSEする。
 * 万一CLOSEし忘れても`withReadOnlySnapshot`は必ずROLLBACKするため、カーソル自体はロールバックで
 * 破棄される）。`FETCH FORWARD`の件数はPostgreSQLの文法上バインドパラメータを取れない
 * （リテラル整数のみ、実機で`syntax error at or near "$1"`を確認済み）ため、
 * 事前にCLI側（cli-args.mjsのparseChunkSize、1〜MAX_CHUNK_SIZE）でバリデート済みの
 * `chunkSize`をSQL文字列へ直接埋め込む（追加の防御として`scanTable`自身も整数であることを
 * 再検証する。詳細は`scanTable`のコメント参照）。
 * このカーソル方式への変更により、keyset用の`WHERE`句・前chunk最終行のPK値追跡が丸ごと
 * 不要になり、pagination自体のロジックも単純化された。
 *
 * chunk単位の差分特定について（既知の限界、意図的な単純化）:
 * chunkは「ソート順でi番目のブロック」という位置ベースになる。行数が一致していれば、
 * ある1行が同じ位置で値だけ変わった（＝Issue #697本文の代表的な検知対象「同件数だが
 * 異なるrow」）場合、その行を含むchunkだけが不一致になり正しく局所化できる。一方、
 * 行数は変わらないが「途中の1行が削除され、末尾に別の1行が挿入された」ような構成変化が
 * 起きた場合、削除位置以降の全chunkが玉突き的に不一致となり、実際に異なる内容は僅かでも
 * 「以降の全chunkが差分」と報告されうる。これはposition-basedなchunk分割の既知の限界であり、
 * Issue #697本文が要求するのは「差分chunkを特定できる」ことであって「差分1行そのものを
 * 一意特定する」ことではないため、許容している（真の行単位diffが必要な場合は、報告された
 * key range内で運用者が個別に調査する）。
 */

'use strict'

import { withReadOnlySnapshot } from './snapshot.mjs'
import { loadTableCatalog } from './table-catalog.mjs'
import { canonicalizeRow, hashChunk, hashChunkList } from './canonicalize.mjs'

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
 * 全テーブル共通で使うカーソル名。`scanTable`は1テーブルごとにDECLARE→FETCH*→CLOSEを
 * 完結させてから次のテーブルへ進む（`readSideTableData`の逐次forループ）ため、
 * 同一接続内で複数カーソルが同時に存在することは無く、固定名で問題ない。
 */
const SCAN_CURSOR_NAME = 'cutover_scan_cursor'

/**
 * 1テーブルを1回スキャンし、Layer 3（件数・key range・timestamp最大値・nullカウント）と
 * Layer 4（chunkごとのcanonical checksum・table root hash）を同時に計算する。
 *
 * カーソルベースのpaginationについて: `DECLARE ... CURSOR FOR SELECT * FROM ... ORDER BY ...`で
 * ソート済み結果集合を1回だけ確定させ、`FETCH FORWARD chunkSize FROM ...`でchunkを
 * 順に取り出す（ファイル冒頭コメント「カーソルベースのpaginationを採用する理由」参照。
 * `COLLATE "C"`強制によりPK indexが使えない場合でも、全表スキャン+ソートが1回で済む）。
 *
 * `canonicalizeRow`（canonicalize.mjs、単体テスト対象）をそのまま呼び出し、そこから
 * timestamp最大値・nullカウントを導出する（2回目のFableレビュー Minor-N2対応:
 * 以前はscanTable内で同じロジックを独自にインライン実装しており、単体テストが検証する
 * canonicalizeRowと実際にscanTableが使う経路が別物になっていた）。列の並び順は
 * `columns`と`canonicalizeRow`の戻り値で1対1対応するため、timestamp/id列のインデックスを
 * 事前計算して使い回す。
 *
 * @param {import('postgres').Sql} tx
 * @param {{ tableName: string, primaryKeyColumns: string[], columns: Array<{name:string,dataType:string,isSecret:boolean}> }} tableSpec
 * @param {number} chunkSize 1〜MAX_CHUNK_SIZEの整数であること（呼び出し側でバリデート済みの
 *   前提だが、SQL文字列へ直接埋め込む値のため本関数でも再検証する。下記参照）
 */
export async function scanTable(tx, tableSpec, chunkSize) {
  // `FETCH FORWARD <count> FROM cursor` はPostgreSQLの文法上バインドパラメータを取れず
  // （実機で`syntax error at or near "$1"`を確認済み）、chunkSizeをSQL文字列へ直接埋め込む
  // 必要がある。呼び出し元（cli-args.mjsのparseChunkSize）は既に検証済みだが、
  // scanTableを直接呼ぶ経路（テスト・将来の呼び出し元）でも安全側に倒すため、
  // ここでも整数であることをfail-loudに再検証する。
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`scanTable: chunkSize must be a positive integer, got ${JSON.stringify(chunkSize)}`)
  }

  const { tableName, primaryKeyColumns, columns } = tableSpec
  const quotedTable = quoteIdentifier(tableName)
  const columnsByName = new Map(columns.map((c) => [c.name, c]))
  const pkColumnMetas = primaryKeyColumns.map((name) => {
    const meta = columnsByName.get(name)
    if (!meta) throw new Error(`scanTable: primary key column '${name}' not found in table '${tableName}' catalog columns`)
    return meta
  })
  const orderBy = pkColumnMetas.map(pkColumnExpr).join(', ')

  // Issue #697本文「null count等の重要列統計」: FK相当（`_id`で終わる）列を「重要列」として
  // 扱う。全列のnullカウントを取ると列数の多いテーブル（例: streamers 28列）でreportが
  // 肥大するため、Layer 5（業務invariant、次チャンク）が検証するorphan FK参照の事前観測として
  // 意味のある列に絞る。secret列のtimestamp最大値追跡除外（Fableレビュー Major-1対応）は
  // ここでの`!c.isSecret`フィルタで行う。
  const timestampIndices = []
  const idIndices = []
  columns.forEach((c, index) => {
    if (!c.isSecret && TIMESTAMP_DATA_TYPES.has(c.dataType)) timestampIndices.push({ index, name: c.name })
    if (c.name.endsWith('_id')) idIndices.push({ index, name: c.name })
  })
  const maxTimestamps = Object.fromEntries(timestampIndices.map(({ name }) => [name, null]))
  const nullCounts = Object.fromEntries(idIndices.map(({ name }) => [name, 0]))

  const chunks = []
  let rowCount = 0
  const startedAt = Date.now()

  await tx.unsafe(`DECLARE ${SCAN_CURSOR_NAME} CURSOR FOR SELECT * FROM ${quotedTable} ORDER BY ${orderBy}`)
  try {
    for (;;) {
      const rows = await tx.unsafe(`FETCH FORWARD ${chunkSize} FROM ${SCAN_CURSOR_NAME}`)
      if (rows.length === 0) break

      const canonicalRows = rows.map((row) => canonicalizeRow(row, columns))
      for (const canonicalRow of canonicalRows) {
        // timestamp最大値追跡: canonicalizeRowが既にISO 8601 UTC文字列へ正規化済みのため、
        // 文字列比較のままchronological orderの比較として成立する（ISO 8601 UTCは
        // レキシコグラフィック順=時系列順になる性質を利用）。
        for (const { index, name } of timestampIndices) {
          const value = canonicalRow[index][1]
          if (value !== null && (maxTimestamps[name] === null || value > maxTimestamps[name])) maxTimestamps[name] = value
        }
        // canonicalizeCellは全ての分岐でnull/undefinedを一貫してnullへ写像するため
        // （secret列のhash化・timestamp正規化いずれも非null値をnullにはしない）、
        // canonical化後の値でnull判定してもraw値でのnull判定と同じ結果になる。
        for (const { index, name } of idIndices) {
          if (canonicalRow[index][1] === null) nullCounts[name] += 1
        }
      }

      chunks.push({
        index: chunks.length,
        startKey: primaryKeyColumns.map((col) => rows[0][col]),
        endKey: primaryKeyColumns.map((col) => rows[rows.length - 1][col]),
        hash: hashChunk(canonicalRows),
      })
      rowCount += rows.length

      if (rows.length < chunkSize) break
    }
  } finally {
    await tx.unsafe(`CLOSE ${SCAN_CURSOR_NAME}`)
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
