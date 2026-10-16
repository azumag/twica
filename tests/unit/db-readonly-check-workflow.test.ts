import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/db-readonly-check.yml` は DB secret を使う workflow なので、
 * 「書き込み経路が無い」「production の secret に到達しない」という性質を機械的に固定する (Issue #1665)。
 * 実DBを伴う検証（集計 SQL が補正 UPDATE と一致すること）は
 * tests/fixtures/chat-outbox-readonly-counts-pg17.mjs が PG17 job で行う。
 */
describe('db-readonly-check workflow contract (Issue #1665)', () => {
  const workflow = read('.github/workflows/db-readonly-check.yml')

  it('workflow_dispatch 以外では動かない（push / schedule / pull_request を持たない）', () => {
    expect(workflow).toContain('on:\n  workflow_dispatch: {}')
    expect(workflow).not.toMatch(/^ {2}push:/m)
    expect(workflow).not.toMatch(/^ {2}schedule:/m)
    expect(workflow).not.toMatch(/^ {2}pull_request:/m)
  })

  it('input を持たない（SQL も Environment も差し替えられない）', () => {
    expect(workflow).not.toContain('workflow_dispatch:\n    inputs:')
  })

  it('environment を preview に固定する（Environment secret の解決に必要。input では選ばせない）', () => {
    expect(workflow).toContain('environment: preview')
    expect(workflow).not.toContain("github.ref == 'refs/heads/preview' && 'preview' || 'production'")
  })

  it('preview 以外の ref を二重で拒否する', () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/preview'")
    expect(workflow).toContain('if [ "$GITHUB_REF" != "refs/heads/preview" ]; then')
  })

  it('セッション全体を読み取り専用にする（書き込みは DB 側で失敗する）', () => {
    expect(workflow).toContain('PGOPTIONS: "-c default_transaction_read_only=on')
  })

  it('repo を checkout しない / permissions は contents: read のみ', () => {
    expect(workflow).not.toContain('actions/checkout')
    expect(workflow).toContain('permissions:\n      contents: read')
  })

  it('psql に渡す SQL に書き込み系の文を持たない（EXPLAIN の UPDATE を除く）', () => {
    const sqlBlocks = [...workflow.matchAll(/<<'SQL'\n([\s\S]*?)\n\s*SQL/g)].map((match) => match[1])
    expect(sqlBlocks.length).toBeGreaterThan(0)
    for (const block of sqlBlocks) {
      const withoutExplain = block.replace(/EXPLAIN\s+UPDATE[\s\S]*?;/gi, '')
      expect(withoutExplain).not.toMatch(
        /\b(INSERT|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i,
      )
    }
  })

  it('件数を実行時点つきで出力し、実行の出所を記録する', () => {
    expect(workflow).toContain('now() AS observed_at')
    expect(workflow).toContain('GITHUB_RUN_ID')
    expect(workflow).toContain('GITHUB_SHA')
  })

  it('合計にも補正 UPDATE と同じ status/lease 条件を適用する（レビュー指摘 P2 の回帰）', () => {
    // targets_total が有効 lease 中の processing 行を数えると、補正対象件数と残件0判定を誤らせる。
    // （実DBでの挙動は tests/fixtures/chat-outbox-readonly-counts-pg17.mjs が PG17 job で固定する）
    const totalLine = workflow.split('\n').find((line) => line.includes('AS targets_total,'))
    expect(totalLine).toBeDefined()
    expect(totalLine).toContain(
      "status = 'pending' OR (status = 'processing' AND lease_expires_at <= now())",
    )
  })
})
