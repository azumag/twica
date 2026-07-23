#!/usr/bin/env node

/**
 * CutoverVerificationReport の組み立て・decision計算 / Issue #697 Chunk 1
 *
 * Issue #697本文の出力モデル（CutoverVerificationReport型）を踏まえつつ、Chunk 1では
 * identity/schemaの2layerのみを実装するため、`layers` を「layer名 → 結果」のオブジェクトに
 * する拡張可能な構造にした（後続チャンクでdata/invariants/canaryを追加する際、この構造に
 * キーを増やすだけで済み、既存コードの大改造を要さない設計。Issue #697本文タスク8の要求）。
 *
 * decisionの3値（Issue #697本文の型定義そのまま）:
 *   - 'fail': 実行されたlayerのうち1つでもfailがあれば必ずfail
 *   - 'pass': 要求された全layerが実行され、かつ全てpassした場合のみ
 *   - 'not-evaluated': 要求されたlayerのうち一部が「実行されなかった」場合
 *     （例: identity layerがfailして即座に停止したため、続くschema layerが未実行のまま残った。
 *     Issue #697本文: 「identity mismatchで実行停止する」）。ただしこのケースは同時に
 *     identity自体がfailしているため、上のfail優先ルールにより実際には 'fail' になる。
 *     'not-evaluated' が主に意味を持つのは、実行時エラー等で後続layerに到達できなかったが
 *     直前までのlayerは全てpassしていた、というような将来的なケース。
 */

'use strict'

/**
 * identity layerの結果（あれば）から、report用のDatabaseIdentityサマリを作る。
 * identity layerが未実行（--layersに含まれない等）の場合はCLI引数で宣言された
 * environment/providerのみを使い、instanceIdはnull（実DBから確認していないことを明示）にする。
 *
 * @param {{ environment: string, provider: string }} expected
 * @param {{ environment: string, provider: string, instanceId: string, bypassRls: boolean } | null | undefined} fromIdentityLayer
 */
function buildIdentitySummary(expected, fromIdentityLayer) {
  if (fromIdentityLayer) {
    return { environment: fromIdentityLayer.environment, provider: fromIdentityLayer.provider, instanceId: fromIdentityLayer.instanceId }
  }
  return { environment: expected.environment, provider: expected.provider, instanceId: null }
}

/**
 * CutoverVerificationReport を組み立てる純粋関数（DB接続・ファイルI/O無し、単体テスト対象）。
 *
 * @param {{
 *   operationId: string | null,
 *   generatedAt: string,
 *   sourceExpected: { environment: string, provider: string },
 *   targetExpected: { environment: string, provider: string },
 *   requestedLayers: string[],
 *   executedLayerResults: Array<{ layer: string, pass: boolean, findings: unknown[] } & Record<string, unknown>>,
 * }} args
 */
export function buildReport({ operationId, generatedAt, sourceExpected, targetExpected, requestedLayers, executedLayerResults }) {
  /** @type {Record<string, { layer: string, pass: boolean | null, findings: unknown[] } & Record<string, unknown>>} */
  const layers = {}
  for (const result of executedLayerResults) {
    layers[result.layer] = result
  }
  for (const name of requestedLayers) {
    if (!layers[name]) {
      layers[name] = { layer: name, pass: null, findings: [], notEvaluated: true }
    }
  }

  const anyFail = executedLayerResults.some((r) => !r.pass)
  const allRequestedExecuted = requestedLayers.every((name) => layers[name] && layers[name].pass !== null)

  let decision
  if (requestedLayers.length === 0) {
    decision = 'not-evaluated'
  } else if (anyFail) {
    decision = 'fail'
  } else if (allRequestedExecuted) {
    decision = 'pass'
  } else {
    decision = 'not-evaluated'
  }

  const identityResult = layers.identity && !layers.identity.notEvaluated ? layers.identity : null

  return {
    schemaVersion: 1,
    operationId: operationId ?? null,
    generatedAt,
    source: buildIdentitySummary(sourceExpected, identityResult && identityResult.source),
    target: buildIdentitySummary(targetExpected, identityResult && identityResult.target),
    requestedLayers,
    layers,
    decision,
  }
}
