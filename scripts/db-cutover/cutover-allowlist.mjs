#!/usr/bin/env node

/**
 * レイヤー横断 allowlist / Issue #697 Chunk 3
 *
 * 背景（設計書「allowlist（レイヤー横断、rev1 Critical-1 対応）」節）:
 * cutover検証ツールは「source/targetの差分」を機械的に検出するが、本番Supabaseには
 * 過去のスキーマドリフト（#625: battle機能が実装されていた00002マイグレーション適用後、
 * 何らかの理由で `battles`/`battle_stats` テーブルが実際には作成されなかった）が既に
 * 存在する。これは移行が引き起こした問題ではなく、移行前から本番に存在する既知の状態
 * であり、cutover検証が「本番に元からある既知の欠落」まで無条件にfailにしてしまうと、
 * issue #697の受け入れ条件（「pass reportを得てからwrite解禁」）が本番に対して恒久的に
 * 満たせなくなってしまう。
 *
 * 一方で、無条件に「その名前のテーブルが無くてもOK」という緩いallowlistにすると、
 * 移行作業そのものが原因でテーブルを取りこぼした場合（本来コピーされるべきテーブルが
 * 移行漏れした場合）まで見逃してしまう。そのため各allowlistエントリは
 * `code`・`appliesTo`（どのlayer・どのテーブル/invariantに適用されるか）・`reason`
 * （なぜ許容するのか）・`reference`（根拠となるissue/runbook節）を必ず明記し、
 * 「無視した」という事実と理由を必ずreportへ出す（呼び出し側の責務。本モジュールは
 * ルックアップのみを提供する）。
 *
 * data layer（layer-data.mjs）と invariants layer（layer-invariants.mjs）の両方から
 * 参照される共有モジュールであるため、DB接続やlayer固有の型に依存しない、
 * 純粋なルックアップ関数として独立させている（rev1では invariants layer 専用の
 * `invariant-allowlist.mjs` として計画されていたが、rev1レビューCritical-1で
 * data layerのDATA_TABLE_MISSINGにも同じ問題があることが指摘され、共有モジュールへ昇格した）。
 *
 * `appliesTo` を配列にしている理由:
 * 「battles/battle_stats がprodに存在しない」という1つの既知事実（#625）は、
 * data layerでは「battlesテーブル自体の不在」「battle_statsテーブル自体の不在」という
 * 2つの独立したテーブル不在チェックに、invariants layerでは
 * 「battle-stats-consistency invariantの実行可否」という1つのチェックに、それぞれ
 * 別の形で現れる。これらは全て同一の根本原因・同一のreason/referenceを共有する
 * 「1件」の許容事項であるため、1つのエントリの中に複数の適用先（`appliesTo`の配列要素）を
 * 持たせる設計にした（同じreason/referenceを持つエントリを3つ複製すると、
 * 将来この許容事項を見直す際に3箇所を同期して更新し忘れるリスクがある）。
 *
 * **現状の適用範囲について（重要、オーケストレーターレビュー Minor-3対応）**:
 * `findAllowlistEntry` は「テーブルが存在しない」という条件でのみ呼ばれる
 * （layer-data.mjsの`DATA_TABLE_MISSING`判定、layer-invariants.mjsの
 * `INVARIANT_REQUIRED_TABLE_MISSING`判定の2箇所のみ）。**違反件数レベルの
 * allowlist（例: 特定のinvariant checkで検出された特定の違反を個別に無視する）には
 * 未対応**であり、Chunk 3時点では配線されていない。たとえば
 * `support-code-license-state`（Tier A、設計書で「fail-until-allowlist」と
 * 位置付けられている）に新しいエントリを追加しても、`evaluateTierACheck`
 * （layer-invariants.mjs）が`findAllowlistEntry`を一切呼ばないため、
 * その違反は従来どおりfailし続ける（＝エントリを追加しても何も起きない）。
 * 違反件数レベルのallowlistが必要になった場合は、`AllowlistMatchSpec`に
 * `{ layer: 'invariants', checkCode: string }`等の新しいバリアントを追加し、
 * `evaluateTierACheck`/`evaluateTierBCheck`（layer-invariants.mjs）側にも
 * ルックアップ呼び出しを配線する必要がある（本コメント作成時点では未実施、
 * 必要になれば後続チャンクで対応する）。
 */

'use strict'

/**
 * @typedef {{ layer: 'data', table: string } | { layer: 'invariants', invariantId: string }} AllowlistMatchSpec
 * @typedef {{ code: string, appliesTo: AllowlistMatchSpec[], reason: string, reference: string }} AllowlistEntry
 */

/**
 * 現時点（Issue #697 Chunk 3実装時点）で確定している許容事項。
 * 新しいエントリを追加する場合は、必ず `reason`（なぜ許容するのか）と
 * `reference`（issue番号・runbookの節など、後から経緯を追跡できる根拠）の両方を書くこと。
 * @type {AllowlistEntry[]}
 */
export const ALLOWLIST = [
  {
    code: 'BATTLE_FEATURE_TABLES_ABSENT_IN_PROD',
    appliesTo: [
      { layer: 'data', table: 'battles' },
      { layer: 'data', table: 'battle_stats' },
      { layer: 'invariants', invariantId: 'battle-stats-consistency' },
    ],
    reason:
      'battle機能（対戦）は00002マイグレーションでテーブル定義自体は存在するが、' +
      '本番Supabaseには実際には作成されていない既知のスキーマドリフト（#625）。' +
      '2026-07-17のオーナー確認により、battle機能は「廃止」ではなく「将来実装のため温存」と' +
      '確定しており、cutover検証ツールが本番に元から存在するこの欠落を移行起因の問題として' +
      '扱わないようにする。battle機能を再実装する時点で、新DB向けのテーブル作成migrationを' +
      '別途書く運用（既存00002を書き換えない）。',
    reference: 'Issue #625 / docs/db-phase2-runbook.md 8章「既知スキーマドリフトの扱い」',
  },
]

/**
 * 内部ヘルパー: 1つの `appliesTo` 要素が、呼び出し側から渡された条件（criteria）に
 * マッチするかどうかを判定する。`table` と `invariantId` はどちらか一方のみを持つ
 * （互いに排他的）前提のため、specが持つ方のプロパティのみを見て判定する。
 * @param {AllowlistMatchSpec} spec
 * @param {{ layer: string, table?: string, invariantId?: string }} criteria
 * @returns {boolean}
 */
function matchesSpec(spec, criteria) {
  if (spec.layer !== criteria.layer) return false
  if ('table' in spec) return spec.table === criteria.table
  if ('invariantId' in spec) return spec.invariantId === criteria.invariantId
  // ここに到達するのは AllowlistEntry の appliesTo 定義自体が不正な場合のみ
  // （table/invariantId のどちらも持たない spec）。fail-loudにするため例外にする。
  throw new Error(`cutover-allowlist: appliesTo spec has neither 'table' nor 'invariantId': ${JSON.stringify(spec)}`)
}

/**
 * 指定した条件（layer + table、または layer + invariantId）に一致する allowlist エントリを
 * 探す純粋関数。見つからなければ null を返す（見つからない＝許容されない＝通常どおりfail扱い
 * にすることを呼び出し側へ明示するため、undefinedではなくnullを返す）。
 *
 * @param {{ layer: 'data', table: string } | { layer: 'invariants', invariantId: string }} criteria
 * @returns {AllowlistEntry | null}
 */
export function findAllowlistEntry(criteria) {
  const entry = ALLOWLIST.find((candidate) => candidate.appliesTo.some((spec) => matchesSpec(spec, criteria)))
  return entry ?? null
}
