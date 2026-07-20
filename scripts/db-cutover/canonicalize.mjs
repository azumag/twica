#!/usr/bin/env node

/**
 * 行データのcanonical化・checksum計算 / Issue #697 Chunk 2（Layer 4基盤）
 *
 * 背景（Issue #697本文「Layer 4: Deterministic data checksum」）:
 * source（Supabase）・target（PlanetScale）は同じPostgreSQLだが、ドライバやクライアントの
 * 違いでtimestamp・JSONBの文字列表現が揺れうる。「意味的に同じ値なら同じcanonical文字列に
 * なる」変換を1箇所に集約し、Layer 4（layer-data.mjs）はこのモジュールが返す値を
 * そのままJSON.stringifyしてchecksum計算に使う。
 *
 * 各データ型の方針（Issue #697本文どおり）:
 *   - timestamp: `Date`/文字列いずれの入力でも `Date#toISOString()`（ISO 8601 UTC）へ統一する。
 *   - jsonb / array（PostgreSQL ARRAY型）: objectのkeyは再帰的にソートして順序非依存にする。
 *     配列要素の順序は意図的に変更しない（Issue #697本文「arrayはorder-sensitiveのまま
 *     canonical化」。順序違いを差分として検出したいため）。
 *   - secret列（token/secret/password/hash相当、scripts/db-cutover/secret-columns.mjs参照）:
 *     生値を一切canonical出力に含めず、SHA-256ハッシュ値に置き換える
 *     （Issue #697本文「access token等のsecret columnは値を出力しない」。chunk hashは
 *     reportに残るため、生値がreportへ混入する経路を断つ）。
 *   - 上記以外（uuid/text/boolean/integer/numeric/bigint等）はpostgres.jsが返す値を
 *     そのまま使う。numeric/bigintの文字列表現は、precision/scaleを明示宣言したnumeric列
 *     （`drop_rate numeric(5,4)`・`win_rate numeric(5,2)`等）ではtypmodに依存して決まり、
 *     provider非依存で決定的なため追加正規化は行わない（Layer 2のschema比較でtypmod自体の
 *     一致は別途担保される）。
 *     **既知の例外（Fableレビュー Minor対応、コメント訂正）**: `cards.intra_rarity_weight`
 *     はprecision/scale宣言の無いnumeric列であり、この場合PostgreSQLは実際に格納された
 *     有効桁数をそのまま表示する（`1` と `1.0` と `1.00` はtypmod固定が無ければ異なる
 *     テキスト表現になりうる）。この列に限っては「typmodで決定的」という上記の説明が
 *     厳密には成立しない。実運用ではdump/restore・logical replicationいずれも値の
 *     内部表現をそのまま転写するため実害は無い想定だが、将来この列にアプリ層から
 *     異なる有効桁数で値を書き込む経路が増えた場合、cosmetic差によるchecksum不一致
 *     （偽陽性）が起こりうることを明記しておく。
 *
 * timestampのマイクロ秒精度について（Fableレビュー Major対応、既知の限界）:
 * PostgreSQLのtimestamp(tz)はマイクロ秒精度を持つが、`canonicalizeTimestamp`はJS `Date`
 * （ミリ秒精度）を経由するため、マイクロ秒の差異は正規化の時点で失われる（postgres.jsの
 * デフォルト型パーサが値をDateへ変換する時点で既に失われており、本モジュールより前段の
 * 問題でもある）。よって「マイクロ秒だけ異なる2つの値」はchecksum上区別できない
 * （false negativeになりうる、既知の限界）。本プロジェクトのtimestamp列は全て
 * created_at/updated_at等の人間駆動イベントであり、マイクロ秒精度が業務上意味を持つ
 * ケースが無いため許容する（YAGNI判断）。
 */

'use strict'

import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

/** schema.ts由来のdataType文字列のうち、timestamp系として扱うもの。 */
const TIMESTAMP_DATA_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone'])

/** schema.ts由来のdataType文字列のうち、JSON的なkey順序正規化が必要なもの。 */
const JSON_LIKE_DATA_TYPES = new Set(['jsonb', 'ARRAY'])

/**
 * timestamp値をISO 8601 UTC文字列へ正規化する純粋関数。
 * `Date`インスタンス・文字列のどちらの入力でも同じ結果になる
 * （postgres.jsの型パーサ設定次第でどちらの形でも来うるため）。
 * @param {Date | string | null | undefined} value
 * @returns {string | null}
 */
export function canonicalizeTimestamp(value) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`canonicalizeTimestamp: invalid timestamp value: ${JSON.stringify(String(value))}`)
  }
  return date.toISOString()
}

/**
 * JSONB/array値を「objectのkeyは再帰的にソート、arrayの要素順序は保持」した新しい値へ
 * 変換する純粋関数。JSON.stringifyは非負整数風でない文字列keyについて挿入順を保持する
 * （ES2015以降の仕様）ため、ソート順に挿入し直したobjectをJSON.stringifyするだけで
 * key順序が正規化された文字列表現が得られる。
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeJsonValue(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    // Issue #697本文: arrayは要素順序をそのまま保持する（順序違いを差分として検出するため）。
    return value.map((item) => canonicalizeJsonValue(item))
  }
  if (typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeJsonValue(value[key])
    }
    return sorted
  }
  return value
}

/**
 * secret列の値をSHA-256ハッシュへ置き換える純粋関数。NULLはNULLのまま
 * （「値が無いこと」自体は機微情報ではなく、NULL率の比較に必要なため）。
 *
 * Dateインスタンスの扱いについて（Fableレビュー Major対応）: secret列は基本text型だが、
 * `twitch_token_expires_at`のようにsecret列判定（token/secret/password/hashパターン）に
 * マッチするtimestamp列も存在する（secret-columns.mjsのKNOWN_SECRET_COLUMNS参照）。
 * 素朴に `String(date)` すると `Date#toString()` の結果（実行マシンのタイムゾーン・
 * ミリ秒未満切り捨て・曜日名を含む可読形式）に依存してしまい、同じ瞬間を表す値でも
 * 実行環境によって異なるハッシュになりうる（意図しない偽陽性の原因）。Dateインスタンスは
 * 必ず`toISOString()`（UTC・ミリ秒精度固定）を経由してからハッシュ化することで、
 * timestamp列と同じ決定的な文字列表現を使う。
 * @param {unknown} value
 * @returns {string | null}
 */
export function hashSecretValue(value) {
  if (value === null || value === undefined) return null
  const normalized = value instanceof Date ? value.toISOString() : String(value)
  return core.computeChecksum(normalized)
}

/**
 * 1セル分の値を、列メタデータ（dataType・isSecret）に応じてcanonical化する純粋関数。
 * @param {unknown} value
 * @param {{ dataType: string, isSecret: boolean }} columnMeta
 * @returns {unknown}
 */
export function canonicalizeCell(value, columnMeta) {
  if (columnMeta.isSecret) return hashSecretValue(value)
  if (TIMESTAMP_DATA_TYPES.has(columnMeta.dataType)) return canonicalizeTimestamp(value)
  if (JSON_LIKE_DATA_TYPES.has(columnMeta.dataType)) return canonicalizeJsonValue(value)
  return value === undefined ? null : value
}

/**
 * 1行分のデータを、`columns`（あらかじめ列名昇順でソート済みであること）の順序に沿って
 * `[列名, canonical化した値]` の配列へ変換する純粋関数。
 *
 * 列順序を呼び出し側に強制する理由: object（`row`）のkey列挙順はpostgres.jsが返す
 * SELECTの列順（DB内部のordinal順）に依存し、source/targetで必ずしも一致する保証が無い
 * （Layer 2のschema比較は列の存在・型を見るが、物理的な列順一致までは保証しない）。
 * 呼び出し側が確定した順序（table-catalog.mjsが列名昇順で組み立てる）を渡すことで、
 * 「列の並び順が違うだけ」で誤ってchecksum不一致になる事故を防ぐ。
 *
 * @param {Record<string, unknown>} row postgres.jsが返す1行分のオブジェクト
 * @param {Array<{ name: string, dataType: string, isSecret: boolean }>} columns
 * @returns {Array<[string, unknown]>}
 */
export function canonicalizeRow(row, columns) {
  return columns.map((column) => [column.name, canonicalizeCell(row[column.name], column)])
}

/**
 * 複数行（1 chunk分）のcanonical化済み表現を1つのSHA-256ハッシュへ畳み込む純粋関数。
 * 各行はJSON.stringifyしてから改行区切りで連結する（行境界の曖昧さを避けるため。
 * `[1]` + `[2]` のような素朴な文字列連結では異なる行集合が同じ文字列になりうるが、
 * 改行区切りならJSON配列の閉じ括弧の直後に必ず改行が来るため曖昧さが生じない）。
 * @param {Array<Array<[string, unknown]>>} canonicalRows
 * @returns {string}
 */
export function hashChunk(canonicalRows) {
  const text = canonicalRows.map((row) => JSON.stringify(row)).join('\n')
  return core.computeChecksum(text)
}

/**
 * 複数chunkのhashを、chunk順序どおりに1つのtable root hashへ畳み込む純粋関数。
 * 順序に敏感な連結（chunk 0が空table・全chunk空でも決定的に同じ値になる）。
 * @param {string[]} chunkHashes
 * @returns {string}
 */
export function hashChunkList(chunkHashes) {
  return core.computeChecksum(chunkHashes.join(''))
}
