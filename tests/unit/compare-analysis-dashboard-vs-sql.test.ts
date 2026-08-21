import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveDashboardDatabaseUrl,
  resolveStatementTimeout,
  diffAggregates,
  fetchBasicAggregates,
  fetchRpcAggregates,
  printDiffTable,
} from '../../scripts/compare-analysis-dashboard-vs-sql.mjs'

/**
 * scripts/compare-analysis-dashboard-vs-sql.mjs の純粋関数に対する単体テスト (#1077)。
 * DB接続は一切行わない。scripts/lib/db-migrate-core.test.ts と同じ流儀
 * （DB接続を伴わない純粋関数だけを対象に切り出してテストする）。
 */

describe('resolveDashboardDatabaseUrl', () => {
  it('DASHBOARD_DATABASE_URL を返す', () => {
    expect(resolveDashboardDatabaseUrl({ DASHBOARD_DATABASE_URL: 'postgres://dashboard' })).toBe(
      'postgres://dashboard'
    )
  })

  it('前後の空白を除去する', () => {
    expect(
      resolveDashboardDatabaseUrl({ DASHBOARD_DATABASE_URL: '  postgres://dashboard  ' })
    ).toBe('postgres://dashboard')
  })

  it('未設定なら空文字を返す（他の環境変数へフォールバックしない）', () => {
    // #1077 PR初版レビュー【必須】指摘: DATABASE_URL_PLANETSCALE/PLANETSCALE_DATABASE_URL は
    // それぞれ用途・権限が別の接続文字列であり、フォールバックすると誤って production の
    // 管理接続でpreviewを検証したことになりうる。フォールバックしないことを固定する回帰テスト。
    expect(
      resolveDashboardDatabaseUrl({
        DATABASE_URL_PLANETSCALE: 'postgres://planetscale',
        PLANETSCALE_DATABASE_URL: 'postgres://legacy',
      })
    ).toBe('')
  })

  it('空白のみの値は未設定として扱う', () => {
    expect(resolveDashboardDatabaseUrl({ DASHBOARD_DATABASE_URL: '   ' })).toBe('')
  })

  it('環境変数が何も無い場合は空文字を返す', () => {
    expect(resolveDashboardDatabaseUrl({})).toBe('')
  })
})

describe('resolveStatementTimeout', () => {
  it('未設定なら既定の30sを返す', () => {
    expect(resolveStatementTimeout({})).toBe('30s')
  })

  it('妥当な形式ならそのまま返す', () => {
    expect(resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '2min' })).toBe('2min')
    expect(resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '500ms' })).toBe('500ms')
    expect(resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '90' })).toBe('90')
  })

  it('前後の空白を除去する', () => {
    expect(resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '  60s  ' })).toBe('60s')
  })

  it('不正な形式はエラーを投げる（tx.unsafe()へ混入させないための入力検証）', () => {
    expect(() =>
      resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: "30s'; DROP TABLE users; --" })
    ).toThrow(/DASHBOARD_COMPARE_STATEMENT_TIMEOUT の形式が不正です/)
  })

  it('0（またはその単位付き表記）はタイムアウト無効化を意味するため拒否する', () => {
    // PostgreSQLはstatement_timeout=0を「無制限」として扱うため、これを許すと
    // 「想定外に長時間ブロックしないための安全弁」が環境変数だけで無効化できてしまう。
    expect(() => resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '0' })).toThrow(
      /0は無制限を意味するため拒否/
    )
    expect(() => resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '0s' })).toThrow(
      /0は無制限を意味するため拒否/
    )
    expect(() => resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '0ms' })).toThrow(
      /0は無制限を意味するため拒否/
    )
  })

  it('空白のみの値は未設定として扱い既定値を返す', () => {
    expect(resolveStatementTimeout({ DASHBOARD_COMPARE_STATEMENT_TIMEOUT: '   ' })).toBe('30s')
  })
})

describe('diffAggregates', () => {
  const baseBasic = {
    totalUsers: 10,
    totalStreamers: 3,
    totalCards: 20,
    totalUserCards: 40,
    usersWithTos: 8,
    usersWithCards: 6,
    totalGacha: 100,
    uniqueUsers: 9,
    todayGacha: 5,
    weekGacha: 30,
    monthGacha: 80,
    rarityDistribution: { common: 70, rare: 25, legendary: 5 },
  }
  const baseRpc = {
    ...baseBasic,
    rarityDistribution: { ...baseBasic.rarityDistribution },
    usersSummaryTotalUsers: baseBasic.totalUsers,
    streamersSummaryTotalStreamers: baseBasic.totalStreamers,
    streamersSummaryTotalCards: baseBasic.totalCards,
  }

  it('全項目が一致する場合は空配列を返す', () => {
    expect(diffAggregates(baseBasic, baseRpc)).toEqual([])
  })

  it('スカラー指標の不一致を検出する', () => {
    const rpc = { ...baseRpc, totalUsers: 11, weekGacha: 31 }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual(
      expect.arrayContaining([
        { metric: 'totalUsers', expected: 10, actual: 11 },
        { metric: 'weekGacha', expected: 30, actual: 31 },
      ])
    )
    expect(diffs).toHaveLength(2)
  })

  it('get_analysis_users_summary() 由来のtotalUsersの食い違いを検出する', () => {
    const rpc = { ...baseRpc, usersSummaryTotalUsers: 11 }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual([{ metric: 'usersSummary.totalUsers', expected: 10, actual: 11 }])
  })

  it('get_analysis_streamers_summary() 由来のtotalStreamers/totalCardsの食い違いも検出する', () => {
    const rpc = { ...baseRpc, streamersSummaryTotalStreamers: 4 }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual([{ metric: 'streamersSummary.totalStreamers', expected: 3, actual: 4 }])
  })

  it('usersSummary/streamersSummaryの値がRPCから消えた場合(undefined)も差分として検出する', () => {
    // #1077 PR初版レビュー【必須】指摘の回帰テスト: get_analysis_streamers_summary() が
    // 将来totalStreamers/totalCardsキーを返さなくなる退行が「成功扱い」にならないことを
    // 固定する（以前はrpc値がundefinedだとこの比較自体をスキップしていた）。
    const rpc = {
      ...baseRpc,
      usersSummaryTotalUsers: undefined,
      streamersSummaryTotalStreamers: undefined,
      streamersSummaryTotalCards: undefined,
    }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual(
      expect.arrayContaining([
        { metric: 'usersSummary.totalUsers', expected: 10, actual: undefined },
        { metric: 'streamersSummary.totalStreamers', expected: 3, actual: undefined },
        { metric: 'streamersSummary.totalCards', expected: 20, actual: undefined },
      ])
    )
    expect(diffs).toHaveLength(3)
  })

  it('rarityDistributionの不一致をrarityごとに報告する', () => {
    const rpc = { ...baseRpc, rarityDistribution: { common: 70, rare: 26, legendary: 5 } }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual([{ metric: 'rarityDistribution.rare', expected: 25, actual: 26 }])
  })

  it('片方にしか無いrarityはもう片方を0として比較する', () => {
    const basic = {
      ...baseBasic,
      rarityDistribution: { ...baseBasic.rarityDistribution, epic: 2 },
    }
    const diffs = diffAggregates(basic, baseRpc)
    expect(diffs).toEqual([{ metric: 'rarityDistribution.epic', expected: 2, actual: 0 }])
  })
})

/**
 * postgres.js のタグ付きテンプレート呼び出しを模す最小限のfake sql。
 * fetchBasicAggregates/fetchRpcAggregatesはいずれも`${}`によるfragment合成をしない
 * 単純な呼び出ししかしないため、クエリ文字列に含まれる目印文字列で分岐して固定
 * レスポンスを返すだけで十分（tests/unit/analysis-admin-db-driver.test.ts の
 * fakeSqlTagより大幅に単純化できる）。呼び出し順序に依存しないよう、
 * 目印文字列とレスポンスの配列を渡して都度先頭から一致するものを探す。
 */
function makeFakeSql(responses: Array<[string, unknown]>) {
  return (strings: readonly string[]) => {
    const text = strings.join('')
    for (const [marker, result] of responses) {
      if (text.includes(marker)) return Promise.resolve(result)
    }
    throw new Error(`makeFakeSql: no matching response for query: ${text}`)
  }
}

describe('fetchBasicAggregates', () => {
  it('基礎集計クエリと rarity 内訳クエリの結果を正しいキーへ写像する', async () => {
    // #1081 PR 2回目レビュー【任意】指摘: SQLの列名（total_user_cards等）→返却キーの
    // 写像ミスは「一致した」と誤報告する最も危険な箇所のため、fetchRpcAggregatesと
    // 同様にfake sqlで固定する。
    const tx = makeFakeSql([
      [
        'total_users',
        [
          {
            total_users: 10,
            total_streamers: 3,
            total_cards: 20,
            total_user_cards: 40,
            users_with_tos: 8,
            users_with_cards: 6,
            total_gacha: 100,
            unique_users: 9,
            today_gacha: 5,
            week_gacha: 30,
            month_gacha: 80,
          },
        ],
      ],
      [
        'GROUP BY c.rarity',
        [
          { rarity: 'common', draw_count: 70 },
          { rarity: 'rare', draw_count: 25 },
          { rarity: 'legendary', draw_count: 5 },
        ],
      ],
    ])

    const result = await fetchBasicAggregates(tx)

    expect(result).toEqual({
      totalUsers: 10,
      totalStreamers: 3,
      totalCards: 20,
      totalUserCards: 40,
      usersWithTos: 8,
      usersWithCards: 6,
      totalGacha: 100,
      uniqueUsers: 9,
      todayGacha: 5,
      weekGacha: 30,
      monthGacha: 80,
      rarityDistribution: { common: 70, rare: 25, legendary: 5 },
    })
  })

  it('gacha_historyが0件でrarity内訳が空でもrarityDistributionは空オブジェクトになる', async () => {
    const tx = makeFakeSql([
      [
        'total_users',
        [
          {
            total_users: 0,
            total_streamers: 0,
            total_cards: 0,
            total_user_cards: 0,
            users_with_tos: 0,
            users_with_cards: 0,
            total_gacha: 0,
            unique_users: 0,
            today_gacha: 0,
            week_gacha: 0,
            month_gacha: 0,
          },
        ],
      ],
      ['GROUP BY c.rarity', []],
    ])

    const result = await fetchBasicAggregates(tx)
    expect(result.rarityDistribution).toEqual({})
  })
})

describe('fetchRpcAggregates', () => {
  it('4つのRPCの戻り値を正しいキーへ写像する', async () => {
    const tx = makeFakeSql([
      [
        'get_analysis_overview',
        [
          {
            result: {
              stats: {
                totalUsers: 10,
                totalStreamers: 3,
                totalCards: 20,
                todayGacha: 5,
                weekGacha: 30,
                monthGacha: 80,
              },
            },
          },
        ],
      ],
      [
        'get_analysis_users_summary',
        [{ result: { totalUsers: 10, totalCards: 40, usersWithTos: 8, usersWithCards: 6 } }],
      ],
      [
        'get_analysis_streamers_summary',
        [{ result: { totalStreamers: 3, totalCards: 20 } }],
      ],
      [
        'get_analysis_gacha_summary',
        [
          {
            result: {
              totalGacha: 100,
              uniqueUsers: 9,
              rarityDistribution: [
                { rarity: 'common', value: 70 },
                { rarity: 'rare', value: 25 },
              ],
            },
          },
        ],
      ],
    ])

    const result = await fetchRpcAggregates(tx)

    expect(result).toEqual({
      totalUsers: 10,
      totalStreamers: 3,
      totalCards: 20,
      totalUserCards: 40,
      usersWithTos: 8,
      usersWithCards: 6,
      totalGacha: 100,
      uniqueUsers: 9,
      todayGacha: 5,
      weekGacha: 30,
      monthGacha: 80,
      rarityDistribution: { common: 70, rare: 25 },
      usersSummaryTotalUsers: 10,
      streamersSummaryTotalStreamers: 3,
      streamersSummaryTotalCards: 20,
    })
  })

  it('get_analysis_streamers_summary() がtotalStreamers/totalCardsを返さない場合はundefinedのまま伝播する', async () => {
    // diffAggregatesがこのundefinedを差分として検出することを保証するための前段テスト
    // （fetchRpcAggregates自身がundefinedを握りつぶしたり0埋めしたりしないことを固定する）。
    const tx = makeFakeSql([
      [
        'get_analysis_overview',
        [
          {
            result: {
              stats: { totalUsers: 1, totalStreamers: 1, totalCards: 1, todayGacha: 0, weekGacha: 0, monthGacha: 0 },
            },
          },
        ],
      ],
      [
        'get_analysis_users_summary',
        [{ result: { totalUsers: 1, totalCards: 1, usersWithTos: 0, usersWithCards: 0 } }],
      ],
      ['get_analysis_streamers_summary', [{ result: {} }]],
      [
        'get_analysis_gacha_summary',
        [{ result: { totalGacha: 0, uniqueUsers: 0, rarityDistribution: [] } }],
      ],
    ])

    const result = await fetchRpcAggregates(tx)

    expect(result.streamersSummaryTotalStreamers).toBeUndefined()
    expect(result.streamersSummaryTotalCards).toBeUndefined()
  })
})

describe('printDiffTable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('見出し・区切り線・全差分行を順番どおり出力する', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printDiffTable([
      { metric: 'totalUsers', expected: 10, actual: 11 },
      { metric: 'rarityDistribution.rare', expected: 25, actual: 26 },
    ])

    // printDiffTable は列幅を揃えるため最終列も padEnd する。行末空白は表示上の意味を
    // 持たないため除去し、列内容と順序の契約だけを検証する。全角文字の表示幅は
    // printDiffTable のJSDocに記載した既存制約のため、このテストでは扱わない。
    const lines = log.mock.calls.map(([line]) => String(line).trimEnd())

    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^METRIC\s+基礎集計SQL\s+get_analysis_\* RPC$/)
    expect(lines[1]).toMatch(/^-+\s{2}-+\s{2}-+$/)
    expect(lines[2]).toMatch(/^totalUsers\s+10\s+11$/)
    expect(lines[3]).toMatch(/^rarityDistribution\.rare\s+25\s+26$/)
  })
})
