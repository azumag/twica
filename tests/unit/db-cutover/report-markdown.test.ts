import { describe, expect, it } from 'vitest'
import { buildReport } from '../../../scripts/db-cutover/report.mjs'
import { buildMarkdownReport } from '../../../scripts/db-cutover/report-markdown.mjs'

/**
 * Issue #697 Chunk 4: report-markdown.mjs（Markdown report生成、純粋関数）のテスト。
 *
 * 入力はreport.mjsのbuildReportが返す実際のJSON構造をそのまま使う（buildReportの単体テスト
 * report.test.tsと同じfixtureパターンを踏襲することで、「JSON reportの実際の形」と乖離した
 * fixtureで検証してしまう事故を防ぐ）。
 */

const baseArgs = {
  operationId: 'op-md-123',
  generatedAt: '2026-07-21T00:00:00.000Z',
  sourceExpected: { environment: 'preview', provider: 'supabase' },
  targetExpected: { environment: 'preview', provider: 'planetscale' },
}

describe('buildMarkdownReport: ヘッダー', () => {
  it('decision/operationId/generatedAt/source/targetを含む', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [
        {
          layer: 'identity',
          pass: true,
          findings: [],
          source: { environment: 'preview', provider: 'supabase', instanceId: 'source-uuid', bypassRls: true },
          target: { environment: 'preview', provider: 'planetscale', instanceId: 'target-uuid', bypassRls: true },
        },
      ],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain('# Cutover Verification Report')
    expect(md).toContain('**decision**: `pass`')
    expect(md).toContain('op-md-123')
    expect(md).toContain('2026-07-21T00:00:00.000Z')
    expect(md).toContain('environment=preview provider=supabase instanceId=source-uuid')
    expect(md).toContain('environment=preview provider=planetscale instanceId=target-uuid')
  })

  it('operationIdがnullなら(none)と表示する', () => {
    const report = buildReport({ ...baseArgs, operationId: null, requestedLayers: [], executedLayerResults: [] })
    const md = buildMarkdownReport(report)
    expect(md).toContain('operationId: (none)')
  })

  it('instanceIdがnull（identity未実行）なら(unknown)と表示する', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: ['schema'], executedLayerResults: [{ layer: 'schema', pass: true, findings: [] }] })
    const md = buildMarkdownReport(report)
    expect(md).toContain('instanceId=(unknown)')
  })
})

describe('buildMarkdownReport: サマリ表', () => {
  it('layerごとにStatus・fail/info件数を1行ずつ出す（requestedLayersの順）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [
        { layer: 'identity', pass: true, findings: [] },
        {
          layer: 'schema',
          pass: false,
          findings: [
            { severity: 'fail', code: 'SCHEMA_DIFF', message: 'diff found', side: 'both' },
            { severity: 'info', code: 'SCHEMA_ALLOWLISTED', message: 'known drift', side: 'both', allowlisted: true, reason: 'known issue' },
          ],
        },
      ],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain('| identity | pass | 0 | 0 |')
    expect(md).toContain('| schema | fail | 1 | 1 |')
  })

  it('notEvaluatedなlayerは"not evaluated"と表示する（identity fail後の未実行layer）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [{ layer: 'identity', pass: false, findings: [{ severity: 'fail', code: 'MISMATCH', message: 'x', side: 'source' }] }],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain('| schema | not evaluated | 0 | 0 |')
  })
})

describe('buildMarkdownReport: findings詳細', () => {
  it('findingを持つlayerのみ見出し+箇条書きを出す（findingが無いlayerは省略しノイズを減らす）', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity', 'schema'],
      executedLayerResults: [
        { layer: 'identity', pass: true, findings: [] },
        {
          layer: 'schema',
          pass: false,
          findings: [{ severity: 'fail', code: 'SCHEMA_DIFF', message: 'テーブルXの列が一致しません', side: 'both' }],
        },
      ],
    })
    const md = buildMarkdownReport(report)
    expect(md).not.toContain('### identity')
    expect(md).toContain('### schema')
    expect(md).toContain('**[fail]** `SCHEMA_DIFF` (side: both): テーブルXの列が一致しません')
  })

  it('allowlisted findingにはreasonを併記する', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['data'],
      executedLayerResults: [
        {
          layer: 'data',
          pass: true,
          findings: [
            {
              severity: 'info',
              code: 'DATA_TABLE_MISSING',
              message: 'battles: テーブルが不在',
              side: 'both',
              allowlisted: true,
              reason: 'Issue #625の既知ドリフト',
            },
          ],
        },
      ],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain('allowlisted: Issue #625の既知ドリフト')
  })

  it('全layerでfindingが0件なら「findingはありません」と表示する', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [{ layer: 'identity', pass: true, findings: [] }],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain('(findingはありません)')
  })
})

describe('buildMarkdownReport: redaction規律（入力をそのまま透過するだけで新たな値を埋め込まない）', () => {
  it('findingメッセージに接続文字列様の値を含む入力を渡しても、本関数自体が新たな生値を追加で埋め込まない（受け取ったmessage文字列以上の情報を増やさない）', () => {
    // 本関数はredactionを自分で行わない設計（ファイル冒頭コメント参照）。ここでは
    // 「入力のmessageをそのまま出力に反映するだけで、それ以外の値（例えば入力オブジェクトの
    // 他フィールドを不用意に埋め込む等）を増やしていないこと」を確認する（本関数の責務範囲の
    // 確認であり、redactionそのものの検証はredactBoth/redactError側のテストが担う）。
    const message = 'redaction済みメッセージ（接続文字列は既に上流でマスク済み: postgres://[REDACTED]）'
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['canary'],
      executedLayerResults: [
        {
          layer: 'canary',
          pass: false,
          findings: [{ severity: 'fail', code: 'CANARY_RUNTIME_ERROR', message, side: 'target' }],
        },
      ],
    })
    const md = buildMarkdownReport(report)
    expect(md).toContain(message)
    // 入力に無い値（例えば生の接続文字列パターン）が新たに出現していないこと。
    expect(md).not.toMatch(/postgres:\/\/[^[][^\s]*:[^\s]*@/)
  })
})

describe('buildMarkdownReport: 純粋関数性', () => {
  it('同じ入力からは常に同じ出力を返す', () => {
    const report = buildReport({
      ...baseArgs,
      requestedLayers: ['identity'],
      executedLayerResults: [{ layer: 'identity', pass: true, findings: [] }],
    })
    expect(buildMarkdownReport(report)).toBe(buildMarkdownReport(report))
  })

  it('末尾に改行を含む文字列を返す', () => {
    const report = buildReport({ ...baseArgs, requestedLayers: [], executedLayerResults: [] })
    const md = buildMarkdownReport(report)
    expect(md.endsWith('\n')).toBe(true)
  })
})
