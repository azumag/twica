#!/usr/bin/env node

/**
 * Layer 2: schema比較 / Issue #697 Chunk 1
 *
 * 設計判断（Issue #697本文 Major、この方針を採用）:
 * 新規にinformation_schema/pg_catalogを直読みするシリアライザを一から作らず、既存の
 * scripts/db-phase2/export-public-schema.mjs（pg_dumpラッパー、runPgDumpPublicSchemaを
 * 再利用）+ scripts/db-phase2/normalize-schema.mjs（TOC境界正規化、normalizeDumpを再利用）を
 * source/target双方に対して実行し、正規化されたDDL出力をTOCブロック単位で比較する方式を
 * 第一候補として実装する。
 *
 * カバー範囲について（詳細は実装完了後の報告に記載）:
 * pg_dumpのTOCブロックは Type フィールド（TABLE/CONSTRAINT/FK CONSTRAINT/INDEX/FUNCTION/
 * TRIGGER/POLICY/ROW SECURITY 等）ごとに個別のオブジェクトとして出力される。table/PK/FK/
 * unique/index/function/trigger/generated column/RLS enabled/policy はこのブロック単位比較で
 * 検出できる（generated columnはTABLEブロック本文の一部として、RLS enabledは専用の
 * ROW SECURITYブロックとして。実際に db/planetscale/public-schema.sql に
 * "Type: ROW SECURITY" ブロックが存在することを確認済み）。列単位の型変更は「そのテーブルの
 * TABLEブロック全体が一致しない」という粒度でしか検出できない（pg_dumpは列ごとに個別の
 * TOCエントリを作らないため）。extensionは `--schema=public` の対象外
 * （通常 `extensions` スキーマに設置されるため）でDDLブロックとして出力されないため、
 * pg_catalog.pg_extensionへの補助クエリで別途比較する（Issue #697本文が許容する
 * 「DDL文に現れないメタ情報のみピンポイントで補助クエリを追加する」の実例）。
 *
 * `#691`が生成する `manifest.json` との照合について（オーケストレーターレビュー M-3対応、
 * 未実装の理由を明示）:
 * Issue #697本文は「#691 manifestとの一致も確認する」と明示しているが、Chunk 1では
 * 意図的に実装していない。理由は2つある。
 *   1. `manifest.json` はリポジトリに常設のファイルとして存在しない
 *      （`scripts/db-phase2/export-public-schema.mjs` が生成する成果物であり、出力先
 *      `db/planetscale/.artifacts/` は `.gitignore` 済み。実装時点でリポジトリ内を
 *      検索したが `manifest.json` は1つも見つからなかった）。よって「静的な
 *      manifest.jsonファイルとの照合」という形では、そもそも照合対象が存在しない。
 *   2. 本Layer 2はsource/target双方に対して**その場でpg_dumpを実行するlive-vs-live比較**
 *      であり、これは「片側だけをmanifest.json（過去のある時点のスナップショット）と比較する」
 *      よりも強い保証を持つ（manifest.jsonは生成時点で既に古くなっている可能性があるのに対し、
 *      live-vs-liveは常に検証実行時点の実DBを比較する）。
 * ただし、`db/planetscale/public-schema.sql`（`#691`が生成した committed baseline）
 * 自体を「targetが実際にこのbaselineどおりデプロイされているか」の追加チェックとして
 * source側と同じ正規化パイプラインに通し比較する、という拡張は将来的に価値がありうる
 * （例: baseline適用後に手動でtargetへ直接DDLを当てるといった「baselineをバイパスした変更」の
 * 検知）。これは意思決定として保留であり、後続チャンクで実施するかどうかは未定
 * （Chunk 1のスコープには含めない）。
 *
 * 人間向けMarkdown reportについて（オーケストレーターレビュー M-3対応、未実装の理由を明示）:
 * Issue #697本文のCLI案は「machine-readable JSONと人間向けMarkdownを生成する」と書かれていたが、
 * Chunk 1ではJSON出力のみを実装している。本チャンクの実装ブリーフ（親エージェントから
 * 渡された指示）はJSON reportの構造（`CutoverVerificationReport`型準拠）のみを要求しており、
 * Markdown整形については触れていなかった。JSON report自体が`layers`をlayer名キーの
 * オブジェクトにする等、後から機械的にMarkdownへ変換しやすい構造になっているため、
 * 「JSON report → Markdown整形」は後続チャンクで薄いフォーマッタを追加するだけで対応可能
 * （JSON構造自体の再設計は不要という見立て）。Chunk 1時点でMarkdown出力を省略したのは
 * 意図的なYAGNI判断であり、見落としではない。
 *
 * 「1時点スナップショット」ではないことについて（オーケストレーターレビュー Minor-9対応、
 * 前提の明記）:
 * `scripts/db-cutover/snapshot.mjs`（withReadOnlySnapshot）は「1つの接続内で発行する
 * 複数クエリが同一スナップショットを見る」ことは保証するが、本Layer 2が行う4回の
 * 個別操作（source pg_dump・target pg_dump・source拡張機能query・target拡張機能query）は
 * それぞれ**別々の時点・別々の接続**で実行される（pg_dumpはchild_process経由の別プロセスで
 * あり、withReadOnlySnapshotのトランザクション内では実行できない。拡張機能queryのみ
 * withReadOnlySnapshotでラップしている）。つまりLayer 2全体としては「厳密に1つの時刻断面を
 * source/targetの両方から取得した」という保証は無く、4回の操作それぞれの実行時刻の間に
 * （cutoverのwrite freeze中でなければ）書き込みが発生すれば、実際には存在しない差分を
 * 検出したり、逆に実際にあった差分を見逃したりする可能性がある。
 * **本Layer 2は、source/target双方への書き込みが発生しない期間（cutoverのメンテナンス
 * ウィンドウ・write freeze中）に実行されることを前提とする。** 通常運用中（書き込みが
 * 継続している状態）でLayer 2を実行した場合の結果は「その時点の目安」程度の意味しか持たず、
 * GO/NO-GO判断の根拠としては freeze 中の実行結果のみを使うこと。
 */

'use strict'

import { createRequire } from 'module'
import { runPgDumpPublicSchema, extractPostgresMajorVersion } from '../db-phase2/export-public-schema.mjs'
import { normalizeDump, findUnexpectedExclusions } from '../db-phase2/normalize-schema.mjs'
import { withReadOnlySnapshot } from './snapshot.mjs'
import { findAllowlistEntry } from './cutover-allowlist.mjs'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

/**
 * アプリが実際に必要とする拡張機能（db/planetscale/bootstrap.sqlがtarget側に用意する2つ）。
 * この2つは両側（source/target）に存在することを必須とする（Fableレビュー M-2対応）。
 * @see compareExtensions
 */
export const REQUIRED_EXTENSIONS = ['uuid-ossp', 'pgcrypto']

/**
 * `db/planetscale/bootstrap.sql` のソーステキストから `CREATE EXTENSION IF NOT EXISTS ...`
 * が宣言する拡張機能名を抽出する純粋関数（オーケストレーターレビュー Minor-3対応）。
 *
 * 背景: REQUIRED_EXTENSIONS はbootstrap.sqlが実際にtargetへインストールする拡張機能と
 * 一致している必要がある（さもないと、bootstrap.sqlに拡張機能が追加/削除されても
 * REQUIRED_EXTENSIONSが追随せず、Layer 2の必須拡張チェックが実態と乖離する）。
 * `scripts/db-cutover/secret-columns.mjs` の「実ファイルとの乖離を単体テストで検知する」
 * パターンをここにも適用する（tests/unit/db-cutover/layer-schema.test.ts参照）。
 *
 * 正規表現は `"uuid-ossp"`（ハイフンを含むため引用符必須）・`pgcrypto`（引用符無し）の
 * どちらの記法にもマッチするよう、引用符を任意にしている。
 *
 * @param {string} bootstrapSqlSource db/planetscale/bootstrap.sql の内容全体
 * @returns {string[]} 抽出した拡張機能名（ソート済み）
 */
export function extractBootstrapExtensionNames(bootstrapSqlSource) {
  const re = /CREATE EXTENSION IF NOT EXISTS\s+"?([a-zA-Z0-9_-]+)"?/g
  const names = new Set()
  let match
  while ((match = re.exec(bootstrapSqlSource)) !== null) {
    names.add(match[1])
  }
  return [...names].sort()
}

/**
 * normalizeDump が返す bring-as-is ブロック配列2つを比較する純粋関数。
 * @param {Array<{ raw: string, name: string, type: string, schema: string, category: string }>} sourceBlocks
 * @param {Array<{ raw: string, name: string, type: string, schema: string, category: string }>} targetBlocks
 * @returns {{ onlyInSource: string[], onlyInTarget: string[], differing: string[], identicalCount: number }}
 */
export function diffNormalizedBlocks(sourceBlocks, targetBlocks) {
  const keyOf = (b) => `${b.type}::${b.schema}::${b.name}`
  const bringAsIs = (blocks) => blocks.filter((b) => b.category === 'bring-as-is')

  // Minor(9, Fableレビュー): 同一キーのブロックが複数あると Map の構築で黙って
  // 後勝ちになる。pg_dumpの実出力ではTOC Nameがシグネチャ込みでほぼ一意だが、
  // 万一の衝突を沈黙させないよう検出したら例外で止める（fail-fast、安全側）。
  const buildMap = (blocks, side) => {
    const map = new Map()
    for (const b of bringAsIs(blocks)) {
      const key = keyOf(b)
      if (map.has(key)) {
        throw new Error(`diffNormalizedBlocks: ${side} 側でTOCキーが重複しています（想定外）: ${key}`)
      }
      map.set(key, b)
    }
    return map
  }

  const sourceMap = buildMap(sourceBlocks, 'source')
  const targetMap = buildMap(targetBlocks, 'target')

  const onlyInSource = []
  const differing = []
  let identicalCount = 0

  for (const [key, sourceBlock] of sourceMap) {
    const targetBlock = targetMap.get(key)
    if (!targetBlock) {
      onlyInSource.push(key)
    } else if (targetBlock.raw !== sourceBlock.raw) {
      differing.push(key)
    } else {
      identicalCount++
    }
  }
  const onlyInTarget = [...targetMap.keys()].filter((key) => !sourceMap.has(key))

  return {
    onlyInSource: onlyInSource.sort(),
    onlyInTarget: onlyInTarget.sort(),
    differing: differing.sort(),
    identicalCount,
  }
}

/**
 * `diffNormalizedBlocks` が返す `differing`（定義が一致しないオブジェクトのキー配列、
 * `type::schema::name` 形式）を、cutover-allowlist.mjs（レイヤー横断allowlist）へ
 * オブジェクト識別子単位で照会し、allowlist該当/非該当に分割する純粋関数
 * （Issue #697 preview rehearsal followup、2026-07-22）。
 *
 * 背景: 2026-07-22のpreview rehearsal（実Supabase PG 17.6 ↔ 実PlanetScale PG 17.10）で、
 * `TABLE::public::cards`・`TABLE::public::blob_files` の2件がCHECK制約のdeparse表記差
 * （意味的には同一）のみでdifferingとして検出された。SupabaseはPG 17.10相当を提供して
 * いないためバージョンparityでは解決できず、cutover-allowlist.mjsの
 * `CHECK_CONSTRAINT_DEPARSE_VERSION_DIFF`エントリで個別に許容する。
 *
 * **1オブジェクト単位で判定する**（`differing`全体を一括で降格するのではない）ことが
 * 重要な設計判断: 将来同じ実行で「allowlist未登録の別テーブルの定義差分」が同時に
 * 検出された場合、そのテーブルはallowlistに無いため引き続きfailとして検出されなければ
 * ならない。`differing`配列を丸ごとinfoへ降格すると、この種の見逃しが発生する
 * （オーケストレーターからの実装要求「全体一括の降格はしない」）。
 *
 * @param {string[]} differing `diffNormalizedBlocks` の `differing`（ソート済み）
 * @returns {{ allowlisted: Array<{ key: string, reason: string }>, nonAllowlisted: string[] }}
 */
export function partitionAllowlistedDifferingObjects(differing) {
  const allowlisted = []
  const nonAllowlisted = []
  for (const key of differing) {
    const entry = findAllowlistEntry({ layer: 'schema', kind: 'object', key })
    if (entry) {
      allowlisted.push({ key, reason: entry.reason })
    } else {
      nonAllowlisted.push(key)
    }
  }
  return { allowlisted, nonAllowlisted }
}

/**
 * pg_extension を比較する純粋関数。
 *
 * 設計変更（Fableレビュー M-2対応、Critical寄りの実害があったため修正）: 当初は
 * source/targetの拡張機能を無差別に比較していたが、Supabaseはアプリと無関係な拡張機能
 * （pg_stat_statements等のプラットフォーム標準拡張）を自動インストールすることが知られており、
 * これをそのまま比較すると実運用のcutoverで「sourceにしか無い拡張機能」が常に検出され、
 * 恒久的にfailし続ける（＝機械的GO/NO-GO判定が機能しない）おそれがある。
 *
 * そこで以下の非対称なポリシーを採る:
 *   - REQUIRED_EXTENSIONS（アプリが実際に必要とする拡張機能。db/planetscale/bootstrap.sqlが
 *     targetに用意する uuid-ossp/pgcrypto）は両側に存在することを必須とし、欠落は fail 対象。
 *   - source限定の拡張機能のうちREQUIRED_EXTENSIONSに含まれないものは、Supabaseプラットフォームが
 *     自動インストールした無害な拡張機能である可能性が高いため、fail対象にはせず
 *     「informational（報告のみ）」として扱う。
 *   - target限定の拡張機能（targetにあってsourceに無い）は、bootstrap.sql適用以外の経路で
 *     targetへ意図しない拡張機能が入ったことを意味しうるため、常にfail対象とする。
 *
 * @param {Array<{ extname: string, schema: string }>} sourceRows
 * @param {Array<{ extname: string, schema: string }>} targetRows
 * @returns {{
 *   onlyInSource: string[], onlyInTarget: string[],
 *   onlyInSourceInformational: string[], missingRequired: string[],
 * }}
 */
export function compareExtensions(sourceRows, targetRows) {
  const keyOf = (r) => `${r.extname}::${r.schema}`
  const sourceSet = new Set(sourceRows.map(keyOf))
  const targetSet = new Set(targetRows.map(keyOf))
  const sourceNames = new Set(sourceRows.map((r) => r.extname))
  const targetNames = new Set(targetRows.map((r) => r.extname))

  const onlyInSource = [...sourceSet].filter((k) => !targetSet.has(k)).sort()
  const onlyInTarget = [...targetSet].filter((k) => !sourceSet.has(k)).sort()

  // extname部分（schemaを無視）でREQUIRED_EXTENSIONSに該当するかどうかを判定する。
  // 2回目Fableレビュー Minor-5対応（コメント明確化）: 「schemaの違いは許容範囲」というのは
  // あくまで `missingRequired`（必須拡張の欠落判定）に限った話である。schemaが異なる場合、
  // 当該extnameは `onlyInSource`/`onlyInTarget` には引き続き載る（キーがextname::schemaの
  // 完全一致で決まるため）。target側で必須拡張が別schemaに入っていた場合、
  // missingRequiredには現れないが、onlyInTarget経由でEXTENSION_MISMATCHがfailするため、
  // 「schemaの違いを常に無視する」わけではない（実運用ではbootstrap.sqlが必ず`extensions`
  // schemaへ固定インストールするため、この経路が発火することは無い想定）。
  const extractName = (key) => key.split('::')[0]
  const onlyInSourceInformational = onlyInSource.filter((k) => !REQUIRED_EXTENSIONS.includes(extractName(k)))
  const missingRequired = REQUIRED_EXTENSIONS.filter((name) => !sourceNames.has(name) || !targetNames.has(name)).sort()

  return { onlyInSource, onlyInTarget, onlyInSourceInformational, missingRequired }
}

/**
 * `compareExtensions` が返す `onlyInTarget`（target限定拡張機能のキー配列、
 * `extname::schema` 形式）を、cutover-allowlist.mjs（レイヤー横断allowlist）へ
 * `extname::schema` の完全一致キー単位で照会し、allowlist該当/非該当に分割する
 * 純粋関数（Issue #697 preview rehearsal followup、2026-07-22。Fable独立レビュー
 * m-1対応で `extname` 単独マッチから完全一致キーへ厳格化、2026-07-22）。
 *
 * **キーをextname部分だけに分解せず、`extname::schema`のまま照会する**（Fable独立レビュー
 * m-1対応、重要）: 当初は`key.split('::')[0]`でschema部分を捨ててextname単独でallowlistへ
 * 照会していたが、これだと`hypopg::public`のようにPlanetScale管理外の経路（ユーザーが
 * 誤って別スキーマへインストールした等）で同名拡張が入った場合まで許容してしまう。
 * `hypopg`が実際に許容されるべきなのは「PlanetScaleが`pscale_extensions`スキーマへ
 * 標準搭載する場合」のみであり、schemaを無視した名前一致では許容範囲が意図より広くなる。
 * そのため`compareExtensions`が返す完全なキー（`extname::schema`）をそのまま
 * `findAllowlistEntry`へ渡す（cutover-allowlist.mjsの`HYPOPG_EXTENSION_PLANETSCALE_MANAGED`
 * エントリも`hypopg::pscale_extensions`という完全一致キーで定義されている）。
 *
 * **`onlyInTarget` のみを対象にする**（`missingRequired` は対象外）ことが重要な設計判断:
 * `missingRequired`は「source/targetいずれかでREQUIRED_EXTENSIONS〔uuid-ossp/pgcrypto、
 * アプリが実際に必要とする拡張〕が欠落している」ことを意味し、これはtarget限定の
 * 環境差（hypopg等、PlanetScaleが独自に追加インストールしたもの）とは性質が全く異なる
 * （アプリの必須要件が満たされていない＝移行の実害）。この2つを混同して
 * `missingRequired`側までallowlistで降格できるようにしてしまうと、必須拡張の欠落という
 * 重大な問題を誤って許容してしまうリスクが生じるため、本関数のシグネチャ自体が
 * `onlyInTarget`のみを受け取る形にして、呼び出し側が誤って`missingRequired`を
 * 渡す余地を型的に無くしている（オーケストレーターからの実装要求
 * 「source側に必要な拡張の欠落は絶対に降格しない」）。
 *
 * @param {string[]} onlyInTarget `compareExtensions` の `onlyInTarget`（ソート済み）
 * @returns {{ allowlisted: Array<{ key: string, reason: string }>, nonAllowlisted: string[] }}
 */
export function partitionAllowlistedTargetExtensions(onlyInTarget) {
  const allowlisted = []
  const nonAllowlisted = []
  for (const key of onlyInTarget) {
    const entry = findAllowlistEntry({ layer: 'schema', kind: 'extension', key })
    if (entry) {
      allowlisted.push({ key, reason: entry.reason })
    } else {
      nonAllowlisted.push(key)
    }
  }
  return { allowlisted, nonAllowlisted }
}

/**
 * source/target双方の `normalizeDump(...).output` をそのままdigest化していた実装の問題
 * （オーケストレーターレビュー M-1、Major）を修正する純粋関数。
 *
 * 問題: `normalizeDump` が返す `output` は `preamble + bring-as-isブロックの結合` であり、
 * preambleには `-- Dumped from database version 17.6` / `-- Dumped by pg_dump version 17.10
 * (Homebrew)` のようなバージョンバナー行が含まれる（`db/planetscale/public-schema.sql` 冒頭で
 * 実確認済み）。source（Supabase）とtarget（PlanetScale）でサーバーバージョン文字列・
 * pg_dumpクライアントバージョン文字列が完全一致することはまず無いため、
 * **スキーマの実体が完全一致していてもdigestが不一致になる**という欠陥があった
 * （pass/fail判定自体はfindings/objectDiffが別途担っているため機能的な誤判定にはならないが、
 * `sourceSchemaDigest`/`targetSchemaDigest` というreportフィールド自体が
 * GO/NO-GO判断材料として意味を持たなくなっていた）。
 *
 * 対策: digestの計算対象からpreambleを完全に除外し、bring-as-isブロックのraw本文のみを
 * 対象にする。preambleはSET文（session設定の正規化済みのもの）とバージョンバナーのみで
 * 構成され、実際のスキーマ定義（テーブル・関数・トリガー等）を一切含まないため、
 * 除外してもスキーマ比較の意味は失われない。
 *
 * さらに、ブロックをキー（type::schema::name）でソートしてから結合する。pg_dumpの
 * オブジェクト出力順は内部的なOID/依存関係順に依存しうり、source/targetで同じオブジェクト
 * 集合でも出力順が異なる可能性があるため、ソートしないと「内容は同一だが順序が違うだけ」で
 * digestが不一致になりうる（diffNormalizedBlocksは順序に依存しないMap比較のため実害は
 * 無いが、digestは単純な文字列結合のため順序に敏感）。
 *
 * @param {Array<{ raw: string, type: string, schema: string, name: string, category: string }>} blocks
 * @returns {string} digest計算対象のテキスト（呼び出し側がcore.computeChecksumに渡す）
 */
export function buildDigestInput(blocks) {
  const bringAsIs = blocks.filter((b) => b.category === 'bring-as-is')
  const sorted = [...bringAsIs].sort((a, b) => {
    const keyA = `${a.type}::${a.schema}::${a.name}`
    const keyB = `${b.type}::${b.schema}::${b.name}`
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  })
  return sorted.map((b) => b.raw).join('')
}

/** @param {import('postgres').Sql} tx */
async function fetchExtensions(tx) {
  const rows = await tx`
    select e.extname, n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    order by e.extname
  `
  return rows.map((r) => ({ extname: r.extname, schema: r.schema }))
}

/**
 * Layer 2 本体。
 * @param {{
 *   sourceUrl: string, targetUrl: string,
 *   sourceSql: import('postgres').Sql, targetSql: import('postgres').Sql,
 *   pgDumpBin?: string,
 * }} args
 */
export async function runSchemaLayer({ sourceUrl, targetUrl, sourceSql, targetSql, pgDumpBin }) {
  const findings = []

  const sourceDump = runPgDumpPublicSchema(sourceUrl, { pgDumpBin })
  const targetDump = runPgDumpPublicSchema(targetUrl, { pgDumpBin })

  // pg_dump自体が失敗した場合、以降の正規化・比較は行いようがないため即座に打ち切る
  // （エラーメッセージはredactSecretsFromTextで接続文字列由来の機微情報を除去してから積む。
  // Issue #697本文タスク7: secret redactionはChunk 1から適用する）。
  if (!sourceDump.ok) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_DUMP_FAILED',
      message: `source: pg_dump に失敗しました: ${core.redactSecretsFromText(sourceDump.message, sourceUrl)}`,
      side: 'source',
    })
  }
  if (!targetDump.ok) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_DUMP_FAILED',
      message: `target: pg_dump に失敗しました: ${core.redactSecretsFromText(targetDump.message, targetUrl)}`,
      side: 'target',
    })
  }
  if (!sourceDump.ok || !targetDump.ok) {
    return { layer: 'schema', pass: false, findings, sourceSchemaDigest: null, targetSchemaDigest: null, objectDiff: null, extensionDiff: null }
  }

  // オーケストレーターレビュー Minor-2対応: normalizeDumpの例外メッセージは実際には
  // raw dumpのテキスト構造（TOC境界の有無等）についてのものであり接続文字列を含む余地は
  // 無いはずだが、「全エラーパスでredactionを適用する」という設計方針（Issue #697本文タスク7）
  // との一貫性のため、他のfindingメッセージと同様にredactSecretsFromTextを通す
  // （多重防御。ライブラリ側の将来の実装変更で万一何かが混入しても安全側に倒れる）。
  let sourceNormalized, targetNormalized
  try {
    sourceNormalized = normalizeDump(sourceDump.rawDump)
  } catch (error) {
    const message = core.redactSecretsFromText(error instanceof Error ? error.message : String(error), sourceUrl)
    findings.push({ severity: 'fail', code: 'SCHEMA_NORMALIZE_FAILED', message: `source: 正規化に失敗しました: ${message}`, side: 'source' })
  }
  try {
    targetNormalized = normalizeDump(targetDump.rawDump)
  } catch (error) {
    const message = core.redactSecretsFromText(error instanceof Error ? error.message : String(error), targetUrl)
    findings.push({ severity: 'fail', code: 'SCHEMA_NORMALIZE_FAILED', message: `target: 正規化に失敗しました: ${message}`, side: 'target' })
  }
  if (!sourceNormalized || !targetNormalized) {
    return { layer: 'schema', pass: false, findings, sourceSchemaDigest: null, targetSchemaDigest: null, objectDiff: null, extensionDiff: null }
  }

  // M-1（オーケストレーターレビュー Major対応）: normalizeDump().output全体ではなく、
  // buildDigestInputでpreamble（バージョンバナー含む）を除去・ブロックをソートしてからdigest化
  // する。理由・詳細はbuildDigestInputのJSDoc参照。
  const sourceSchemaDigest = core.computeChecksum(buildDigestInput(sourceNormalized.blocks))
  const targetSchemaDigest = core.computeChecksum(buildDigestInput(targetNormalized.blocks))

  // Minor-8（Fableレビュー）: PostgreSQLメジャーバージョンの差はDDL本文（pg_get_indexdef等の
  // サーバー側生成文言）に微妙な表記差を生みうるため、`differing` の偽陽性リスク要因になりうる。
  // fail判定には使わず、reportに記録して運用者が判断材料にできるようにするに留める
  // （バージョン差そのものは異常ではなく、cutover計画上は事前に許容されうる差のため）。
  const sourcePostgresMajorVersion = extractPostgresMajorVersion(sourceDump.rawDump)
  const targetPostgresMajorVersion = extractPostgresMajorVersion(targetDump.rawDump)

  // C-1（Fableレビュー Critical対応）: normalize-schema.mjs のCLI（normalizeDump単体）は
  // 「想定外の防御的除外」（'public'スキーマ自身の除外を除く、auth等の管理スキーマ混入や
  // owner/ACL混入によるexclude）が1件でもあれば異常終了するM-2ゲートを持つ
  // （normalize-schema.mjs findUnexpectedExclusions のコメント参照）。しかし
  // diffNormalizedBlocks は category==='bring-as-is' のブロックのみを比較するため、
  // source/target 双方で同じオブジェクトが同じ理由で除外された場合、そのオブジェクトは
  // 比較対象から双方とも消え、定義が実際には異なっていても無警告でpassしてしまう
  // （片側だけ除外されれば onlyInSource/onlyInTarget で検出できるが、両側除外だけは
  // すり抜ける）。GO/NO-GO判定ツールでこの安全装置を素通りさせるわけにはいかないため、
  // normalizeDumpの呼び出し直後に同じゲートをここでも適用する。
  const sourceUnexpectedExclusions = findUnexpectedExclusions(sourceNormalized.blocks)
  const targetUnexpectedExclusions = findUnexpectedExclusions(targetNormalized.blocks)
  if (sourceUnexpectedExclusions.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_UNEXPECTED_EXCLUSION',
      message:
        `source: 想定外の防御的除外が ${sourceUnexpectedExclusions.length} 件あります` +
        `（auth等の管理スキーマ混入・owner/ACL混入等。normalize-schema.mjsのwarningsを確認してください）: ` +
        sourceUnexpectedExclusions.map((b) => `${b.type}:${b.name}(${b.reason})`).join(', '),
      side: 'source',
    })
  }
  if (targetUnexpectedExclusions.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_UNEXPECTED_EXCLUSION',
      message:
        `target: 想定外の防御的除外が ${targetUnexpectedExclusions.length} 件あります: ` +
        targetUnexpectedExclusions.map((b) => `${b.type}:${b.name}(${b.reason})`).join(', '),
      side: 'target',
    })
  }

  const objectDiff = diffNormalizedBlocks(sourceNormalized.blocks, targetNormalized.blocks)
  if (objectDiff.onlyInSource.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_OBJECT_MISSING_IN_TARGET',
      message: `target に存在しないオブジェクトが ${objectDiff.onlyInSource.length} 件あります: ${objectDiff.onlyInSource.join(', ')}`,
      side: 'target',
    })
  }
  if (objectDiff.onlyInTarget.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_OBJECT_MISSING_IN_SOURCE',
      message: `source に存在しないオブジェクトが ${objectDiff.onlyInTarget.length} 件あります（targetのみに存在）: ${objectDiff.onlyInTarget.join(', ')}`,
      side: 'source',
    })
  }
  // Issue #697 preview rehearsal followup（2026-07-22）: `differing`をallowlist該当/非該当で
  // オブジェクト単位に分割する（partitionAllowlistedDifferingObjectsのJSDoc参照。全体一括の
  // 降格はしない）。非該当分が1件でも残れば従来どおりfail（メッセージには非該当分のみ列挙）、
  // 該当分は件数に関わらず別チャンネルのinfo findingとして識別子とreasonを明記して併記する
  // （両方が同時に成立してもよい: 一部はfailで一部はinfo、というのが本followupの主眼）。
  const { allowlisted: allowlistedDiffObjects, nonAllowlisted: nonAllowlistedDiffObjects } = partitionAllowlistedDifferingObjects(
    objectDiff.differing
  )
  if (nonAllowlistedDiffObjects.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
      message:
        `定義が一致しないオブジェクトが ${nonAllowlistedDiffObjects.length} 件あります` +
        `（列/型/制約等の詳細はDDL本文を直接diffしてください）: ${nonAllowlistedDiffObjects.join(', ')}`,
      side: 'both',
    })
  }
  if (allowlistedDiffObjects.length > 0) {
    findings.push({
      severity: 'info',
      code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
      message:
        `定義差分が ${allowlistedDiffObjects.length} 件ありますが、allowlistに該当するため許容します: ` +
        allowlistedDiffObjects.map((o) => `${o.key}（${o.reason}）`).join(' / '),
      side: 'both',
      allowlisted: true,
      reason: [...new Set(allowlistedDiffObjects.map((o) => o.reason))].join(' / '),
    })
  }

  // extension比較（DDLブロックには現れないメタ情報のため、pg_catalogへの補助クエリで取得する。
  // Layer 1と同じ withReadOnlySnapshot でラップする、Issue #697本文タスク5）。
  const sourceExtensions = await withReadOnlySnapshot(sourceSql, fetchExtensions)
  const targetExtensions = await withReadOnlySnapshot(targetSql, fetchExtensions)
  const extensionDiff = compareExtensions(sourceExtensions, targetExtensions)
  // fail対象は「必須拡張機能の欠落」と「targetにしか無い拡張機能（allowlist非該当分のみ）」
  // （compareExtensionsのJSDoc参照）。source限定でもREQUIRED_EXTENSIONSに含まれないものは
  // informational（onlyInSourceInformationalとしてextensionDiffにそのまま残り、reportには
  // 載るがfailにはしない）。
  //
  // Issue #697 preview rehearsal followup（2026-07-22）: `onlyInTarget`のみをallowlistへ
  // 照会する（partitionAllowlistedTargetExtensionsのJSDoc参照）。`missingRequired`は
  // 意図的にこの照会を一切通さない（source側の必須拡張欠落は絶対に降格しない）。
  const { allowlisted: allowlistedExtensions, nonAllowlisted: nonAllowlistedExtensions } = partitionAllowlistedTargetExtensions(
    extensionDiff.onlyInTarget
  )
  if (extensionDiff.missingRequired.length > 0 || nonAllowlistedExtensions.length > 0) {
    findings.push({
      severity: 'fail',
      code: 'EXTENSION_MISMATCH',
      message:
        `extension構成が一致しません（必須拡張の欠落: ${extensionDiff.missingRequired.join(', ') || 'なし'} / ` +
        `target限定(allowlist非該当): ${nonAllowlistedExtensions.join(', ') || 'なし'}）`,
      side: 'both',
    })
  }
  if (allowlistedExtensions.length > 0) {
    findings.push({
      severity: 'info',
      code: 'EXTENSION_MISMATCH',
      message:
        `target限定の拡張機能が ${allowlistedExtensions.length} 件ありますが、allowlistに該当するため許容します: ` +
        allowlistedExtensions.map((e) => `${e.key}（${e.reason}）`).join(' / '),
      side: 'target',
      allowlisted: true,
      reason: [...new Set(allowlistedExtensions.map((e) => e.reason))].join(' / '),
    })
  }

  return {
    layer: 'schema',
    // 設計書「severityは fail / info の2値のみ」「layer pass = severity='fail' の
    // findingが0件」という他layer（layer-data.mjs/layer-invariants.mjs）と同じ規約に揃える
    // （Issue #697 preview rehearsal followup対応。修正前は`findings.length === 0`だったため、
    // allowlist該当によりinfoへ降格したfindingが1件でもあると無条件にpass=falseになり、
    // allowlistの意味が無くなっていた）。
    pass: !findings.some((f) => f.severity === 'fail'),
    findings,
    sourceSchemaDigest,
    targetSchemaDigest,
    objectDiff,
    extensionDiff,
    // normalizeDumpの警告（防御的除外の詳細、'public'スキーマ自身の除外のような正常系も含む）を
    // そのままreportに残す。fail判定には使わない（C-1のSCHEMA_UNEXPECTED_EXCLUSIONが判定を担う）が、
    // 運用者が目視で確認できるようにする。
    sourceWarnings: sourceNormalized.warnings,
    targetWarnings: targetNormalized.warnings,
    // informationalのみ（fail判定には使わない、Minor-8参照）。
    sourcePostgresMajorVersion,
    targetPostgresMajorVersion,
  }
}
