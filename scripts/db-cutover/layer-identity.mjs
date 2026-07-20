#!/usr/bin/env node

/**
 * Layer 1: database identity 検証 / Issue #697 Chunk 1
 *
 * source/target 双方の twica_meta.database_identity を読み、以下を検証する
 * （Issue #697本文の明示要求）:
 *   - 同一 instance_id なら即fail（同じDBを比較している）
 *   - CLI引数で明示指定された --source-environment/--target-environment と、
 *     実際にDBから読んだ environment 列が食い違ったら即fail
 *   - provider 列も同様にCLI引数の期待値と照合
 *   - 接続ロールが rolbypassrls を持たない場合は即fail（RLSによる行の静かなフィルタが
 *     後続layerの件数/checksumを誤らせるリスクがあるため。デフォルトBYPASSRLS必須）
 *
 * withReadOnlySnapshot でラップした読み取り専用トランザクション内で全クエリを実行する
 * （Issue #697本文タスク5）。
 */

'use strict'

import { withReadOnlySnapshot } from './snapshot.mjs'
import { readIdentityState, checkBypassRls } from './identity-store.mjs'

/**
 * 1接続分（source または target）の identity + BYPASSRLS 状態を読み取る内部ヘルパー。
 * withReadOnlySnapshot の外側から呼ばれることを想定（tx を渡す）。
 * @param {import('postgres').Sql} tx
 */
async function readSideState(tx) {
  const { tableExists, rows } = await readIdentityState(tx)
  const bypassRls = await checkBypassRls(tx)
  return { tableExists, rows, bypassRls }
}

/**
 * 1つのfindingを組み立てるヘルパー（構造を統一するため）。
 * @param {string} code
 * @param {string} message
 * @param {'source'|'target'|'both'} side
 */
function finding(code, message, side) {
  return { severity: 'fail', code, message, side }
}

/**
 * side（'source'|'target'）1つ分の状態を検証し、findingsを積む純粋関数。
 * テーブル不存在・行0件・行複数件はこの時点でfindingを積んで終了する
 * （instance_id比較等の後続チェックはこれらのエラーが無いことが前提のため）。
 *
 * DB接続を一切持たない（`state` は既にDBから読み終えた後の素のデータ）ため、
 * tests/unit/db-cutover/layer-identity.test.ts はDBもpostgres.jsのモックも用意せず
 * このまま直接呼び出してテストできる（db-migrate-core.js の diffMigrationState と同じ
 * 「pure decision + thin DB wrapper」流儀）。
 *
 * @param {'source'|'target'} side
 * @param {{ tableExists: boolean, rows: Array<{environment:string, provider:string, instance_id:string}>, bypassRls: boolean }} state
 * @param {{ environment: string, provider: string }} expected
 * @param {Array<object>} findings 呼び出し側が用意した配列。見つかったfindingを追加でpushする
 * @returns {{ ok: boolean, identity: { environment: string, provider: string, instanceId: string } | null, bypassRls: boolean }}
 */
export function evaluateSideState(side, state, expected, findings) {
  let identity = null
  let ok = true

  // オーケストレーターレビュー Minor-1対応: 以前はテーブル不存在・行0件・行複数件の場合に
  // 即座にreturnしてしまい、BYPASSRLSチェックまで到達しなかった。1回の実行で複数の問題
  // （例: identity行が無い上にBYPASSRLSも無い）があると、1つ直して再実行してようやく
  // 次の問題が見つかる、という手戻りが発生していた。テーブル/行の状態に関わらず
  // BYPASSRLSチェックは必ず実行し、全ての問題を1回でfindingsに積む。
  if (!state.tableExists) {
    findings.push(finding('IDENTITY_TABLE_MISSING', `${side}: twica_meta.database_identity テーブルが存在しません。先に db:cutover:init-identity を実行してください。`, side))
    ok = false
  } else if (state.rows.length === 0) {
    findings.push(finding('IDENTITY_ROW_MISSING', `${side}: twica_meta.database_identity に行がありません。先に db:cutover:init-identity を実行してください。`, side))
    ok = false
  } else if (state.rows.length > 1) {
    findings.push(finding('IDENTITY_MULTIPLE_ROWS', `${side}: twica_meta.database_identity に複数行があります（想定は1行）。手動での事故的なINSERTを疑ってください。`, side))
    ok = false
  } else {
    const row = state.rows[0]
    identity = { environment: row.environment, provider: row.provider, instanceId: row.instance_id }

    if (identity.environment !== expected.environment) {
      findings.push(
        finding(
          'ENVIRONMENT_MISMATCH',
          `${side}: --${side}-environment=${expected.environment} が指定されましたが、実DBのenvironment列は "${identity.environment}" でした。`,
          side
        )
      )
      ok = false
    }
    if (identity.provider !== expected.provider) {
      findings.push(
        finding(
          'PROVIDER_MISMATCH',
          `${side}: --${side}-provider=${expected.provider} が指定されましたが、実DBのprovider列は "${identity.provider}" でした。`,
          side
        )
      )
      ok = false
    }
  }

  // テーブル/行の状態（上のif/else）に関わらず、必ず評価する。
  if (!state.bypassRls) {
    findings.push(
      finding(
        'BYPASSRLS_REQUIRED',
        `${side}: 接続ロールが BYPASSRLS を持っていません。RLSにより行が静かにフィルタされ、後続layerの件数/checksumが誤った結果になる可能性があるため fail として扱います。`,
        side
      )
    )
    ok = false
  }

  return { ok, identity, bypassRls: state.bypassRls }
}

/**
 * Layer 1 の判定ロジック本体（純粋関数、DB接続なし）。source/targetそれぞれの状態
 * （readSideStateの戻り値と同じ形）を受け取り、evaluateSideStateでの検証 + instance_id
 * 衝突チェックを行い、layer結果オブジェクトを組み立てる。
 * runIdentityLayer（DB接続あり）はこの関数にDB fetch結果を渡すだけの薄いラッパー。
 *
 * @param {{
 *   sourceState: { tableExists: boolean, rows: Array<object>, bypassRls: boolean },
 *   targetState: { tableExists: boolean, rows: Array<object>, bypassRls: boolean },
 *   expected: { sourceEnvironment: string, sourceProvider: string, targetEnvironment: string, targetProvider: string },
 * }} args
 * @returns {{
 *   layer: 'identity', pass: boolean, findings: Array<{severity: string, code: string, message: string, side: string}>,
 *   source: { environment: string, provider: string, instanceId: string, bypassRls: boolean } | null,
 *   target: { environment: string, provider: string, instanceId: string, bypassRls: boolean } | null,
 * }}
 */
export function evaluateIdentityLayer({ sourceState, targetState, expected }) {
  const findings = []

  const sourceEval = evaluateSideState(
    'source',
    sourceState,
    { environment: expected.sourceEnvironment, provider: expected.sourceProvider },
    findings
  )
  const targetEval = evaluateSideState(
    'target',
    targetState,
    { environment: expected.targetEnvironment, provider: expected.targetProvider },
    findings
  )

  // instance_id比較は両側ともidentity行が正常に読めた場合のみ意味を持つ。
  if (sourceEval.identity && targetEval.identity && sourceEval.identity.instanceId === targetEval.identity.instanceId) {
    findings.push(
      finding(
        'IDENTITY_INSTANCE_ID_COLLISION',
        `source と target の instance_id が同一です（${sourceEval.identity.instanceId}）。同じDBインスタンスを比較しています。`,
        'both'
      )
    )
  }

  return {
    layer: 'identity',
    pass: findings.length === 0,
    findings,
    source: sourceEval.identity ? { ...sourceEval.identity, bypassRls: sourceEval.bypassRls } : null,
    target: targetEval.identity ? { ...targetEval.identity, bypassRls: targetEval.bypassRls } : null,
  }
}

/**
 * Layer 1 本体（DB接続あり）。source/targetそれぞれの twica_meta.database_identity 状態を
 * withReadOnlySnapshot 経由で読み取り、evaluateIdentityLayer（純粋関数）へ委譲する。
 *
 * @param {{
 *   sourceSql: import('postgres').Sql,
 *   targetSql: import('postgres').Sql,
 *   expected: { sourceEnvironment: string, sourceProvider: string, targetEnvironment: string, targetProvider: string },
 * }} args
 */
export async function runIdentityLayer({ sourceSql, targetSql, expected }) {
  // source/target は別接続のため、順番に withReadOnlySnapshot を呼ぶ
  // （Issue #697 YAGNI方針: concurrency制御は実装しない。単純に逐次実行する）。
  const sourceState = await withReadOnlySnapshot(sourceSql, readSideState)
  const targetState = await withReadOnlySnapshot(targetSql, readSideState)

  return evaluateIdentityLayer({ sourceState, targetState, expected })
}
