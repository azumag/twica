import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/db-readonly-check-cards-columns{,-production}.yml` は Issue #954 の
 * 「cards の残存デプロイ窓フォールバック要否」を実測するための読み取り専用観測 workflow
 * （production 側は production の DB secret を使う）。「書き込み経路が無い」「main 以外の
 * ref から production へ到達しない」「実行する SQL が preview 側と同一である」「対象列が
 * Issue #954 で固定した4列である」という性質を機械的に固定する。
 *
 * 構え自体は #1665 Step 4 の chat outbox 観測用
 * tests/unit/db-readonly-check-production-workflow.test.ts と同じ契約テストのパターンで、
 * production secret を使う workflow を main に着地させる際の同一の安全設計を要求する。
 */
describe('db-readonly-check-cards-columns workflow contract (Issue #954)', () => {
  const workflow = read('.github/workflows/db-readonly-check-cards-columns-production.yml')
  const previewWorkflow = read('.github/workflows/db-readonly-check-cards-columns.yml')

  /** heredoc (`<<'SQL'` … `SQL`) の中身を取り出し、共通インデントを除去して返す。 */
  function sqlBlocks(text: string): string[] {
    return [...text.matchAll(/<<'SQL'\n([\s\S]*?)\n\s*SQL/g)].map((match) => {
      const lines = match[1].split('\n')
      const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0)
      const indent = Math.min(...indents)
      return lines.map((line) => line.slice(indent)).join('\n')
    })
  }

  it('workflow_dispatch 以外では動かない（push / schedule / pull_request を持たない）', () => {
    for (const text of [workflow, previewWorkflow]) {
      expect(text).toContain('on:\n  workflow_dispatch: {}')
      expect(text).not.toMatch(/^ {2}push:/m)
      expect(text).not.toMatch(/^ {2}schedule:/m)
      expect(text).not.toMatch(/^ {2}pull_request:/m)
    }
  })

  it('input を持たない（SQL も Environment も差し替えられない）', () => {
    for (const text of [workflow, previewWorkflow]) {
      expect(text).not.toContain('workflow_dispatch:\n    inputs:')
    }
  })

  it('environment を各論理DB側に固定する（Environment secret の解決に必要。input では選ばせない）', () => {
    expect(previewWorkflow).toContain('environment: preview')
    expect(previewWorkflow).not.toContain('environment: production')
    expect(workflow).toContain('environment: production')
    expect(workflow).not.toContain('environment: preview')
  })

  it('production 側は main 以外の ref を二重で拒否する（feature branch へ production の secret を渡さない）', () => {
    // workflow_dispatch は任意 ref を選べるため、job-level の条件だけでは足りない。
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then')
    // preview を許可する条件式が混ざっていないこと（job 条件は main のみ）。
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('preview 側は main / preview のみを許可する（feature branch のコードから secret を使わせない）', () => {
    expect(previewWorkflow).toContain(
      "if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/preview'",
    )
    expect(previewWorkflow).toContain(
      'if [ "$GITHUB_REF" != "refs/heads/main" ] && [ "$GITHUB_REF" != "refs/heads/preview" ]; then',
    )
  })

  it('セッション全体を読み取り専用にする（書き込みは DB 側で失敗する）', () => {
    for (const text of [workflow, previewWorkflow]) {
      expect(text).toContain('PGOPTIONS: "-c default_transaction_read_only=on')
    }
  })

  it('観測の前に実効 transaction_read_only が on であることを確認する', () => {
    // PGOPTIONS の指定は「そう設定したつもり」にすぎないため、接続先での実効値を確認してから観測する。
    for (const text of [workflow, previewWorkflow]) {
      expect(text).toContain('SHOW transaction_read_only')
      expect(text).toContain('expected transaction_read_only=on')
      const verifyIndex = text.indexOf('Verify the session is read-only before aggregating')
      const countIndex = text.indexOf('Check cards columns existence (read-only)')
      expect(verifyIndex).toBeGreaterThan(-1)
      expect(countIndex).toBeGreaterThan(verifyIndex)
    }
  })

  it('repo を checkout しない / permissions は contents: read のみ / 実行時間に上限がある', () => {
    for (const text of [workflow, previewWorkflow]) {
      expect(text).not.toContain('actions/checkout')
      expect(text).toContain('permissions:\n      contents: read')
      expect(text).toContain('timeout-minutes: 5')
    }
  })

  it('psql に渡す SQL に書き込み系の文を持たない（#954 は information_schema の SELECT のみ）', () => {
    for (const text of [workflow, previewWorkflow]) {
      const blocks = sqlBlocks(text)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(block).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i,
        )
      }
    }
  })

  it('実行時刻と出所を記録する（実測値は実行時点の値として Issue に記録する）', () => {
    for (const text of [workflow, previewWorkflow]) {
      expect(text).toContain('now() AS observed_at')
      expect(text).toContain('GITHUB_RUN_ID')
      expect(text).toContain('GITHUB_SHA')
    }
  })

  it('対象列は Issue #954 で固定した4列のみで、cards テーブルの information_schema を見る', () => {
    // 観測対象を issue で固定する。安易に列を増やすと「実測で裏付けのない列の
    // フォールバック撤去」を誘発するため、ここで機械的に固定する。
    const sql = sqlBlocks(workflow).join('\n')
    expect(sql).toContain('information_schema.columns')
    expect(sql).toContain("table_schema = 'public' AND table_name = 'cards'")
    for (const column of ['card_number', 'max_issuance_count', 'collection_name', 'image_padding_color']) {
      expect(sql).toContain(`('${column}')`)
      expect(sql).toContain(`'${column}'`)
    }
    // 欠落列の左辺列挙（VALUES）と実在 SELECT の IN 句が同じ4列であること。
    const inClause = sql.match(/column_name IN \(([^)]*)\)/)?.[1] ?? ''
    const valuesClause = sql.match(/VALUES \(([\s\S]*?)\) AS t\(name\)/)?.[1] ?? ''
    const targetColumns = ['card_number', 'max_issuance_count', 'collection_name', 'image_padding_color']
    for (const column of targetColumns) {
      expect(inClause).toContain(`'${column}'`)
      expect(valuesClause).toContain(`'${column}'`)
    }
    expect([...valuesClause.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual(targetColumns)
  })

  it('公開ログを最小化する（DB 名・行データ・payload を出さない。メタデータと観測時刻は残す）', () => {
    // コメントでの言及は許容し、実行される SQL（heredoc の中身）だけを対象にする。
    const sql = sqlBlocks(workflow).join('\n')
    expect(sql).not.toContain('current_database()')
    expect(sql).not.toContain('SELECT *')
    expect(sql).toContain('to_regclass')
  })

  it('実行する SQL が preview 用 workflow と完全に一致する（片側だけ直す事故を防ぐ）', () => {
    // Environment だけを分け、観測内容は同一に保つ。環境ごとの実測根拠が乖離した時点で
    // CI が止める形にする（#1665 の chat outbox 観測ペアと同じ契約）。
    expect(sqlBlocks(workflow)).toEqual(sqlBlocks(previewWorkflow))
  })
})
