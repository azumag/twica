import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/db-readonly-check-production.yml` は **production** の DB secret を使う
 * workflow なので、「書き込み経路が無い」「main 以外の ref から production へ到達しない」
 * 「実行する SQL が preview 側と同一である」という性質を機械的に固定する (Issue #1665 Step 4)。
 *
 * 実DBを伴う検証（集計 SQL が補正 UPDATE と一致すること）は
 * tests/fixtures/chat-outbox-readonly-counts-pg17.mjs が PG17 job で行う。
 */
describe('db-readonly-check-production workflow contract (Issue #1665)', () => {
  const workflow = read('.github/workflows/db-readonly-check-production.yml')
  const previewWorkflow = read('.github/workflows/db-readonly-check.yml')

  /** heredoc (`<<'SQL'` … `SQL`) の中身を取り出し、共通インデントを除去して返す。 */
  function sqlBlocks(text: string): string[] {
    return [...text.matchAll(/<<'SQL'\n([\s\S]*?)\n\s*SQL/g)].map((match) => {
      const lines = match[1].split('\n')
      const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0)
      const indent = Math.min(...indents)
      return lines.map((line) => line.slice(indent)).join('\n')
    })
  }

  /**
   * 指定 name の step ブロック（`- name: <name>` の行から段落区切りの空行まで）を
   * 共通インデントを除去して返す。存在しなければ null。guard の「exit 1 を含む
   * ブロック全体」固定（#1881）のために取り出す。
   */
  function stepBlock(text: string, name: string): string | null {
    const at = text.indexOf(`- name: ${name}\n`)
    if (at === -1) return null
    // indexOf は行頭のインデントの途中を指すため、ブロック先頭を行頭へ揃えてから
    // 共通インデントを測る（1行目だけインデントが欠けると dedent が機能しない）。
    const start = text.lastIndexOf('\n', at) + 1
    const rest = text.slice(start)
    const end = rest.indexOf('\n\n')
    const block = rest.slice(0, end === -1 ? rest.length : end)
    const lines = block.split('\n')
    const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    const indent = Math.min(...indents)
    return lines.map((line) => line.slice(indent)).join('\n')
  }

  /**
   * guard step の期待値（exit 1 を含むブロック全体）。`::error::` 警告だけを残して
   * exit 1 を消す「警告を出して通す no-op 化」（#1879 mutation M6）や拒否条件の
   * 弱体化を検出するため、ヘッダー行だけではなく step 全体を固定する（#1881）。
   */
  const expectedGuardStep = [
    '- name: Guard the target ref',
    '  run: |',
    '    if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
    '      echo "::error::the production read-only check is only allowed from refs/heads/main"',
    '      exit 1',
    '    fi',
  ].join('\n')

  it('workflow_dispatch 以外では動かない（push / schedule / pull_request を持たない）', () => {
    expect(workflow).toContain('on:\n  workflow_dispatch: {}')
    expect(workflow).not.toMatch(/^ {2}push:/m)
    expect(workflow).not.toMatch(/^ {2}schedule:/m)
    expect(workflow).not.toMatch(/^ {2}pull_request:/m)
  })

  it('input を持たない（SQL も Environment も差し替えられない）', () => {
    expect(workflow).not.toContain('workflow_dispatch:\n    inputs:')
  })

  it('environment を production に固定する（Environment secret の解決に必要。input では選ばせない）', () => {
    expect(workflow).toContain('environment: production')
    expect(workflow).not.toContain("github.ref == 'refs/heads/preview' && 'preview' || 'production'")
  })

  it('main 以外の ref を二重で拒否する（feature branch へ production の secret を渡さない）', () => {
    // workflow_dispatch は任意 ref を選べるため、job-level の条件だけでは足りない。
    // if: 行は部分一致だと他ブランチの追加を止められないため、行全体で固定する（#1879 M5 / #1881）。
    expect(workflow).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    // step 内 guard は exit 1 を含むブロック全体で固定する（#1879 M6 / #1881）。
    expect(stepBlock(workflow, 'Guard the target ref')).toEqual(expectedGuardStep)
    // preview を許可する条件式が混ざっていないこと（job 条件は main のみ）。
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('セッション全体を読み取り専用にする（書き込みは DB 側で失敗する）', () => {
    expect(workflow).toContain('PGOPTIONS: "-c default_transaction_read_only=on')
  })

  it('集計の前に実効 transaction_read_only が on であることを確認する', () => {
    // PGOPTIONS の指定は「そう設定したつもり」にすぎないため、接続先での実効値を確認してから集計する。
    expect(workflow).toContain('SHOW transaction_read_only')
    expect(workflow).toContain('expected transaction_read_only=on')
    const verifyIndex = workflow.indexOf('Verify the session is read-only before aggregating')
    const countIndex = workflow.indexOf('Count backfill targets (read-only)')
    expect(verifyIndex).toBeGreaterThan(-1)
    expect(countIndex).toBeGreaterThan(verifyIndex)
  })

  it('repo を checkout しない / permissions は contents: read のみ / 実行時間に上限がある', () => {
    expect(workflow).not.toContain('actions/checkout')
    expect(workflow).toContain('permissions:\n      contents: read')
    expect(workflow).toContain('timeout-minutes: 5')
  })

  it('psql に渡す SQL に書き込み系の文を持たない（EXPLAIN の UPDATE を除く）', () => {
    const blocks = sqlBlocks(workflow)
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      // EXPLAIN の UPDATE は「実行しない計画表示」なので除外し、それ以外の書き込み文を禁じる。
      const withoutExplain = block.replace(/EXPLAIN\s+UPDATE[\s\S]*?;/gi, '')
      expect(withoutExplain).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i,
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
    const totalLine = workflow.split('\n').find((line) => line.includes('AS targets_total,'))
    expect(totalLine).toBeDefined()
    expect(totalLine).toContain(
      "status = 'pending' OR (status = 'processing' AND lease_expires_at <= now())",
    )
  })

  it('公開ログを最小化する（DB 名・適用者名を出さない。件数・観測時刻・適用 version は残す）', () => {
    // コメントでの言及は許容し、実行される SQL（heredoc の中身）だけを対象にする。
    const sql = sqlBlocks(workflow).join('\n')
    expect(sql).not.toContain('current_database()')
    expect(sql).not.toContain('applied_by')
    expect(sql).toContain('now() AS observed_at')
    expect(sql).toContain('max_applied_version')
  })

  it('実行する SQL が preview 用 workflow と完全に一致する（片側だけ直す事故を防ぐ）', () => {
    // Environment だけを分け、観測内容は同一に保つ。production の受入判定が古い predicate で
    // 動く事故を、差分が生じた時点で CI が止める形にする。
    expect(sqlBlocks(workflow)).toEqual(sqlBlocks(previewWorkflow))
  })
})
