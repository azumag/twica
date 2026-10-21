import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/db-readonly-check-trade-offer-ownership{,-production}.yml` は Issue #1851
 * item 1（PR #1850 レビュー任意指摘 2）の実測用読み取り専用観測 workflow。
 * open な trade_offers のうち「出品コピーの現在の所有者が出品者ではない」行の件数を
 * production / preview 双方で数え、昇格前の後処理要否を判断する
 * （production 側は production の DB secret を使う）。
 *
 * 「書き込み経路が無い」「main 以外の ref から production へ到達しない」「実行する SQL が
 * preview 側と同一である」「対象が Issue #1851 で固定した2テーブルの件数集計のみで
 * 行データ・ユーザー識別子を出さない」という性質を機械的に固定する。
 *
 * 構え自体は #1792 の
 * tests/unit/db-readonly-check-trade-quantity-workflow.test.ts（さらに #954 の cards 列
 * 観測用 tests/unit/db-readonly-check-cards-columns-workflow.test.ts）と同じ契約テストの
 * パターンで、production secret を使う workflow を main に着地させる際の同一の安全設計を要求する。
 */
describe('db-readonly-check-trade-offer-ownership workflow contract (Issue #1851)', () => {
  const workflow = read('.github/workflows/db-readonly-check-trade-offer-ownership-production.yml')
  const previewWorkflow = read('.github/workflows/db-readonly-check-trade-offer-ownership.yml')

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
    expect(workflow).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    expect(workflow).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then')
    // preview を許可する条件式が混ざっていないこと（job 条件は main のみ）。
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('preview 側は main / preview のみを許可する（feature branch のコードから secret を使わせない）', () => {
    expect(previewWorkflow).toMatch(
      /^ {4}if: github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/preview'$/m,
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
      const countIndex = text.indexOf('Count open offers no longer owned by the offerer (read-only)')
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

  it('psql に渡す SQL に書き込み系の文を持たない（SELECT のみ）', () => {
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

  it('対象は Issue #1851 で固定した trade_offers × user_cards の件数集計のみを行う', () => {
    // 観測対象を issue で固定する。安易に対象を広げると実測根拠のない判断を誘発するため、
    // ここで機械的に固定する。
    const sql = sqlBlocks(workflow).join('\n')

    // 参照するテーブルは public.trade_offers と public.user_cards のみ。
    const tables = [...new Set([...sql.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]))]
    expect([...tables].sort()).toEqual(['trade_offers', 'user_cards'])

    // Issue #1851 本体の述語: open 出品 × 出品コピーの所有者が出品者で無い。
    expect(sql).toContain("status = 'open'")
    expect(sql).toContain('uc.id = o.offered_user_card_id')
    expect(sql).toContain('uc.user_id <> o.offerer_user_id')

    // 出力列（AS 別名）は件数・観測時刻・実効読み取り専用・テーブル存在のみに固定する。
    // ユーザー識別子（offerer_user_id / user_id の値）や行データが出ないことを機械的に保証する。
    // 数字・大文字混じりの別名（例: AS leak_1）も拾えるように [a-zA-Z_][a-zA-Z0-9_]* を使う。
    const aliases = [...sql.matchAll(/\bAS ([a-zA-Z_][a-zA-Z0-9_]*)\b/g)].map((m) => m[1])
    expect([...new Set(aliases)].sort()).toEqual([
      'observed_at',
      'open_offers',
      'open_offers_missing_copy',
      'open_offers_owner_mismatch',
      'trade_offers_table',
      'transaction_read_only',
      'user_cards_table',
    ])

    // 出力式ごとの contains 固定（列名だけでなく式そのものを固定する）。
    // count(*) を user_id 等に書き換えてもユーザー識別子が公開ログへ出る変更を検出する。
    expect(sql).toContain('SELECT count(*) AS open_offers_owner_mismatch')
    expect(sql).toContain("SELECT now() AS observed_at, current_setting('transaction_read_only') AS transaction_read_only")
    expect(sql).toContain("to_regclass('public.trade_offers') AS trade_offers_table")
    expect(sql).toContain("to_regclass('public.user_cards') AS user_cards_table")
  })

  it('公開ログを最小化する（DB 名・行データ・payload を出さない。件数と観測時刻は残す）', () => {
    // コメントでの言及は許容し、実行される SQL（heredoc の中身）だけを対象にする。
    const sql = sqlBlocks(workflow).join('\n')
    expect(sql).not.toContain('current_database()')
    expect(sql).not.toContain('SELECT *')
    expect(sql).toContain('to_regclass')
  })

  it('実行する SQL が preview 用 workflow と完全に一致する（片側だけ直す事故を防ぐ）', () => {
    // Environment だけを分け、観測内容は同一に保つ。環境ごとの実測根拠が乖離した時点で
    // CI が止める形にする（#954 の cards 列観測ペア、#1792 の trade quantity ペアと同じ契約）。
    expect(sqlBlocks(workflow)).toEqual(sqlBlocks(previewWorkflow))
  })
})
