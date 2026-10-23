import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/db-readonly-check-trade-quantity{,-production}.yml` は Issue #1792 の
 * 「トレード枚数系（wanted_quantity / 4引数 accept_trade_offer）デプロイ窓フォールバック要否」を
 * 実測するための読み取り専用観測 workflow（production 側は production の DB secret を使う）。
 * 「書き込み経路が無い」「main 以外の ref から production へ到達しない」「実行する SQL が
 * preview 側と同一である」「対象が Issue #1792 で固定した1列1関数である」という性質を
 * 機械的に固定する。
 *
 * 構え自体は #954 の cards 列観測用
 * tests/unit/db-readonly-check-cards-columns-workflow.test.ts と同じ契約テストのパターンで、
 * production secret を使う workflow を main に着地させる際の同一の安全設計を要求する。
 */
describe('db-readonly-check-trade-quantity workflow contract (Issue #1792)', () => {
  const workflow = read('.github/workflows/db-readonly-check-trade-quantity-production.yml')
  const previewWorkflow = read('.github/workflows/db-readonly-check-trade-quantity.yml')

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
   * exit 1 を消す「警告を出して通す no-op 化」（#1879 mutation M6/M6b）や拒否条件の
   * 弱体化を検出するため、ヘッダー行だけではなく step 全体を固定する（#1881）。
   */
  const expectedGuardSteps = {
    production: [
      '- name: Guard the target ref',
      '  run: |',
      '    if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
      '      echo "::error::the production read-only check is only allowed from refs/heads/main"',
      '      exit 1',
      '    fi',
    ].join('\n'),
    preview: [
      '- name: Guard the target ref',
      '  run: |',
      '    if [ "$GITHUB_REF" != "refs/heads/main" ] && [ "$GITHUB_REF" != "refs/heads/preview" ]; then',
      '      echo "::error::the read-only check is only allowed from refs/heads/main or refs/heads/preview"',
      '      exit 1',
      '    fi',
    ].join('\n'),
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
    // if: 行は部分一致だと他ブランチの追加を止められないため、行全体で固定する（#1879 M5 / #1881）。
    expect(workflow).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    // step 内 guard は exit 1 を含むブロック全体で固定する（#1879 M6 / #1881）。
    expect(stepBlock(workflow, 'Guard the target ref')).toEqual(expectedGuardSteps.production)
    // preview を許可する条件式が混ざっていないこと（job 条件は main のみ）。
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('preview 側は main / preview のみを許可する（feature branch のコードから secret を使わせない）', () => {
    // if: 行は部分一致だと他ブランチの追加を止められないため、行全体で固定する（#1879 M9 / #1881）。
    expect(previewWorkflow).toMatch(
      /^ {4}if: github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/preview'$/m,
    )
    // step 内 guard は exit 1 を含むブロック全体で固定する（#1879 M6b / #1881）。
    expect(stepBlock(previewWorkflow, 'Guard the target ref')).toEqual(expectedGuardSteps.preview)
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
      const countIndex = text.indexOf('Check trade quantity objects existence (read-only)')
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

  it('psql に渡す SQL に書き込み系の文を持たない（#1792 は information_schema の SELECT のみ）', () => {
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

  it('対象は Issue #1792 で固定した wanted_quantity 列と accept_trade_offer 関数のみで、information_schema を見る', () => {
    // 観測対象を issue で固定する。安易に対象を広げると「実測で裏付けのない
    // オブジェクトのフォールバック撤去」を誘発するため、ここで機械的に固定する。
    const sql = sqlBlocks(workflow).join('\n')
    expect(sql).toContain('information_schema.columns')
    expect(sql).toContain("table_schema = 'public' AND table_name = 'trade_offers'")
    expect(sql).toContain(`('wanted_quantity')`)
    // 欠落列の左辺列挙（VALUES）と実在 SELECT の WHERE 句が同じ列であること。
    const valuesClause = sql.match(/VALUES \(([\s\S]*?)\) AS t\(name\)/)?.[1] ?? ''
    expect(valuesClause).toContain(`'wanted_quantity'`)
    expect([...valuesClause.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual([
      'wanted_quantity',
    ])
    // 関数は 4引数版 accept_trade_offer が撤去前提。routine / parameters のみで実在を見る。
    expect(sql).toContain('information_schema.routines')
    expect(sql).toContain("routine_name = 'accept_trade_offer'")
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
    // CI が止める形にする（#954 の cards 列観測ペアと同じ契約）。
    expect(sqlBlocks(workflow)).toEqual(sqlBlocks(previewWorkflow))
  })
})
