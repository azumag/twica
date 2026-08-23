#!/usr/bin/env node

/**
 * Layer 5（業務invariant）実行本体 / Issue #697 Chunk 3
 *
 * invariant-checks.mjs が定義するSQL（純粋関数の出力）を実際にsource/target双方へ発行し、
 * 判定結果を組み立てる。layer-data.mjs（Chunk 2）と同じ「pure decision + thin DB wrapper」
 * 構成を踏襲する: `readSideInvariants`（DB接続あり、1接続分の生データを集める）→
 * `evaluateInvariantsLayer`（DB接続なし、判定ロジック本体、単体テスト対象）→
 * `runInvariantsLayer`（DB接続あり、2つを繋ぐ薄いラッパー）。
 *
 * 実行設計（設計書「実行設計」節どおり）:
 *   - source/targetは`Promise.all`で並行実行（layer-data.mjsと同方式、freeze時間短縮）。
 *   - side内は`withReadOnlySnapshot`（REPEATABLE READ READ ONLY、常時ROLLBACK）内で
 *     全invariantを逐次実行する（side内は同一スナップショット断面）。
 *   - テーブル存在確認は`to_regclass`ベースの`tableExists`（layer-data.mjsからそのまま再利用。
 *     車輪の再発明を避ける。実装はlayer-data.mjs参照）をスナップショット内で実行する。
 *   - invariantごとにtry/catch: 1本のSQL失敗を`INVARIANT_RUNTIME_ERROR`のfail findingへ
 *     変換し、他のinvariantは実行を継続する（1invariantの想定外エラーでlayer全体が
 *     `LAYER_RUNTIME_ERROR`として全損する事故を避ける。設計書レビューMinor-5対応）。
 *     エラーメッセージは`readSideInvariants`が受け取る`redactError`関数（呼び出し元
 *     `runInvariantsLayer`がsource/target接続文字列を使って組み立てる）を必ず経由させ、
 *     既存のredaction機構（`core.redactSecretsFromText`）の流れに乗せる
 *     （verify.mjsの`redactBoth`と同じ二重redactionパターン）。
 *   - collationについて（設計書「collation注記」節）: 本layerのGROUP BY/JOINは全て
 *     同一DB内で完結するSQL（sourceならsource内、targetならtarget内）であり、
 *     deterministic collationの下では等価判定は内容ベースになるため、Chunk 2
 *     （layer-data.mjs）のようなcross-DB collation偽陽性は起こらない。cross-DB比較になるのは
 *     Tier Bの(violationCount, digest)のみで、digestはinvariant-checks.mjsが
 *     `COLLATE "C"`ソートで決定性を担保したSQLとして生成する。
 */

'use strict'

import { createRequire } from 'module'
import { withReadOnlySnapshot } from './snapshot.mjs'
import { tableExists } from './layer-data.mjs'
import { INVARIANTS, TIER_A, TIER_B } from './invariant-checks.mjs'
import { findAllowlistEntry } from './cutover-allowlist.mjs'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

/**
 * @typedef {import('./invariant-checks.mjs').InvariantDef} InvariantDef
 * @typedef {{
 *   violationCount: number, samples: string[], durationMs: number,
 * }} InvariantCheckSideSummary
 * @typedef {{
 *   code: string, tier: 'A'|'B', pass: boolean,
 *   sideResults: { source: InvariantCheckSideSummary, target: InvariantCheckSideSummary },
 *   crossCheck: { equal: boolean, sourceDigest: string | null, targetDigest: string | null } | null,
 * }} InvariantCheckReport
 * @typedef {{
 *   id: string, description: string, pass: boolean, allowlisted: boolean, reason?: string,
 *   missingTables?: { source: string[], target: string[] }, checks: InvariantCheckReport[],
 * }} InvariantReport
 *
 * `typeof INVARIANTS`ではなく名前付きtypedef（invariant-checks.mjs定義）を参照する理由は
 * invariant-checks.mjsのInvariantDef/InvariantCheckDef typedefコメント参照。
 */

/**
 * 1接続分（source または target）、全invariantを逐次実行する。
 * `withReadOnlySnapshot`のcallbackとして呼ばれることを想定（txはスナップショット
 * トランザクションスコープ）。
 *
 * 戻り値は invariant id をキーにした Map。各値は以下のいずれか:
 *   - `{ tablesOk: false, missingTables: string[], durationMs }`（requiredTablesの一部が
 *     このDBに存在しない。呼び出し元のevaluateInvariantsLayerがallowlist判定を行う）
 *   - `{ tablesOk: true, checks: Array<{code, tier, violationCount, samples, digest, durationMs}>, durationMs }`
 *   - `{ error: string, durationMs }`（このinvariantのSQL実行中に例外が発生した。
 *     redactError適用済みのメッセージ。他のinvariantの実行は継続する）
 *
 * @param {import('postgres').Sql} tx
 * @param {InvariantDef[]} invariantDefs
 * @param {'source'|'target'} side ログ用のラベル（onInvariantCheckedへ渡すのみ）
 * @param {(text: string) => string} redactError エラーメッセージをredactionする関数
 * @param {((info: { side: string, invariantId: string, tablesOk?: boolean, error?: boolean, durationMs: number }) => void) | undefined} onInvariantChecked
 */
// exportする理由: layer-data.mjsのscanTableと同じ考え方で、fake tx（`.unsafe()`呼び出しのみを
// 模したもの）を使い、count→sample/digestのスキップ分岐やside結果の組み立てを
// CI上で単体テストできるようにするため（tests/unit/db-cutover/layer-invariants.test.ts参照）。
export async function readSideInvariants(tx, invariantDefs, side, redactError, onInvariantChecked) {
  const results = new Map()

  for (const invariant of invariantDefs) {
    const startedAt = Date.now()
    try {
      // 設計書「実行設計」: テーブル存在確認は`to_regclass`によりスナップショット内で行う
      // （layer-data.mjsのtableExistsをそのまま再利用。quoteIdentifier等の重複実装を避ける）。
      const missingTables = []
      for (const tableName of invariant.requiredTables) {
        // 同一スナップショットトランザクション内で逐次実行する必要があるため
        // （設計書「side内は...を逐次実行」）、意図的に await をループ内で直列に使う
        // （Promise.allでの並行化はしない。1トランザクション=1接続のPostgresでは
        // 並行発行しても直列実行されるだけで、コードの見た目上の並行化に意味が無い）。
        const exists = await tableExists(tx, tableName)
        if (!exists) missingTables.push(tableName)
      }

      if (missingTables.length > 0) {
        results.set(invariant.id, { tablesOk: false, missingTables, durationMs: Date.now() - startedAt })
        if (onInvariantChecked) onInvariantChecked({ side, invariantId: invariant.id, tablesOk: false, durationMs: Date.now() - startedAt })
        continue
      }

      const checks = []
      for (const check of invariant.checks) {
        // checkごとの所要時間を測るため、invariant全体の開始時刻（startedAt）ではなく
        // checkごとに独立した開始時刻を使う（1invariantが複数checkを持つ場合、
        // startedAtを使い回すと後のcheckほど「それまでの累積時間」を報告してしまい、
        // 個々のSQLの実測所要時間として誤解を招くため）。
        const checkStartedAt = Date.now()
        // 上記と同じ理由（snapshot内の逐次実行）で、await をループ内で直列に使う。
        const countRows = await tx.unsafe(check.countSql)
        const violationCount = Number(countRows[0].count)

        // 違反0件ならサンプル/digestクエリは実行しない（Fable設計レビューで確認済みの
        // 最適化: Tier Bの「両側0件なら一致」は自明にtrueであり、digest計算のための
        // 追加クエリはfreeze中の実行時間を無駄に伸ばすだけで判定に寄与しない）。
        let samples = []
        let digest = null
        if (violationCount > 0) {
          const sampleRows = await tx.unsafe(check.sampleSql)
          samples = sampleRows.map((row) => row.identifier)
          if (check.digestSql) {
            const digestRows = await tx.unsafe(check.digestSql)
            digest = digestRows[0].digest
          }
        }

        checks.push({ code: check.code, tier: check.tier, violationCount, samples, digest, durationMs: Date.now() - checkStartedAt })
      }

      results.set(invariant.id, { tablesOk: true, checks, durationMs: Date.now() - startedAt })
      if (onInvariantChecked) onInvariantChecked({ side, invariantId: invariant.id, tablesOk: true, durationMs: Date.now() - startedAt })
    } catch (error) {
      const message = redactError(error instanceof Error ? error.message : String(error))
      results.set(invariant.id, { error: message, durationMs: Date.now() - startedAt })
      if (onInvariantChecked) onInvariantChecked({ side, invariantId: invariant.id, error: true, durationMs: Date.now() - startedAt })
    }
  }

  return results
}

/**
 * 2つの文字列配列が「集合として」一致するかを判定する純粋関数（順序非依存）。
 * allowlistの「両側とも不在」ゲート（下記evaluateInvariantsLayer参照）が、
 * source側とtarget側で実際に欠落しているテーブル集合まで一致しているかを確認するために使う。
 *
 * オーケストレーターレビュー Minor-2対応: 修正前は `!s.tablesOk && !t.tablesOk`
 * （両側とも「何かしら」不在）だけをゲートにしていたため、例えば source側が
 * [battles, battle_stats] の2つとも不在、target側は battle_stats のみ不在
 * （battlesは存在する）という非対称な欠落でも allowlist 該当と誤判定し、info降格して
 * しまっていた。これは「本番に元からある既知の欠落（#625）」ではなく「移行が
 * battlesだけ複製し損ねた」ような本物の移行漏れを見逃しうる、監査証跡としても
 * 実態と異なる記載になる欠陥だった。欠落テーブル集合そのものの一致を追加ゲートにする。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function missingTableSetsEqual(a, b) {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((table, index) => table === sortedB[index])
}

/**
 * Tier Aの1 checkを評価する（source/targetそれぞれ独立の絶対値判定、cross-side比較なし）。
 * @param {{ invariantId: string, code: string, sourceResult: object, targetResult: object }} args
 */
function evaluateTierACheck({ invariantId, code, sourceResult, targetResult }) {
  const findings = []
  if (sourceResult.violationCount > 0) {
    findings.push({
      severity: 'fail',
      code,
      message: `${invariantId}/${code}: source側で${sourceResult.violationCount}件の違反を検出しました（構造的に0件であるべき不変条件）。`,
      side: 'source',
    })
  }
  if (targetResult.violationCount > 0) {
    findings.push({
      severity: 'fail',
      code,
      message: `${invariantId}/${code}: target側で${targetResult.violationCount}件の違反を検出しました（構造的に0件であるべき不変条件）。`,
      side: 'target',
    })
  }
  const pass = sourceResult.violationCount === 0 && targetResult.violationCount === 0
  return {
    pass,
    findings,
    checkReport: {
      code,
      tier: TIER_A,
      pass,
      sideResults: {
        source: { violationCount: sourceResult.violationCount, samples: sourceResult.samples, durationMs: sourceResult.durationMs },
        target: { violationCount: targetResult.violationCount, samples: targetResult.samples, durationMs: targetResult.durationMs },
      },
      crossCheck: null,
    },
  }
}

/**
 * Tier Bの1 checkを評価する（source/targetの(violationCount, digest)一致型判定）。
 * 判定モデル（設計書「Tier B: 正規のアプリ操作で崩れうる状態」節）:
 *   - 両側とも0件 → 一致は自明。findingは出さない（S/N比を保つ、rev2レビューMinor-4）。
 *   - 件数とdigestが両側一致 → severity='info'（両側が同じ既知の状態を持つ、移行は忠実）。
 *   - 不一致（件数差 or digest差） → severity='fail'（移行が違反を持ち込んだ/失った）。
 * @param {{ invariantId: string, code: string, sourceResult: object, targetResult: object }} args
 */
function evaluateTierBCheck({ invariantId, code, sourceResult, targetResult }) {
  const sideResults = {
    source: { violationCount: sourceResult.violationCount, samples: sourceResult.samples, durationMs: sourceResult.durationMs },
    target: { violationCount: targetResult.violationCount, samples: targetResult.samples, durationMs: targetResult.durationMs },
  }

  if (sourceResult.violationCount === 0 && targetResult.violationCount === 0) {
    return {
      pass: true,
      findings: [],
      checkReport: { code, tier: TIER_B, pass: true, sideResults, crossCheck: { equal: true, sourceDigest: null, targetDigest: null } },
    }
  }

  const equal = sourceResult.violationCount === targetResult.violationCount && sourceResult.digest === targetResult.digest
  const finding = {
    severity: equal ? 'info' : 'fail',
    code,
    message: equal
      ? `${invariantId}/${code}: source/targetで${sourceResult.violationCount}件の違反集合が一致しました（両側が同じ既知の状態を持つ、正規のアプリ操作起因の可能性）。`
      : `${invariantId}/${code}: source(${sourceResult.violationCount}件)とtarget(${targetResult.violationCount}件)で違反集合が一致しません（件数またはdigestの不一致）。`,
    side: 'both',
  }
  return {
    pass: equal,
    findings: [finding],
    checkReport: { code, tier: TIER_B, pass: equal, sideResults, crossCheck: { equal, sourceDigest: sourceResult.digest, targetDigest: targetResult.digest } },
  }
}

/**
 * Layer 5 の判定ロジック本体（純粋関数、DB接続なし）。source/targetそれぞれの
 * `readSideInvariants`戻り値（Mapのまま）を受け取り、invariantごとに
 * テーブル存在・allowlist・Tier A/B判定を行い、layer結果オブジェクトを組み立てる。
 *
 * @param {{
 *   sourceResults: Map<string, object>,
 *   targetResults: Map<string, object>,
 *   invariantDefs?: InvariantDef[],
 * }} args
 * @returns {{
 *   layer: 'invariants', pass: boolean,
 *   findings: Array<{severity: string, code: string, message: string, side: string, allowlisted?: boolean, reason?: string}>,
 *   invariants: InvariantReport[],
 * }}
 */
export function evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs = INVARIANTS }) {
  const findings = []
  const invariants = []

  for (const invariant of invariantDefs) {
    const s = sourceResults.get(invariant.id)
    const t = targetResults.get(invariant.id)
    if (!s || !t) {
      throw new Error(`evaluateInvariantsLayer: missing side result for invariant '${invariant.id}' (internal wiring error)`)
    }

    // 実行時エラー（invariantごとのtry/catchで捕捉済み）: 他invariantの判定には影響させず、
    // このinvariant自身をfail扱いにする（設計書「invariantごとにtry/catch」）。
    if (s.error || t.error) {
      if (s.error) {
        findings.push({ severity: 'fail', code: 'INVARIANT_RUNTIME_ERROR', message: `${invariant.id}: source側の実行中にエラーが発生しました: ${s.error}`, side: 'source' })
      }
      if (t.error) {
        findings.push({ severity: 'fail', code: 'INVARIANT_RUNTIME_ERROR', message: `${invariant.id}: target側の実行中にエラーが発生しました: ${t.error}`, side: 'target' })
      }
      invariants.push({ id: invariant.id, description: invariant.description, pass: false, allowlisted: false, checks: [] })
      continue
    }

    // テーブル不在の扱い（設計書「allowlist」節）: 両側とも不在 かつ 欠落テーブル集合が
    // 完全一致 かつ allowlist該当なら info+skip。それ以外（片側のみ不在、両側不在でも
    // 欠落集合が非対称、または欠落集合は一致するがallowlist非該当）はfail。
    if (!s.tablesOk || !t.tablesOk) {
      const missingTables = { source: s.tablesOk ? [] : s.missingTables, target: t.tablesOk ? [] : t.missingTables }

      // オーケストレーターレビュー Minor-2対応: 「両側とも何かしら不在」だけでなく、
      // 欠落しているテーブルの集合そのものがsource/targetで一致していることまで確認する
      // （missingTableSetsEqualのコメント参照。非対称な欠落は移行漏れの疑いとしてfailへ）。
      if (!s.tablesOk && !t.tablesOk && missingTableSetsEqual(s.missingTables, t.missingTables)) {
        const allowlistEntry = findAllowlistEntry({ layer: 'invariants', invariantId: invariant.id })
        if (allowlistEntry) {
          findings.push({
            severity: 'info',
            code: 'INVARIANT_REQUIRED_TABLE_MISSING',
            message: `${invariant.id}: source側(${s.missingTables.join(', ')})・target側(${t.missingTables.join(', ')})双方でrequired tablesが存在しないため実行をスキップしました。`,
            side: 'both',
            allowlisted: true,
            reason: allowlistEntry.reason,
          })
          invariants.push({ id: invariant.id, description: invariant.description, pass: true, allowlisted: true, reason: allowlistEntry.reason, missingTables, checks: [] })
          continue
        }
      }

      // 片側のみ不在（移行漏れの疑い）、または両側不在でもallowlist非該当。
      if (!s.tablesOk) {
        findings.push({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', message: `${invariant.id}: source側でrequired tables(${s.missingTables.join(', ')})が存在しません。`, side: 'source' })
      }
      if (!t.tablesOk) {
        findings.push({ severity: 'fail', code: 'INVARIANT_REQUIRED_TABLE_MISSING', message: `${invariant.id}: target側でrequired tables(${t.missingTables.join(', ')})が存在しません。`, side: 'target' })
      }
      invariants.push({ id: invariant.id, description: invariant.description, pass: false, allowlisted: false, missingTables, checks: [] })
      continue
    }

    // 両側ともテーブルが揃っている: invariantが持つ全checkをTier A/Bそれぞれのルールで評価する。
    const checkReports = []
    let invariantPass = true
    for (let i = 0; i < invariant.checks.length; i++) {
      const checkDef = invariant.checks[i]
      const sourceCheckResult = s.checks[i]
      const targetCheckResult = t.checks[i]
      const evaluated =
        checkDef.tier === TIER_A
          ? evaluateTierACheck({ invariantId: invariant.id, code: checkDef.code, sourceResult: sourceCheckResult, targetResult: targetCheckResult })
          : evaluateTierBCheck({ invariantId: invariant.id, code: checkDef.code, sourceResult: sourceCheckResult, targetResult: targetCheckResult })
      checkReports.push(evaluated.checkReport)
      findings.push(...evaluated.findings)
      if (!evaluated.pass) invariantPass = false
    }

    invariants.push({ id: invariant.id, description: invariant.description, pass: invariantPass, allowlisted: false, checks: checkReports })
  }

  // 設計書「severityは fail / info の2値のみ」「layer pass = severity='fail' の findingが0件」
  // （rev2レビューMinor-2: infoがpassを壊さないよう、findings.length===0ではなくseverity判定にする）。
  const pass = !findings.some((f) => f.severity === 'fail')
  return { layer: 'invariants', pass, findings, invariants }
}

/**
 * Layer 5 本体（DB接続あり）。source/targetそれぞれのinvariant実行結果を
 * `withReadOnlySnapshot`経由で集め、`evaluateInvariantsLayer`（純粋関数）へ委譲する。
 * source/targetは互いに独立した別接続・別トランザクションのため`Promise.all`で
 * 並行実行する（layer-data.mjsと同方式、write freeze時間の短縮）。
 *
 * @param {{
 *   sourceSql: import('postgres').Sql,
 *   targetSql: import('postgres').Sql,
 *   sourceUrl: string,
 *   targetUrl: string,
 *   invariantDefs?: InvariantDef[],
 *   onInvariantChecked?: (info: { side: string, invariantId: string, tablesOk?: boolean, error?: boolean, durationMs: number }) => void,
 * }} args
 */
export async function runInvariantsLayer({ sourceSql, targetSql, sourceUrl, targetUrl, invariantDefs = INVARIANTS, onInvariantChecked }) {
  // エラーメッセージのredaction（verify.mjsのredactBothと同じ二重redactionパターン）。
  // readSideInvariants内のtry/catchが捕捉するSQLエラーは通常接続文字列を含まないはずだが、
  // 「既存のredaction機構の流れに乗せる」という設計書の要求（防御的多重層）に従う。
  const redactError = (text) => core.redactSecretsFromText(core.redactSecretsFromText(text, sourceUrl), targetUrl)

  const [sourceResults, targetResults] = await Promise.all([
    withReadOnlySnapshot(sourceSql, (tx) => readSideInvariants(tx, invariantDefs, 'source', redactError, onInvariantChecked)),
    withReadOnlySnapshot(targetSql, (tx) => readSideInvariants(tx, invariantDefs, 'target', redactError, onInvariantChecked)),
  ])

  return evaluateInvariantsLayer({ sourceResults, targetResults, invariantDefs })
}
