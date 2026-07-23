#!/usr/bin/env node

/**
 * CutoverVerificationReport（JSON） → 人間向けMarkdown変換 / Issue #697 Chunk 4
 *
 * 設計判断（Chunk 1のlayer-schema.mjs冒頭コメント「人間向けMarkdown reportについて」で
 * 明示保留されていたYAGNI判断を、本チャンクで解消する）:
 * Issue #697本文は「machine-readable JSONと人間向けMarkdownを生成する」と要求している。
 * JSON reportは既にreport.mjs（buildReport）が生成しており、そのオブジェクト構造
 * （`layers`をlayer名キーのオブジェクトにする等）自体が後から機械的にMarkdownへ変換
 * しやすい形になっているため、本ファイルは**JSONオブジェクトを受け取ってMarkdown文字列を
 * 返す純粋関数のみ**を持つ（DB接続・ファイルI/O無し。buildReport同様、単体テスト対象）。
 * ファイルI/O（`.md`として保存する処理）はverify.mjs側の責務とする（JSON artifactの
 * 保存パターンと対称にするため。本ファイル自身はファイルシステムに一切触れない）。
 *
 * スタイル方針（設計書「非スコープ」節「人間向けMarkdown reportのスタイル凝りこみ」）:
 * 表＋箇条書きの最小構成のみ。見出し階層・絵文字装飾・折りたたみ等の凝った整形は行わない
 * （運用者がcutover当日に素早く目視確認できれば十分という要求水準に対し、過剰な実装は
 * YAGNI。プロジェクトのCLAUDE.md「過度な抽象化や複雑化を避ける」方針にも従う）。
 *
 * redactionについて（重要な前提）:
 * 本ファイルはreport.mjsが既に組み立て済みのJSONオブジェクトをそのままMarkdownへ整形する
 * だけであり、独自にredactionを行わない・行う必要が無い。report.mjs（およびverify.mjsの
 * redactBoth、各layer-*.mjsのredactError）が、findingメッセージへ接続文字列等の機微情報を
 * 混入させない責務を既に担っているため、本ファイルへ渡される入力は常にredaction済みである
 * ことが前提になる（tests/unit/db-cutover/report-markdown.test.tsで「redaction済み入力を
 * そのまま透過するだけで、独自に値を新たに埋め込まない」ことを確認する）。
 */

'use strict'

/**
 * findingの配列からseverity別の件数を数える純粋ヘルパー。
 * @param {Array<{ severity: string }>} findings
 */
function countBySeverity(findings) {
  let fail = 0
  let info = 0
  for (const f of findings) {
    if (f.severity === 'fail') fail += 1
    else if (f.severity === 'info') info += 1
  }
  return { fail, info }
}

/**
 * 1layer分のstatus文字列を組み立てる（サマリ表のStatus列）。
 * `notEvaluated`（report.mjsのbuildIdentitySummary/buildReportが未実行layerに設定する
 * フラグ）を最優先で表示する: 実行すらされていないlayerを誤って"fail"と表示すると、
 * 「実行して失敗した」のか「そもそも実行されなかった」のかが区別できず、GO/NO-GO判断を
 * 誤らせるため。
 * @param {{ pass: boolean | null, notEvaluated?: boolean }} layer
 */
function layerStatusLabel(layer) {
  if (layer.notEvaluated) return 'not evaluated'
  return layer.pass ? 'pass' : 'fail'
}

/**
 * 1件のfindingを箇条書き1行へ整形する。severity・code・side・messageのみを含み、
 * report.mjs/各layer-*.mjsが既に構築済みの文字列をそのまま使う（本関数が新たに値を
 * 組み立てて埋め込むことはしない。ファイル冒頭コメント「redactionについて」参照）。
 * allowlist該当時は理由も併記する（cutover-allowlist.mjsが提供するreason）。
 * @param {{ severity: string, code: string, message: string, side: string, allowlisted?: boolean, reason?: string }} finding
 */
function formatFindingLine(finding) {
  const allowlistSuffix = finding.allowlisted ? `（allowlisted: ${finding.reason ?? '(理由未記載)'}）` : ''
  return `- **[${finding.severity}]** \`${finding.code}\` (side: ${finding.side}): ${finding.message}${allowlistSuffix}`
}

/**
 * CutoverVerificationReport（report.mjsのbuildReportが返すJSONオブジェクト）から
 * 人間向けMarkdownを生成する純粋関数。
 *
 * 出力構成（設計書「Markdown report生成」節どおり、最小構成）:
 *   1. ヘッダー（operationId・generatedAt・decision・source/target識別情報）
 *   2. サマリ表（layer × pass/fail/finding数）
 *   3. findings詳細（layerごとの箇条書き。findingが0件のlayerは省略しノイズを減らす）
 *
 * @param {{
 *   schemaVersion: number,
 *   operationId: string | null,
 *   generatedAt: string,
 *   source: { environment: string, provider: string, instanceId: string | null },
 *   target: { environment: string, provider: string, instanceId: string | null },
 *   requestedLayers: string[],
 *   layers: Record<string, { layer: string, pass: boolean | null, findings: unknown[], notEvaluated?: boolean }>,
 *   decision: string,
 * }} report buildReport()の戻り値そのもの（`decision`はbuildReport側の実際の推論型
 *   （string、リテラルユニオンへ狭められていない）に合わせてstringとする。本関数は
 *   decisionの値をそのままテンプレートへ埋め込むだけで分岐に使わないため、リテラル型で
 *   あることに依存しない）
 * @returns {string} Markdown文字列（末尾改行付き）
 */
export function buildMarkdownReport(report) {
  const lines = []

  lines.push('# Cutover Verification Report')
  lines.push('')
  lines.push(`- **decision**: \`${report.decision}\``)
  lines.push(`- operationId: ${report.operationId ?? '(none)'}`)
  lines.push(`- generatedAt: ${report.generatedAt}`)
  lines.push(`- source: environment=${report.source.environment} provider=${report.source.provider} instanceId=${report.source.instanceId ?? '(unknown)'}`)
  lines.push(`- target: environment=${report.target.environment} provider=${report.target.provider} instanceId=${report.target.instanceId ?? '(unknown)'}`)
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Layer | Status | Fail findings | Info findings |')
  lines.push('|---|---|---|---|')
  for (const layerName of report.requestedLayers) {
    const layer = report.layers[layerName]
    const { fail, info } = countBySeverity(layer.findings ?? [])
    lines.push(`| ${layerName} | ${layerStatusLabel(layer)} | ${fail} | ${info} |`)
  }
  lines.push('')

  lines.push('## Findings')
  lines.push('')
  let anyFindings = false
  for (const layerName of report.requestedLayers) {
    const layer = report.layers[layerName]
    const findings = layer.findings ?? []
    if (findings.length === 0) continue
    anyFindings = true
    lines.push(`### ${layerName}`)
    lines.push('')
    for (const finding of findings) {
      lines.push(formatFindingLine(finding))
    }
    lines.push('')
  }
  if (!anyFindings) {
    lines.push('(findingはありません)')
    lines.push('')
  }

  return lines.join('\n')
}
