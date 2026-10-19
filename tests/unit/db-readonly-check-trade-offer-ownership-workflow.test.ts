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
 * preview 側と同一である」に加え、観測 SQL の **全statement・順序・個数** と guard step
 * （exit 1 を含むブロック全体）を期待値で網羅固定する。#1879 の mutation テストで
 * 従来の alias セット固定・出力式 contains 固定・guard ヘッダー contains をすり抜ける
 * 変異（M2: 未alias出力の追加 / M4: 許可alias重複の別SELECT追加 / M6・M6b: guard の
 * exit 1 行のみ削除）が実測されており、許可した観測SQL・guard 以外は変更の種類を問わず
 * CI が止めることで「行データ・ユーザー識別子が出ない」ことを機械的に保証する（#1881）。
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

  /**
   * heredoc の中身を SQL statement 列へ分解する。psql のメタコマンド行（\pset / \echo）は
   * SQL ではなく表示制御のため除外し、改行・連続空白は単一スペースへ正規化する
   * （#1881 の「空白程度の限定正規化」）。トークン列は正規化で消えないため、
   * 改行位置・インデントの差し替えでは素通りできず、文言の変更はすべて検出される。
   */
  function sqlStatements(text: string): string[] {
    return sqlBlocks(text)
      .flatMap((block) => block.split(';'))
      .map((raw) =>
        raw
          .split('\n')
          .filter((line) => !/^\s*\\[a-z]/.test(line))
          .join(' '),
      )
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter((statement) => statement.length > 0)
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
   * Issue #1851 で固定した観測SQL。実workflow の statement 列とこの期待値を全件・
   * 順序・個数で突き合わせる（網羅固定）。
   *   - statement 0: 観測時刻と実効読み取り専用フラグ
   *   - statement 1: 対象2テーブル（public.trade_offers / public.user_cards）の存在確認
   *   - statement 2–4: 件数集計（open 総数 / 出品コピーの所有者不一致 / 出品コピー行なし）
   * 参照テーブルと出力列（件数・観測時刻・実効読み取り専用・テーブル存在のみ）は
   * この配列に含まれる statement だけに現れるため、ユーザー識別子
   * （offerer_user_id / user_id の値）や行データを出す statement を追加・置換する変更は
   * 必ずここで不一致になる（#1879 mutation M2 の「未alias出力の追加」を含む）。
   */
  const expectedObservationStatements = [
    "SELECT now() AS observed_at, current_setting('transaction_read_only') AS transaction_read_only",
    "SELECT to_regclass('public.trade_offers') AS trade_offers_table, to_regclass('public.user_cards') AS user_cards_table",
    "SELECT count(*) AS open_offers FROM public.trade_offers WHERE status = 'open'",
    "SELECT count(*) AS open_offers_owner_mismatch FROM public.trade_offers o JOIN public.user_cards uc ON uc.id = o.offered_user_card_id WHERE o.status = 'open' AND uc.user_id <> o.offerer_user_id",
    "SELECT count(*) AS open_offers_missing_copy FROM public.trade_offers o WHERE o.status = 'open' AND NOT EXISTS (SELECT 1 FROM public.user_cards uc WHERE uc.id = o.offered_user_card_id)",
  ]

  /**
   * guard step の期待値（exit 1 を含むブロック全体）。`::error::` 警告だけを残して
   * exit 1 を消す「警告を出して通す no-op 化」（#1879 mutation M6/M6b）や、拒否条件の
   * 弱体化を検出するため、ヘッダー行だけではなく step 全体を固定する。
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

  /**
   * workflow テキストの固定内容（観測SQLの全statement・順序・個数、guard step 全体）との
   * 突き合わせ結果を violations として返す純関数。正例（実ファイル → 空）と負例
   * （変異コピー → 非空）で同じロジックを使うため、負例テストは「実際に運用されている
   * 検証そのものが変異を拒否する」ことを確認できる（#1881）。
   */
  function contractViolations(text: string, side: 'production' | 'preview'): string[] {
    const violations: string[] = []

    // (1) 観測SQLの網羅固定。alias セット・出力式・テーブル集合の個別固定と異なり、
    //     許可した5 statement 以外の一切（未alias出力・別SELECTの追加を含む）を止める。
    const statements = sqlStatements(text)
    const width = Math.max(statements.length, expectedObservationStatements.length)
    for (let i = 0; i < width; i++) {
      if (statements[i] !== expectedObservationStatements[i]) {
        violations.push(
          `観測SQL statement[${i}] が固定内容と一致しない（期待: ${JSON.stringify(
            expectedObservationStatements[i],
          )}, 実際: ${JSON.stringify(statements[i])}）`,
        )
      }
    }

    // (2) guard step のブロック全体固定（exit 1 を含む）。
    const guard = stepBlock(text, 'Guard the target ref')
    if (guard === null) {
      violations.push('「Guard the target ref」step が存在しない')
    } else if (guard !== expectedGuardSteps[side]) {
      violations.push('「Guard the target ref」step が固定内容（exit 1 を含むブロック全体）と一致しない')
    }

    return violations
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
    // step 内 guard の拒否条件は contractViolations がブロック全体（exit 1 を含む）で固定する。
    expect(workflow).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    // preview を許可する条件式が混ざっていないこと（job 条件は main のみ）。
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('preview 側は main / preview のみを許可する（feature branch のコードから secret を使わせない）', () => {
    // step 内 guard の拒否条件は contractViolations がブロック全体（exit 1 を含む）で固定する。
    expect(previewWorkflow).toMatch(
      /^ {4}if: github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/preview'$/m,
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

  it('観測SQLの全statementと guard step は Issue #1851 の固定内容から動かない（網羅固定・正例）', () => {
    // 正例: 実workflow は violations 空。負例（#1879 の mutation M1–M4・M6/M6b を適用した
    // コピー）は別 test で同じ純関数により非空になることを確認する。
    // 従来の alias セット固定・出力式 contains 固定・テーブル集合固定は全statementの網羅固定に
    // 包含されるため #1881 で整理した（検出は強化され、緩和されてはいない）。
    expect(contractViolations(workflow, 'production')).toEqual([])
    expect(contractViolations(previewWorkflow, 'preview')).toEqual([])
  })

  it('負例: 観測SQLへの代表的な改変を両workflow同時に加えても契約違反として検出する', () => {
    // #1879 で実測されたすり抜け変異（M2: 未alias出力の追加 / M4: 許可alias重複の別SELECT追加）
    // と、従来検出済みだった代表例（M1: 出力式の置換 / M3・M3b: 数字・大文字aliasの追加）を
    // 負例として固定する。「両workflow同時」は 13 test 目の SQL 一致確認をすり抜ける最も強い
    // 形であり、それでも網羅固定が止めることを保証する。
    const mutations: Array<[label: string, mutate: (text: string) => string]> = [
      [
        'M1: 出力式の置換（count(*) → uc.user_id）',
        (text) =>
          text.replace(
            'SELECT count(*) AS open_offers_owner_mismatch',
            'SELECT uc.user_id AS open_offers_owner_mismatch',
          ),
      ],
      [
        'M2: 未alias出力の追加（, min(uc.user_id::text)）— ユーザー識別子が公開ログへ出る変更',
        (text) =>
          text.replace(
            'SELECT count(*) AS open_offers_owner_mismatch',
            'SELECT count(*), min(uc.user_id::text) AS open_offers_owner_mismatch',
          ),
      ],
      [
        'M3: 数字aliasの追加（, count(*) AS leak_1）',
        (text) =>
          text.replace(
            'SELECT count(*) AS open_offers_owner_mismatch',
            'SELECT count(*) AS open_offers_owner_mismatch, count(*) AS leak_1',
          ),
      ],
      [
        'M3b: 大文字aliasの追加（, count(*) AS LEAK）',
        (text) =>
          text.replace(
            'SELECT count(*) AS open_offers_owner_mismatch',
            'SELECT count(*) AS open_offers_owner_mismatch, count(*) AS LEAK',
          ),
      ],
      [
        'M4: 許可alias重複の別SELECT追加（SELECT now() AS observed_at FROM public.user_cards;）',
        (text) =>
          text.replace(
            'AND NOT EXISTS (SELECT 1 FROM public.user_cards uc WHERE uc.id = o.offered_user_card_id);\n          SQL',
            'AND NOT EXISTS (SELECT 1 FROM public.user_cards uc WHERE uc.id = o.offered_user_card_id);\n          SELECT now() AS observed_at FROM public.user_cards;\n          SQL',
          ),
      ],
    ]
    for (const [label, mutate] of mutations) {
      const mutatedWorkflow = mutate(workflow)
      const mutatedPreviewWorkflow = mutate(previewWorkflow)
      // replace 先が実workflowに無ければ負例が形骸化するため、変異の適用を前提確認する。
      expect(mutatedWorkflow, label).not.toBe(workflow)
      expect(mutatedPreviewWorkflow, label).not.toBe(previewWorkflow)
      // 両workflowを同じ内容へ変えるため、SQL 一致確認（片側だけ直す事故の検出）は
      // この変異を止めない。それでも網羅固定が検出する。
      expect(sqlBlocks(mutatedWorkflow), label).toEqual(sqlBlocks(mutatedPreviewWorkflow))
      expect(contractViolations(mutatedWorkflow, 'production'), label).not.toEqual([])
      expect(contractViolations(mutatedPreviewWorkflow, 'preview'), label).not.toEqual([])
    }
  })

  it('負例: guard の exit 1 行のみを消す変更（警告だけの no-op 化）を検出する', () => {
    // #1879 mutation M6（production）/ M6b（preview）。exit 1 を消して ::error:: 警告だけを
    // 残すと guard は「警告を出して通す」no-op になるため、ブロック全体固定で止める。
    const removeGuardExit = (text: string) =>
      text.replace(/(- name: Guard the target ref[\s\S]*?)\n\s*exit 1\b/, '$1')
    const mutatedWorkflow = removeGuardExit(workflow)
    const mutatedPreviewWorkflow = removeGuardExit(previewWorkflow)
    expect(mutatedWorkflow).not.toBe(workflow)
    expect(mutatedPreviewWorkflow).not.toBe(previewWorkflow)
    expect(contractViolations(mutatedWorkflow, 'production')).not.toEqual([])
    expect(contractViolations(mutatedPreviewWorkflow, 'preview')).not.toEqual([])
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
