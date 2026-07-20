#!/usr/bin/env node

/**
 * twica_meta.database_identity の自己管理スキーマ・DDL・読み書きロジック / Issue #697 Chunk 1
 *
 * 背景（なぜmigrationファイルを追加しないか、Critical）:
 * `scripts/db-migrate.js` の `resolveMigrationsDirs` は `--provider=planetscale` 実行時に
 * `supabase/migrations/` と `db/planetscale/migrations/` をマージして1本の適用列にする。
 * 同名のmigrationを両方に置くと二重適用・バージョン衝突エラーになりうる。また
 * `supabase/migrations/` に置いた場合、`.github/workflows/deploy-cloudflare.yml` の
 * `supabase db push --yes` がSupabase prod/previewへ自動適用してしまう
 * （`migration-providers` ヘッダーはSupabase CLIには解釈されない、通常のSQLコメントとして
 * 無視される）。よって `twica_meta.database_identity` は `scripts/lib/db-migrate-core.js` の
 * `HISTORY_SCHEMA_SQL`（`create schema if not exists twica_meta`）と同じ流儀で、
 * cutoverツール自身が `CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` で
 * 自己管理する（migrationファイルを一切追加しない）。
 *
 * schema自体は db-migrate-core.js が作る `twica_meta` schema を再利用する（HISTORY_SCHEMA_SQL
 * を直接importして使う。同一DDL文字列を2箇所に重複定義しない）。
 */

'use strict'

import crypto from 'crypto'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

/**
 * twica_meta.database_identity テーブルのDDL。Issue #697本文の定義そのまま。
 * PKが `environment` であること自体は「1つのDBインスタンス内で同じenvironment値の行を
 * 重複させない」制約に過ぎない。運用上、1つのDBインスタンスにはこの行が常に高々1件しか
 * 存在しない想定（このDBインスタンス自身が「どの環境か」を表す自己申告の1行）。
 */
export const IDENTITY_TABLE_SQL = `
create table if not exists twica_meta.database_identity (
  environment text primary key,
  provider text not null,
  instance_id uuid not null,
  initialized_at timestamptz not null
)
`.trim()

/** init-identity・Layer 1 双方が受け付ける environment / provider の許容値。 */
export const VALID_IDENTITY_ENVIRONMENTS = ['production', 'preview']
export const VALID_IDENTITY_PROVIDERS = ['supabase', 'planetscale']

/**
 * twica_meta スキーマ・database_identity テーブルを（無ければ）作成する。
 * db-migrate.js の apply 同様、IF NOT EXISTS のため何度呼んでも安全（冪等）。
 * @param {import('postgres').Sql} sql
 */
export async function ensureIdentitySchema(sql) {
  await sql.unsafe(core.HISTORY_SCHEMA_SQL)
  await sql.unsafe(IDENTITY_TABLE_SQL)
}

/**
 * database_identity の現在の状態を読む（DB接続あり、単体テスト対象外。
 * 決定ロジックは decideSeedAction / 呼び出し側の純粋関数に切り出してテストする）。
 *
 * テーブルが存在しない場合は tableExists=false を返す（ensureIdentitySchema実行前でも
 * エラーにならない。呼び出し側が「読んでから必要なら作る」という順序を選べるようにするため）。
 *
 * @param {import('postgres').Sql} sql
 * @returns {Promise<{ tableExists: boolean, rows: Array<{ environment: string, provider: string, instance_id: string, initialized_at: Date }> }>}
 */
export async function readIdentityState(sql) {
  const [{ reg }] = await sql`select to_regclass('twica_meta.database_identity') as reg`
  if (!reg) return { tableExists: false, rows: [] }
  const rows = await sql`
    select environment, provider, instance_id, initialized_at
    from twica_meta.database_identity
    order by environment
  `
  return { tableExists: true, rows }
}

/**
 * 接続ロールがRLSを迂回できる（＝行が静かにフィルタされる心配が無い）かを確認する。
 * Layer 1 の「ロール権限アサーション」（Issue #697本文 Major）で使う。
 * RLSを迂回できないロールは、後続layer（件数・checksum）が誤った結果になりうるため、
 * デフォルトではこれを必須とする。
 *
 * PostgreSQLの仕様上、**BYPASSRLS属性を持つロールだけでなく、スーパーユーザーも常に
 * RLSを迂回する**（rolsuper は既定でrolbypassrls=falseのまま迂回できるため、
 * rolbypassrlsだけを見るとスーパーユーザー接続を誤ってfail判定してしまう。
 * Fableレビュー M-1で指摘・修正）。
 * @param {import('postgres').Sql} sql
 * @returns {Promise<boolean>}
 */
export async function checkBypassRls(sql) {
  const rows = await sql`select (rolbypassrls or rolsuper) as can_bypass from pg_roles where rolname = current_user`
  return rows.length > 0 && rows[0].can_bypass === true
}

/**
 * seedIdentity が既存行の有無・--forceに基づいてどう振る舞うべきかを決める純粋関数
 * （DB接続なし、単体テスト対象）。db-migrate-core.js の diffMigrationState 等と同じ
 * 「DB I/Oを伴う関数から意思決定ロジックだけを切り出す」流儀。
 *
 * Minor-5（Fableレビュー）: 当初は第1引数に `{ environment, provider }`（seedしたい値）を
 * 受け取っていたが、本関数の分岐ロジックはこれらの値を一切参照しない
 * （既存行の有無とforceフラグだけで action が決まる）ため、未使用引数として削除した
 * （`void environment; void provider` という「使わないことを明示するためだけのコード」も
 * 併せて不要になる）。
 *
 * @param {Array<{ environment: string, provider: string, instance_id: string, initialized_at: Date }>} existingRows
 * @param {boolean} force
 * @returns {
 *   { action: 'reject', existingRows: typeof existingRows } |
 *   { action: 'insert' } |
 *   { action: 'overwrite', preservedInstanceId: string, preservedInitializedAt: Date }
 * }
 */
export function decideSeedAction(existingRows, force) {
  if (existingRows.length === 0) {
    return { action: 'insert' }
  }
  if (!force) {
    return { action: 'reject', existingRows }
  }
  // --force指定時: instance_id・initialized_atは初回seed時の値を必ず引き継ぐ
  // （Issue #697本文: 「一度seedしたらinstance_idは変わらないことがidentity検証の前提」）。
  // 複数行が既に存在する異常系（本来あり得ないが、手動SQL操作等での事故を想定）でも、
  // 最初の行のinstance_idを代表値として引き継ぐ（決め打ちではなく「どれか選ばないと
  // --forceが機能しない」という制約下での安全側の選択。呼び出し側がログで複数行の存在自体を
  // 警告する設計とセットで運用する）。
  const [first] = existingRows
  return { action: 'overwrite', preservedInstanceId: first.instance_id, preservedInitializedAt: first.initialized_at }
}

/**
 * database_identity 行をseedする（DB接続あり、単体テスト対象外。決定ロジックは
 * decideSeedAction でテスト済み）。呼び出し側（init-identity.mjs CLI）が
 * ensureIdentitySchema を先に呼んでおくことを前提とする。
 *
 * TOCTOU対策について（オーケストレーターレビュー Minor-4対応）: 以前はread（既存行の取得）→
 * decide（純粋関数）→write（insert/delete+insert）が別々の暗黙トランザクションで実行されており、
 * readとwriteの間に他プロセスが割り込む余地があった（例: 2つのinit-identityプロセスが
 * ほぼ同時に実行され、両方とも「既存行なし」を読んでどちらもinsertしようとする）。
 * 関数全体を`sql.begin()`で1トランザクションに包むことで、この隙間を無くす。
 * なお、完全なテーブルロック（`LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`）までは行わない
 * （YAGNI: このツールは4つの実インスタンスそれぞれに対して手動で個別実行される設計であり
 * 〔Issue #697本文〕、真の同時実行が起こる可能性は極めて低い）。真に同時にinsertが競合した
 * 場合は `environment` 列のPRIMARY KEY制約により一方がunique_violationで失敗する
 * （サイレントな不整合ではなく、fail-loudな安全側の挙動）。
 *
 * @param {import('postgres').Sql} sql
 * @param {{ environment: string, provider: string, force: boolean }} args
 * @returns {Promise<
 *   { outcome: 'inserted', instanceId: string, initializedAt: Date } |
 *   { outcome: 'overwritten', instanceId: string, initializedAt: Date, previousRows: Array<{ environment: string, provider: string }> } |
 *   { outcome: 'rejected', existingRows: Array<{ environment: string, provider: string, instance_id: string }> }
 * >}
 */
export async function seedIdentity(sql, { environment, provider, force }) {
  return sql.begin(async (tx) => {
    const { rows: existingRows } = await readIdentityState(tx)
    const decision = decideSeedAction(existingRows, force)

    if (decision.action === 'reject') {
      return { outcome: 'rejected', existingRows }
    }

    if (decision.action === 'insert') {
      const instanceId = crypto.randomUUID()
      const initializedAt = new Date()
      await tx`
        insert into twica_meta.database_identity (environment, provider, instance_id, initialized_at)
        values (${environment}, ${provider}, ${instanceId}, ${initializedAt})
      `
      return { outcome: 'inserted', instanceId, initializedAt }
    }

    // overwrite: 既存行を全削除してから、保持したinstance_id/initialized_atで入れ直す。
    // PKがenvironmentのため、environment値自体を変更するケース（例: 誤ってpreviewとして
    // seedしたDBをproductionへ訂正する）はON CONFLICTでは表現できず、DELETE→INSERTが必要。
    // read/decide/write全体が同一トランザクション（tx）内で完結するため、途中で失敗すれば
    // 全てロールバックされ、行が消えたまま残ることは無い。
    await tx`delete from twica_meta.database_identity`
    await tx`
      insert into twica_meta.database_identity (environment, provider, instance_id, initialized_at)
      values (${environment}, ${provider}, ${decision.preservedInstanceId}, ${decision.preservedInitializedAt})
    `
    return {
      outcome: 'overwritten',
      instanceId: decision.preservedInstanceId,
      initializedAt: decision.preservedInitializedAt,
      previousRows: existingRows.map((r) => ({ environment: r.environment, provider: r.provider })),
    }
  })
}
