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
 * ルックアップのみを提供する）。`code` は人間が許容事項の定義を識別・追跡するためのIDで、
 * 現状は `findAllowlistEntry` のlookup keyやreport出力値としては使わず、適用判定は
 * `appliesTo` で行う。
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
 * **現状の適用範囲について（重要、オーケストレーターレビュー Minor-3対応。
 * Issue #697 preview rehearsal followup〔2026-07-22〕でschema layerの2箇所を追加配線）**:
 * `findAllowlistEntry` は次の4箇所からのみ呼ばれる:
 *   - layer-data.mjsの`DATA_TABLE_MISSING`判定（`{ layer: 'data', table }`）
 *   - layer-invariants.mjsの`INVARIANT_REQUIRED_TABLE_MISSING`判定
 *     （`{ layer: 'invariants', invariantId }`）
 *   - layer-schema.mjsの`EXTENSION_MISMATCH`判定のうち、**target限定として現れた
 *     拡張機能に限る**（`{ layer: 'schema', kind: 'extension', key }`。`key`は
 *     `compareExtensions`が返す `extname::schema` 形式の完全一致キー（Fable独立レビュー
 *     m-1対応、2026-07-22: 当初`extname`単独でマッチしていたが、これだと
 *     `hypopg::public`のようにPlanetScale管理外の経路（ユーザーが誤って別スキーマへ
 *     インストールした等）で同名拡張が入った場合まで許容してしまう。`hypopg`が
 *     実際に許容されるべきなのは「PlanetScaleが`pscale_extensions`スキーマへ
 *     標準搭載する場合」のみであり、schemaを無視した名前一致では許容範囲が広すぎる。
 *     そのため`extname::schema`の完全一致へ厳格化した）。
 *     source側で必須拡張が欠落している場合〔`missingRequired`〕はこのルックアップを
 *     一切通さず、常にfailのまま。target限定の拡張機能のみがallowlist対象になりうる）
 *   - layer-schema.mjsの`SCHEMA_OBJECT_DEFINITION_MISMATCH`判定のうち、
 *     オブジェクト識別子（`type::schema::name`）単位で該当するもの
 *     （`{ layer: 'schema', kind: 'object', key }`。1オブジェクトずつ判定するため、
 *     同じ差分検出の中でallowlist該当・非該当が混在してもよい〔全体一括の降格はしない〕）
 * **違反件数レベルのallowlist（例: 特定のinvariant checkで検出された特定の違反を
 * 個別に無視する）には未対応**であり、Chunk 3時点から変わらず配線されていない。たとえば
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
 * @typedef {
 *   | { layer: 'data', table: string }
 *   | { layer: 'invariants', invariantId: string }
 *   | { layer: 'schema', kind: 'extension', key: string }
 *   | { layer: 'schema', kind: 'object', key: string }
 * } AllowlistMatchSpec
 * @typedef {{ code: string, appliesTo: AllowlistMatchSpec[], reason: string, reference: string }} AllowlistEntry
 */

/**
 * 現時点（Issue #697 Chunk 3実装時点 + preview rehearsal followup〔2026-07-22〕）で
 * 確定している許容事項。新しいエントリを追加する場合は、必ず `reason`
 * （なぜ許容するのか）と `reference`（issue番号・runbookの節など、後から経緯を
 * 追跡できる根拠）の両方を書くこと。
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
    reference: 'Issue #625 / docs/history/migration/DB_PHASE2_RUNBOOK.md 8章「既知スキーマドリフトの扱い」',
  },
  {
    code: 'HYPOPG_EXTENSION_PLANETSCALE_MANAGED',
    // Fable独立レビュー m-1対応（2026-07-22）: `extname`単独ではなく`extname::schema`の
    // 完全一致キーでピン留めする。PlanetScaleが実際に標準搭載する経路は
    // `hypopg::pscale_extensions`のみであり、万一同名の拡張がそれ以外のスキーマ
    // （PlanetScale管理外の経路、例えばユーザーが誤って`public`等へインストールした場合）
    // に現れた場合はこのエントリの対象外とし、従来どおりfailさせる（schemaを無視した
    // 名前一致だと許容範囲が意図より広くなってしまうため）。
    appliesTo: [{ layer: 'schema', kind: 'extension', key: 'hypopg::pscale_extensions' }],
    reason:
      'hypopgはPlanetScaleがインフラ管理用に標準搭載する拡張（pscale_extensionsスキーマに設置される）であり、' +
      'ユーザー側の操作で削除できない恒久的な環境差。2026-07-22のpreview rehearsal（実Supabase↔実PlanetScale ' +
      'previewでのdb:cutover:verify 5層フル実行）で「target限定: hypopg::pscale_extensions」として実際に検出し、' +
      '確認した。本エントリは`hypopg::pscale_extensions`という完全一致キーにのみ適用され、同名の拡張が' +
      '万一別スキーマ経由（PlanetScale管理外の経路）で入った場合は対象外（fail）とする。',
    reference: 'Issue #697 preview rehearsal（2026-07-22）/ docs/history/migration/DB_PHASE2_RUNBOOK.md 5.1節手順6',
  },
  {
    code: 'CHECK_CONSTRAINT_DEPARSE_VERSION_DIFF',
    appliesTo: [
      { layer: 'schema', kind: 'object', key: 'TABLE::public::cards' },
      { layer: 'schema', kind: 'object', key: 'TABLE::public::blob_files' },
    ],
    reason:
      'PG 17.6（Supabase提供の最新ビルドでも17.6.1.147までで17.10は提供されていない）vs 17.10（PlanetScale）の' +
      'CHECK制約deparse差。2026-07-22に手動diffで意味的に同一であることを確認済み（表記差のみ、実質的な制約内容は' +
      '変わらない）: blob_filesのvalid_storage_typeは配列castの書式差（`(ARRAY[...]::text[])` vs ' +
      '`ARRAY[(...)::text, ...]`）、cardsのcards_rarity_not_blankはAND式の括弧の付き方の差（`(((A) AND (B)) AND (C))` ' +
      'vs `((A) AND (B) AND (C))`）のみ。バージョンparityでは解決不可能なため許容する。' +
      '**マイナーバージョンparity達成時（SupabaseがPG 17.10相当を提供するようになった時点）にこのエントリを' +
      '削除すること。** この間、当該2テーブルのLayer 2（schema比較）検証は縮退する（緩和策: ' +
      'scripts/verify-db-schema.jsがtarget単体をsrc/lib/db/schema.tsと独立照合しており、Layer 4 ' +
      '（deterministic data checksum）が実データの内容一致を別途保証する）。' +
      '**残余ギャップ（Fable独立レビュー m-4対応、必ず把握しておくこと）**: ' +
      'scripts/verify-db-schema.jsは列名・型・NOT NULLのみを照合し、CHECK制約は一切照合しない' +
      '（同スクリプトのdiffSchemas実装を確認済み。制約自体の比較ロジックが存在しない）。' +
      'Layer 4 checksumも行データの内容のみを対象とし、DDL/制約定義は対象外。' +
      'したがって本エントリが存在する間、cards/blob_filesのCHECK制約自体が' +
      '意味的に変化・削除された場合（deparse表記差ではなく実際の制約内容の変更）は、' +
      'どの緩和策（verify-db-schema.js・Layer 4 checksum）によっても検出されない' +
      '残余ギャップがある。',
    reference: 'Issue #697 preview rehearsal（2026-07-22）/ docs/history/migration/DB_PHASE2_RUNBOOK.md 5.1節手順6',
  },
]

/**
 * 内部ヘルパー: 1つの `appliesTo` 要素が、呼び出し側から渡された条件（criteria）に
 * マッチするかどうかを判定する。`table`・`invariantId`・`key` はいずれか1つのみを持つ
 * （互いに排他的）前提のため、specが持つプロパティのみを見て判定する。
 *
 * schema layerの2種（extension用・object用、いずれも`key`プロパティを持つ）は
 * `layer`が一致するだけでなく`spec.kind`（specが自己申告する'extension' | 'object'）と
 * `criteria.kind`が一致する必要がある（同じ`layer:'schema'`・同じ`key`プロパティの中で
 * 拡張機能名前空間とオブジェクト識別子名前空間が偶然衝突してもクロスマッチしないように
 * するため）。
 *
 * **`spec.kind`を判定の主体にする（Fable独立レビュー m-2対応、2026-07-22、重要）**:
 * 修正前は「`key`プロパティが存在する」という形状のみでobject用specとみなし、
 * `criteria.kind === 'object'`かどうかだけを固定でチェックしていた（当時はextension用specが
 * 別プロパティ`extname`を使っていたため形状だけで区別できていた）。m-1対応で
 * extension用specも`key`プロパティへ統一した結果、形状（プロパティ有無）だけでは
 * extension用/object用を区別できなくなったため、spec自身が宣言する`kind`フィールドを
 * 実際の判定に使うよう変更した。`key`を持つのに`kind`を宣言していないspecは
 * AllowlistEntry定義自体の不備（片方だけ書き換えて`kind`を消し忘れた等）とみなし、
 * サイレントに何とでもマッチする/しないという曖昧な挙動にはせず、fail-loudに例外を
 * 投げる（不正な定義を早期に検出するため）。
 * @param {AllowlistMatchSpec} spec
 * @param {{ layer: string, table?: string, invariantId?: string, kind?: string, key?: string }} criteria
 * @returns {boolean}
 */
function matchesSpec(spec, criteria) {
  if (spec.layer !== criteria.layer) return false
  if ('table' in spec) return spec.table === criteria.table
  if ('invariantId' in spec) return spec.invariantId === criteria.invariantId
  if ('key' in spec) {
    if (typeof spec.kind !== 'string') {
      throw new Error(`cutover-allowlist: schema layer spec (has 'key') must declare 'kind': ${JSON.stringify(spec)}`)
    }
    return spec.kind === criteria.kind && spec.key === criteria.key
  }
  // ここに到達するのは AllowlistEntry の appliesTo 定義自体が不正な場合のみ
  // （table/invariantId/key のいずれも持たない spec）。fail-loudにするため例外にする。
  throw new Error(`cutover-allowlist: appliesTo spec has neither 'table', 'invariantId' nor 'key': ${JSON.stringify(spec)}`)
}

/**
 * 指定した条件に一致する allowlist エントリを探す純粋関数。見つからなければ null を返す
 * （見つからない＝許容されない＝通常どおりfail扱いにすることを呼び出し側へ明示するため、
 * undefinedではなくnullを返す）。
 *
 * @param {
 *   | { layer: 'data', table: string }
 *   | { layer: 'invariants', invariantId: string }
 *   | { layer: 'schema', kind: 'extension', key: string }
 *   | { layer: 'schema', kind: 'object', key: string }
 * } criteria
 * @returns {AllowlistEntry | null}
 */
export function findAllowlistEntry(criteria) {
  const entry = ALLOWLIST.find((candidate) => candidate.appliesTo.some((spec) => matchesSpec(spec, criteria)))
  return entry ?? null
}
