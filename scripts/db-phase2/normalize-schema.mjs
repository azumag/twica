#!/usr/bin/env node

/**
 * pg_dump の schema-only 出力を PlanetScale baseline へ正規化する / Issue #691 Chunk 1
 *
 * 背景:
 * `pg_dump --schema=public --schema-only --no-owner --no-privileges` の生出力（以下 raw dump）
 * には、そのまま PlanetScale へ適用してはいけない要素が理論上混入しうる
 * （--schema=public 指定なら本来混入しないはずの auth/realtime/storage 等の管理スキーマ、
 * --no-owner/--no-privileges 指定なら本来出力されないはずの OWNER/GRANT/REVOKE 文、
 * どのバージョンでも常に含まれる `public` スキーマ自身の再作成文など）。
 * 本モジュールはそれらを機械的に検出・除外し、安全に適用できる baseline SQL
 * （db/planetscale/public-schema.sql）を生成する。
 *
 * パース方式（Issue #691 設計方針）:
 * 素朴な `;` 区切りでSQL文を分割する方式は採らない。pg_dump のプレーンSQL出力は、
 * ダンプ対象オブジェクトの直前に必ず次の定型コメントブロック（TOC: Table of Contents
 * コメント）を出力する:
 *   --
 *   -- Name: <name>; Type: <type>; Schema: <schema>; Owner: -
 *   --
 * この「-- Name: X; Type: Y; Schema: Z; Owner: -」という行を境界としてオブジェクト単位に
 * 分割し、Type/Schema フィールドで種別判定する。SQL文字列そのものを字句解析する必要がなく、
 * 文字列リテラル中のセミコロン等で誤分割するリスクが無いという利点がある
 * （実際に Docker 上の実 dump で検証し、この境界検出方式が正しく機能することを確認済み。
 * 詳細は docs/planetscale-schema-baseline.md 参照）。
 *
 * 分類（3種類のみ、YAGNI判断で phase4-remove カテゴリは廃止済み）:
 *   - bring-as-is: そのまま db/planetscale/public-schema.sql へ出力する（table/function/
 *     trigger/index/sequence/view/constraint/policy/row security 等、大多数のオブジェクト）。
 *     RLS policy が auth.uid()/service_role 等の Supabase 互換オブジェクトを参照していても、
 *     db/planetscale/bootstrap.sql が baseline より先に適用され前提オブジェクトを用意するため、
 *     policy 自体はそのまま持ち込んでよい（bootstrap → baseline の適用順序が前提）。
 *   - compat-bootstrap: 概念上は「role スタブ・auth 関数・それに依存する処理」を指すカテゴリだが、
 *     実際にはこれらは pg_dump の出力（--schema=public 範囲）には一切現れない
 *     （auth スキーマ関数は別スキーマに属し、role はクラスタ全体のオブジェクトで
 *     スキーマダンプの対象外のため）。したがって本モジュールの分類ロジックが実際にこの
 *     カテゴリを割り当てることは無い（0件が期待値）。該当する内容は db/planetscale/bootstrap.sql
 *     に手書きで用意する別枠。カテゴリ自体は集計・将来の拡張性のために維持する
 *     （Issue #691 設計レビューで phase4-remove を compat-bootstrap と重複するとして廃止した際、
 *     3カテゴリ自体は維持する判断がされている）。
 *   - exclude: 以下のいずれかに該当する場合。防御的検知であり、通常の
 *     `--schema=public --schema-only --no-owner --no-privileges` 出力では発生しない想定
 *     （発生した場合は警告を出す。「除外して黙って進める」ことはしない）。
 *     1. auth/realtime/storage/vault/supabase_migrations スキーマ配下のオブジェクト
 *        （--schema=public 指定の取りこぼし・pg_dump挙動変化への防御）
 *     2. `public` スキーマ自身の CREATE SCHEMA / COMMENT ON SCHEMA 文。
 *        `public` スキーマは PostgreSQL の initdb が作成する既定スキーマであり、
 *        新規DB（PlanetScale の新規論理DBを含む）に最初から存在する。にもかかわらず
 *        pg_dump は常にこの2ブロックを出力するため、素通しすると
 *        `CREATE SCHEMA public;` が「schema "public" already exists」で失敗する
 *        （Docker実機検証で実際に確認した問題。ON_ERROR_STOP相当の厳格な適用スクリプトでは
 *        ここで停止してしまう）。
 *     3. owner/ACL文（`ALTER ... OWNER TO`、素の `GRANT`/`REVOKE`）。
 *        `--no-owner --no-privileges` により本来出力されないはずだが、pg_dump の
 *        バージョン差・オプション変化に備えて防御的に検出し除去する。
 *
 * \restrict / \unrestrict の扱い:
 * PostgreSQL 17.6 以降の pg_dump は、出力の冒頭・末尾に `\restrict <token>` /
 * `\unrestrict <token>` という psql 専用メタコマンドを付与する（dump の内容が想定外の
 * psql セッションで実行されるのを防ぐための機構）。これは SQL 文ではなく psql の
 * バックスラッシュコマンドのため、`postgres`（node-postgres系ではなく本リポジトリが
 * 使う porsager/postgres）等の SQL クライアント経由で `sql.unsafe()` に渡すと構文エラーに
 * なる。Docker 上の実 pg_dump 17.10 出力で実際に含まれることを確認済み
 * （docs/planetscale-schema-baseline.md 参照）。本モジュールは常にこれを検出・除去する。
 */

'use strict'

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

/** normalize-schema.mjs が割り当てるオブジェクト分類（ファイル冒頭コメント参照） */
export const OBJECT_CATEGORY = {
  BRING_AS_IS: 'bring-as-is',
  COMPAT_BOOTSTRAP: 'compat-bootstrap',
  EXCLUDE: 'exclude',
}

// --schema=public 指定でも万一混入した場合に備えて除外するSupabase管理スキーマ一覧。
// realtime.messages/realtime.topic()（00034）はSupabase Realtime継続利用のためPhase 2の
// 移送対象外（docs/planetscale-migration-audit.md 2.3節）、auth/storage/vault/
// supabase_migrationsも同様にpublicスキーマの範囲外であるべきオブジェクト。
const SUPABASE_MANAGED_SCHEMAS = ['auth', 'realtime', 'storage', 'vault', 'supabase_migrations']

// pg_dump が付与する TOC (Table of Contents) コメントの2行目。1行目・3行目は常に "--" のみ。
// 例: "-- Name: cards; Type: TABLE; Schema: public; Owner: -"
// Name フィールドはシグネチャ（"activate_support_code(text, text, text)" 等）で `; ` を
// 含まないため greedy な `.*` で問題なくパースできる（Type/Schema/Owner の各ラベルは
// 行末に向けて1回ずつしか現れないため、greedy マッチでも誤爆しない）。
const TOC_HEADER_LINE_RE = /^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*)$/m

// ブロック境界の検出: pg_dump は各オブジェクトの直前に必ず
//   --
//   -- Name: ...
// という2行を出力する（3行目の "--" は本正規表現の境界としては使わない。1行目の "--" と
// 2行目 "-- Name: " の組み合わせだけで十分に一意な境界になるため）。
// 行頭アンカー(^, multiline)を使うことで、SQL文字列リテラル中に偶然似た文字列が
// 現れても行の先頭からの完全一致でない限り誤検出しない。
//
// 注意: String.prototype.split(regex) は使わない。ECMAScript仕様上、ゼロ幅マッチが
// 文字列の先頭（index 0）に現れる場合、split() はそこで分割しない（先頭に空文字列の
// 要素を作らずスキップする）という既知の挙動があり、"入力がpreambleを一切持たず
// 最初のバイトから TOC ヘッダーで始まる" という（実際のpg_dumpでは起こらないが
// fixtureや将来の入力形式変化では起こりうる）エッジケースで境界を1つ検出し損なう。
// 代わりに exec() でマッチ位置を全て収集し、手動でスライスする（下記 splitIntoBlocks）。
const BLOCK_BOUNDARY_RE = /^--\n-- Name: /gm

// pg_dump 17.6+ が付与する psql 専用メタコマンド。行全体にマッチし、除去後は
// その行ごと（末尾の改行含む）消える。
const RESTRICT_METACOMMAND_RE = /^\\(un)?restrict \S+\n/gm

/**
 * raw dump から \restrict / \unrestrict メタコマンド行を除去する純粋関数。
 * @param {string} text
 * @returns {{ stripped: string, removedCount: number }}
 */
export function stripRestrictMetacommands(text) {
  const matches = text.match(RESTRICT_METACOMMAND_RE)
  const removedCount = matches ? matches.length : 0
  const stripped = text.replace(RESTRICT_METACOMMAND_RE, '')
  return { stripped, removedCount }
}

// pg_dump が preamble に出力する `SELECT pg_catalog.set_config('search_path', '', false);`。
// 第3引数（is_local）が false = セッションスコープで出力される。
const SET_CONFIG_SESSION_SCOPE_RE = /(pg_catalog\.set_config\([^,]+,\s*'[^']*',\s*)false(\s*\))/g

// preamble に出力される、LOCAL指定の無い素の `SET 変数名 = 値;` 行（例:
// `SET statement_timeout = 0;` `SET row_security = off;`）。`SET LOCAL` に書き換える対象。
// 既に `SET LOCAL` の行は除外する（多重適用の冪等性のため）。
const PLAIN_SESSION_SET_RE = /^SET (?!LOCAL\b)(\S.*);$/gm

/**
 * preamble中のセッションスコープ設定（`SET ...;` / `set_config(..., false)`）を
 * トランザクションローカル（`SET LOCAL` / `set_config(..., true)`）に書き換える純粋関数。
 * M-5 (Fableレビュー) 対応。
 *
 * 背景: `scripts/db-migrate.js` は単一コネクション（`max: 1`）で複数migrationファイルを
 * 順に適用する設計（advisory lockがセッションスコープのため）。pg_dumpのpreambleが出力する
 * `SELECT pg_catalog.set_config('search_path', '', false);` はセッションスコープの設定であり、
 * is_local=false のままだと baseline 適用（1トランザクション）のCOMMIT後もその接続に残り続け、
 * 同じ接続で後から適用される別のPlanetScale向けmigrationが `search_path=''` の状態で実行され、
 * 非修飾テーブル参照が軒並み失敗しうる。preambleの他のSET文（`row_security = off` 等）も同様に
 * セッションスコープで漏れうるため、`SET LOCAL` へ書き換えて対処する。
 * `SET LOCAL`/`set_config(..., true)` はいずれもトランザクションのcommit/rollbackと同時に
 * 自動的に元の値へ復元されるため、baseline側の1トランザクション内では従来通り効果を持ちつつ、
 * **preambleで検出された対象文に限り**後続migrationへ漏れなくなる（baselineファイルは
 * `migration-transaction: required` 宣言により常に `sql.begin()` でトランザクションに
 * 包んで実行されるため、`SET LOCAL` はファイル全体にわたって正しく効果を持つ）。
 *
 * 適用範囲をpreambleのみに限定する理由・既知の限界（N-3, Fableレビュー2回目で指摘・
 * 関数名/docsの説明を実態に合わせて修正）: ブロック本文（関数定義・CREATE TABLE等）中に
 * 万一同じ字面が現れても、それはユーザー定義オブジェクトの一部として意図された内容の
 * 可能性があり、機械的に書き換えるべきではない（preambleはpg_dumpが機械的に生成する
 * 定型部分であることが構造上保証されているため、ここだけを対象にするのが安全）。
 * このためこの関数はpreamble以外のセッションスコープ文には一切適用されない。実際、
 * pg_dumpはブロック本文の区切りとしても `SET default_tablespace = '';` /
 * `SET default_table_access_method = heap;` という素の（LOCAL指定の無い）SET文を出力する
 * （db/planetscale/public-schema.sql 内に実在、最初の CREATE TABLE 直前）。これらは本関数の
 * 対象外のため、理論上は同じ「セッションスコープのまま後続ファイルへ漏れる」パターンに該当する。
 * ただし出力される値（''／heap）はいずれもPostgreSQLのデフォルト値と同一であるため、
 * 漏れても後続migrationの実際の挙動は変化しない（現状は実害なしと判断・確認済み）。
 * 将来この既定値が変わる、または同種の非デフォルト値がブロック本文に出力されるように
 * pg_dumpの挙動が変化した場合は、本関数の対象範囲拡張を再検討すること。
 *
 * @param {string} preamble
 * @returns {string}
 */
export function neutralizePreambleSessionScope(preamble) {
  return preamble
    .replace(SET_CONFIG_SESSION_SCOPE_RE, '$1true$2')
    .replace(PLAIN_SESSION_SET_RE, 'SET LOCAL $1;')
}

/**
 * \restrict 除去後のテキストを「preamble（最初のTOCブロックより前の部分。SETコマンド等）」と
 * 「TOCブロックの配列（元の出現順）」に分割する純粋関数。
 *
 * 各ブロックの `raw` は「自分の TOC ヘッダーから、次のブロックの TOC ヘッダー直前まで」の
 * 全テキスト（間に挟まる空行や `SET default_tablespace = '';` のようなセクション区切りの
 * 補助文も含む）を保持する。これにより
 * `preamble + blocks.map(b => b.raw).join('')` が除去後テキストと完全に一致する
 * （round-trip 不変条件、tests/unit/db-phase2/normalize-schema.test.ts で検証）。
 *
 * @param {string} strippedText \restrict 除去後のテキスト
 * @returns {{ preamble: string, blocks: Array<{ raw: string, name: string, type: string, schema: string, owner: string }> }}
 */
export function splitIntoBlocks(strippedText) {
  // BLOCK_BOUNDARY_RE は g フラグ付きのためexec()を繰り返し呼ぶたびlastIndexが進む。
  // マッチ位置（境界の開始index）を先に全て収集してからスライスする
  // （String.split()の position-0 ゼロ幅マッチの既知の落とし穴を回避するため。
  // 本ファイル冒頭のBLOCK_BOUNDARY_REコメント参照）。
  const boundaryIndices = []
  let match
  while ((match = BLOCK_BOUNDARY_RE.exec(strippedText)) !== null) {
    boundaryIndices.push(match.index)
  }

  // M-1 (Fableレビュー): 境界が1件も見つからない場合、以前はフェイルオープンして
  // 全文をpreamble扱いにし、警告無しでそのままbaselineへ出力していた
  // （TOCヘッダーを1つも持たない入力＝GRANT文やCREATE SCHEMA public;等の危険な文が
  // 一切パース・分類されずに素通りする、というfixtureでの再現を確認済み）。
  // 実際のpg_dump出力（--schema=public --schema-only）で境界0件はまず起こらない
  // （最低でもupdate_updated_at_column()等の関数が1つは出力される）ため、
  // 「0件」は入力形式の想定外（空ファイル・pg_dump以外の出力を誤って渡した等）を
  // 意味する可能性が高い。安全側に倒し、黙って通さずfail-fastする。
  if (boundaryIndices.length === 0) {
    throw new Error(
      'normalize-schema: TOC境界（"-- Name: ...; Type: ...; Schema: ...; Owner: ..." ヘッダー）が' +
        '1件も見つかりませんでした。入力が空、またはpg_dumpの出力形式と異なる可能性があります。' +
        '全文をpreamble扱いにして未分類のまま出力する（フェイルオープン）ことはしません。'
    )
  }

  const preamble = strippedText.slice(0, boundaryIndices[0])

  const blocks = boundaryIndices.map((start, index) => {
    const end = index + 1 < boundaryIndices.length ? boundaryIndices[index + 1] : strippedText.length
    const raw = strippedText.slice(start, end)
    const headerMatch = raw.match(TOC_HEADER_LINE_RE)
    if (!headerMatch) {
      // splitIntoBlocks は BLOCK_BOUNDARY_RE で区切った直後のセグメントを渡しており、
      // 各セグメントは必ず "-- Name: " 行から始まる構造上の保証がある。
      // ここに到達する場合は正規表現の前提が崩れている（pg_dump の出力形式が変わった等）ため、
      // 誤ったカテゴリ分類で黙って処理を続けるより、fail-fast で早期に気付けるようにする。
      throw new Error(
        `normalize-schema: TOCヘッダーのパースに失敗しました（${index + 1}番目のブロック）。` +
          'pg_dump の出力形式が想定と異なる可能性があります。'
      )
    }
    const [, name, type, schema, owner] = headerMatch
    return { raw, name: name.trim(), type: type.trim(), schema: schema.trim(), owner: owner.trim() }
  })

  return { preamble, blocks }
}

/**
 * 1ブロックの分類を判定する純粋関数。
 * @param {{ name: string, type: string, schema: string }} block
 * @returns {{ category: string, reason: string | null }}
 */
export function classifyBlock({ name, type, schema }) {
  if (SUPABASE_MANAGED_SCHEMAS.includes(schema)) {
    return { category: OBJECT_CATEGORY.EXCLUDE, reason: `supabase-managed-schema:${schema}` }
  }

  // `public` スキーマ自身の再作成文。ファイル冒頭コメント「exclude」節の2番を参照。
  if (type === 'SCHEMA' && name === 'public') {
    return { category: OBJECT_CATEGORY.EXCLUDE, reason: 'public-schema-preexists' }
  }
  if (type === 'COMMENT' && name === 'SCHEMA public') {
    return { category: OBJECT_CATEGORY.EXCLUDE, reason: 'public-schema-preexists' }
  }

  // ACL/DEFAULT ACL は `--no-privileges` で本来出力されないはずの防御的検知。
  if (type === 'ACL' || type === 'DEFAULT ACL') {
    return { category: OBJECT_CATEGORY.EXCLUDE, reason: 'owner-or-acl-defensive' }
  }

  return { category: OBJECT_CATEGORY.BRING_AS_IS, reason: null }
}

// Type フィールドが ACL 等でなくても、本文（ヘッダー行より後の部分）に直接
// OWNER/GRANT/REVOKE 文が紛れ込んでいないかを走査する第二の防御線。
// `--no-owner --no-privileges` が効いていれば通常は一致しないが、pg_dump のバージョン差や
// オプションの指定漏れに備える（1行目のTypeフィールドだけに頼らない多重防御）。
const OWNER_OR_ACL_STATEMENT_RE = /^(ALTER\s+\S+(?:\s+\S+)*\s+OWNER\s+TO\s+.+;|GRANT\s+.+;|REVOKE\s+.+;)$/m

/**
 * ブロック本文に owner/ACL 文が直接含まれていないかを検査する純粋関数。
 * @param {string} raw ブロック全体のテキスト（ヘッダー含む）
 * @returns {boolean}
 */
export function containsOwnerOrAclStatement(raw) {
  return OWNER_OR_ACL_STATEMENT_RE.test(raw)
}

/**
 * raw dump 全体を正規化し、bring-as-is ブロックのみを結合した出力を作る。
 * export-public-schema.mjs のオブジェクト種別集計（manifest.json 用）でも
 * このパース結果を再利用できるよう、preamble/blocks/warnings をすべて返す。
 *
 * `output` の preamble 部分は `neutralizePreambleSessionScope()` によりセッションスコープ設定
 * （`SET ...;` / `set_config(..., false)`）がトランザクションローカル（`SET LOCAL` /
 * `set_config(..., true)`）へ書き換え済み（M-5 対応、詳細は同関数のコメント参照）。
 * 戻り値の `preamble`（round-trip不変条件用）自体は書き換え前の値のまま。
 *
 * @param {string} rawText pg_dump の生出力（\restrict 除去前でよい）
 * @returns {{
 *   output: string,
 *   preamble: string,
 *   blocks: Array<{ raw: string, name: string, type: string, schema: string, owner: string, category: string, reason: string | null }>,
 *   restrictRemovedCount: number,
 *   warnings: string[],
 *   countsByCategory: Record<string, number>,
 *   countsByType: Record<string, number>,
 * }}
 */
export function normalizeDump(rawText) {
  const { stripped, removedCount: restrictRemovedCount } = stripRestrictMetacommands(rawText)
  const { preamble, blocks: rawBlocks } = splitIntoBlocks(stripped)

  const warnings = []
  const countsByType = {}
  const countsByCategory = { [OBJECT_CATEGORY.BRING_AS_IS]: 0, [OBJECT_CATEGORY.COMPAT_BOOTSTRAP]: 0, [OBJECT_CATEGORY.EXCLUDE]: 0 }

  const blocks = rawBlocks.map((block) => {
    countsByType[block.type] = (countsByType[block.type] ?? 0) + 1

    let { category, reason } = classifyBlock(block)

    // Type フィールドベースの判定を通過したブロックについても、本文レベルの
    // owner/ACL防御チェックを重ねて適用する（多重防御。ファイル冒頭コメント参照）。
    if (category === OBJECT_CATEGORY.BRING_AS_IS && containsOwnerOrAclStatement(block.raw)) {
      category = OBJECT_CATEGORY.EXCLUDE
      reason = 'owner-or-acl-defensive-body-scan'
    }

    if (category === OBJECT_CATEGORY.EXCLUDE) {
      warnings.push(
        `[normalize-schema] 除外: ${block.type} "${block.name}" (schema=${block.schema}, reason=${reason})`
      )
    }

    countsByCategory[category] = (countsByCategory[category] ?? 0) + 1
    return { ...block, category, reason }
  })

  // M-5 (Fableレビュー): 出力（output）にはセッションスコープ設定をトランザクションローカルに
  // 書き換えたpreambleを使う。`preamble`（戻り値・round-trip不変条件で使う）自体は
  // \restrict除去後の「元のテキストそのまま」を保つ（splitIntoBlocksのround-trip契約を
  // 変えないため）。書き換えは出力生成の最終段階でのみ適用する。
  const normalizedPreamble = neutralizePreambleSessionScope(preamble)

  const output =
    normalizedPreamble +
    blocks.filter((b) => b.category === OBJECT_CATEGORY.BRING_AS_IS).map((b) => b.raw).join('')

  return { output, preamble, blocks, restrictRemovedCount, warnings, countsByCategory, countsByType }
}

// ---------------------------------------------------------------------------
// CLI エントリポイント
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PATH = 'db/planetscale/.artifacts/public-schema.raw.sql'
const DEFAULT_OUTPUT_PATH = 'db/planetscale/public-schema.sql'

// M-2 (Fableレビュー): 防御的除外理由のうち、これだけは「常に発生する既知の正常系」
// （`public` スキーマ自身の再作成文。pg_dumpが常に出力し、常にexcludeする設計。
// classifyBlock の 'public-schema-preexists' 参照）。それ以外の除外理由
// （auth等の管理スキーマ混入・owner/ACL混入）は「本来発生しないはず」の防御的検知であり、
// 発生した場合は運用者が内容を確認すべき異常系として扱う（非0終了、runCli参照）。
const EXPECTED_EXCLUSION_REASONS = new Set(['public-schema-preexists'])

/**
 * ブロック配列から「想定外の防御的除外」（'public-schema-preexists' 以外の理由でexcludeされた
 * ブロック）を抽出する純粋関数。M-2 (Fableレビュー) のCI非0終了ゲートで使う。
 * runCli() から切り出した純粋関数（DB/ファイルI/O無し、単体テスト対象）。
 * @param {Array<{ category: string, reason: string | null }>} blocks
 * @returns {Array<{ category: string, reason: string | null }>}
 */
export function findUnexpectedExclusions(blocks) {
  return blocks.filter(
    (b) => b.category === OBJECT_CATEGORY.EXCLUDE && !EXPECTED_EXCLUSION_REASONS.has(b.reason)
  )
}

// Minor (Fableレビュー): parseCliArgs は export-public-schema.mjs の parseCliArgs と同じ
// 「純粋関数として返り値のみでエラーを表現し、console出力・process.exitCodeの副作用は
// 呼び出し側（runCli/main）が担う」流儀に統一する（以前は本関数内で console.error +
// process.exitCode を直接書いており、2ファイル間で流儀が食い違っていた）。
export function parseCliArgs(argv) {
  const args = argv.slice(2)
  let input = DEFAULT_INPUT_PATH
  let output = DEFAULT_OUTPUT_PATH
  let allowExclusions = false
  for (const arg of args) {
    if (arg.startsWith('--input=')) input = arg.slice('--input='.length)
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length)
    else if (arg === '--allow-exclusions') allowExclusions = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `不明な引数です: ${arg}` }
  }
  return { input, output, allowExclusions }
}

function runCli() {
  const parsed = parseCliArgs(process.argv)
  if (parsed.help) {
    console.log(
      [
        '使い方: node scripts/db-phase2/normalize-schema.mjs [--input=<path>] [--output=<path>] [--allow-exclusions]',
        `  --input=<path>      入力raw dump（既定: ${DEFAULT_INPUT_PATH}）`,
        `  --output=<path>     出力baseline SQL（既定: ${DEFAULT_OUTPUT_PATH}）`,
        '  --allow-exclusions  想定外の防御的除外（auth等の管理スキーマ混入・owner/ACL混入）が',
        '                      発生していても異常終了せず続行する。指定が無い場合、',
        '                      "public"スキーマ自身の除外（常に発生する既知の正常系）以外の',
        '                      除外が1件でもあれば exit 1 で終了する（CIで黙って通さないため）。',
      ].join('\n')
    )
    return
  }
  if (parsed.error) {
    console.error(`[normalize-schema] ${parsed.error}`)
    process.exitCode = 1
    return
  }

  const { input, output, allowExclusions } = parsed
  let rawText
  try {
    rawText = readFileSync(input, 'utf8')
  } catch (error) {
    console.error(`[normalize-schema] 入力ファイルを読み込めませんでした: ${input}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    console.error('  先に scripts/db-phase2/export-public-schema.mjs を実行してください。')
    process.exitCode = 1
    return
  }

  // M-1 (Fableレビュー): normalizeDump は TOC境界0件等の構造的な想定外入力に対して
  // 例外を投げる（fail-fast）。CLIとしては生の stack trace を出すより、他のエラー経路
  // （入力ファイル読み込み失敗等）と同じ体裁の明確なエラーメッセージを出す方が
  // CI/運用者にとって分かりやすいため、ここで捕捉して整形する
  // （出力ファイルへは一切書き込まないまま終了する点は変わらない）。
  let result
  try {
    result = normalizeDump(rawText)
  } catch (error) {
    console.error('[normalize-schema] 正規化に失敗しました:')
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }

  console.log(`[normalize-schema] 入力: ${input}`)
  console.log(`[normalize-schema] \\restrict/\\unrestrict 除去: ${result.restrictRemovedCount}件`)
  console.log(`[normalize-schema] オブジェクト種別ごとの件数:`)
  for (const [type, count] of Object.entries(result.countsByType).sort()) {
    console.log(`    ${type}: ${count}`)
  }
  console.log(`[normalize-schema] 分類結果:`)
  for (const [category, count] of Object.entries(result.countsByCategory)) {
    console.log(`    ${category}: ${count}`)
  }
  if (result.warnings.length > 0) {
    console.warn(`[normalize-schema] 警告 (${result.warnings.length}件、防御的除外の詳細):`)
    for (const w of result.warnings) console.warn(`  ${w}`)
  }

  // M-2 (Fableレビュー): 「public自身の除外」以外の防御的除外（auth等の管理スキーマ混入・
  // owner/ACL混入）が1件でもあれば、CI・自動化文脈で黙って exit 0 のまま通さない。
  // これらは「--schema=public --no-owner --no-privileges が正しく機能していれば
  // 発生しないはず」の異常系であり、発生した場合は人間が内容を確認すべき
  // （containsOwnerOrAclStatement は関数本体内の行頭 GRANT 文等に誤マッチしうるため、
  // ブロック丸ごとがbaselineから静かに消えるリスクがある）。
  //
  // N-2 (Fableレビュー2回目): このゲート判定は、出力ファイルへの書き込みより「前」に
  // 行う（以前は書き込み後にチェックしていたため、exit 1 で異常終了してもブロック欠落した
  // baselineファイルがディスクに残ってしまい、exit codeを見ない手動運用（ファイルの存在
  // だけを見て「生成された」と誤判断する等）で事故になりうる）。書き込み（mkdirSync/
  // writeFileSync）はこのゲートを通過した場合のみ実行する。
  const unexpectedExclusions = findUnexpectedExclusions(result.blocks)
  if (unexpectedExclusions.length > 0) {
    console.warn(
      `[normalize-schema] 想定外の防御的除外: ${unexpectedExclusions.length}件` +
        '（"public"スキーマ自身の除外を除く。上記の警告ログ参照）'
    )
    if (!allowExclusions) {
      console.error(
        '[normalize-schema] 想定外の除外が発生したため異常終了します（exit 1）。' +
          '出力ファイルへは書き込みません。' +
          '内容を確認したうえで意図的に許容する場合は --allow-exclusions を指定して再実行してください。'
      )
      process.exitCode = 1
      return
    }
    console.warn('[normalize-schema] --allow-exclusions が指定されているため続行します。')
  }

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, result.output, 'utf8')
  console.log(`[normalize-schema] 出力: ${output}`)
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
