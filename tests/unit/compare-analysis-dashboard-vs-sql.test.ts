import { describe, expect, it } from 'vitest'
import {
  resolveDashboardDatabaseUrl,
  diffAggregates,
  fetchRpcAggregates,
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

  it('get_analysis_streamers_summary() 由来のtotalStreamers/totalCardsの食い違いも検出する', () => {
    const rpc = { ...baseRpc, streamersSummaryTotalStreamers: 4 }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual([{ metric: 'streamersSummary.totalStreamers', expected: 3, actual: 4 }])
  })

  it('streamersSummaryの値がRPCから消えた場合(undefined)も差分として検出する', () => {
    // #1077 PR初版レビュー【必須】指摘の回帰テスト: get_analysis_streamers_summary() が
    // 将来totalStreamers/totalCardsキーを返さなくなる退行が「成功扱い」にならないことを
    // 固定する（以前はrpc値がundefinedだとこの比較自体をスキップしていた）。
    const rpc = {
      ...baseRpc,
      streamersSummaryTotalStreamers: undefined,
      streamersSummaryTotalCards: undefined,
    }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual(
      expect.arrayContaining([
        { metric: 'streamersSummary.totalStreamers', expected: 3, actual: undefined },
        { metric: 'streamersSummary.totalCards', expected: 20, actual: undefined },
      ])
    )
    expect(diffs).toHaveLength(2)
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
 * fetchRpcAggregatesは`${}`によるfragment合成をしない単純な呼び出ししかしないため、
 * クエリ文字列に含まれるRPC関数名で分岐して固定レスポンスを返すだけで十分
 * （tests/unit/analysis-admin-db-driver.test.ts のfakeSqlTagより大幅に単純化できる）。
 */
function makeFakeRpcSql(responses: Array<[string, unknown]>) {
  return (strings: readonly string[]) => {
    const text = strings.join('')
    for (const [marker, result] of responses) {
      if (text.includes(marker)) return Promise.resolve([{ result }])
    }
    throw new Error(`makeFakeRpcSql: no matching response for query: ${text}`)
  }
}

describe('fetchRpcAggregates', () => {
  it('4つのRPCの戻り値を正しいキーへ写像する', async () => {
    const tx = makeFakeRpcSql([
      [
        'get_analysis_overview',
        {
          stats: {
            totalUsers: 10,
            totalStreamers: 3,
            totalCards: 20,
            todayGacha: 5,
            weekGacha: 30,
            monthGacha: 80,
          },
        },
      ],
      ['get_analysis_users_summary', { totalCards: 40, usersWithTos: 8, usersWithCards: 6 }],
      ['get_analysis_streamers_summary', { totalStreamers: 3, totalCards: 20 }],
      [
        'get_analysis_gacha_summary',
        {
          totalGacha: 100,
          uniqueUsers: 9,
          rarityDistribution: [
            { rarity: 'common', value: 70 },
            { rarity: 'rare', value: 25 },
          ],
        },
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
      streamersSummaryTotalStreamers: 3,
      streamersSummaryTotalCards: 20,
    })
  })

  it('get_analysis_streamers_summary() がtotalStreamers/totalCardsを返さない場合はundefinedのまま伝播する', async () => {
    // diffAggregatesがこのundefinedを差分として検出することを保証するための前段テスト
    // （fetchRpcAggregates自身がundefinedを握りつぶしたり0埋めしたりしないことを固定する）。
    const tx = makeFakeRpcSql([
      [
        'get_analysis_overview',
        { stats: { totalUsers: 1, totalStreamers: 1, totalCards: 1, todayGacha: 0, weekGacha: 0, monthGacha: 0 } },
      ],
      ['get_analysis_users_summary', { totalCards: 1, usersWithTos: 0, usersWithCards: 0 }],
      ['get_analysis_streamers_summary', {}],
      ['get_analysis_gacha_summary', { totalGacha: 0, uniqueUsers: 0, rarityDistribution: [] }],
    ])

    const result = await fetchRpcAggregates(tx)

    expect(result.streamersSummaryTotalStreamers).toBeUndefined()
    expect(result.streamersSummaryTotalCards).toBeUndefined()
  })
})
