import { describe, expect, it } from 'vitest'
import {
  resolveConnectionString,
  diffAggregates,
} from '../../scripts/compare-analysis-dashboard-vs-sql.js'

/**
 * scripts/compare-analysis-dashboard-vs-sql.js の純粋関数に対する単体テスト (#1077)。
 * DB接続は一切行わない。scripts/lib/db-migrate-core.test.ts と同じ流儀
 * （DB接続を伴わない純粋関数だけを対象に切り出してテストする）。
 */

describe('resolveConnectionString', () => {
  it('DASHBOARD_DATABASE_URL を最優先で使う', () => {
    const url = resolveConnectionString({
      DASHBOARD_DATABASE_URL: 'postgres://dashboard',
      DATABASE_URL_PLANETSCALE: 'postgres://planetscale',
      PLANETSCALE_DATABASE_URL: 'postgres://legacy',
    })
    expect(url).toBe('postgres://dashboard')
  })

  it('DASHBOARD_DATABASE_URL が無い場合は DATABASE_URL_PLANETSCALE にフォールバックする', () => {
    const url = resolveConnectionString({
      DATABASE_URL_PLANETSCALE: 'postgres://planetscale',
      PLANETSCALE_DATABASE_URL: 'postgres://legacy',
    })
    expect(url).toBe('postgres://planetscale')
  })

  it('前2つが無い場合は PLANETSCALE_DATABASE_URL にフォールバックする', () => {
    const url = resolveConnectionString({ PLANETSCALE_DATABASE_URL: 'postgres://legacy' })
    expect(url).toBe('postgres://legacy')
  })

  it('空文字は未設定として扱う（前後空白のみの値でフォールバックを止めない）', () => {
    const url = resolveConnectionString({
      DASHBOARD_DATABASE_URL: '   ',
      DATABASE_URL_PLANETSCALE: 'postgres://planetscale',
    })
    expect(url).toBe('postgres://planetscale')
  })

  it('いずれも無い場合は空文字を返す', () => {
    expect(resolveConnectionString({})).toBe('')
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
    expect(diffs).toEqual([
      { metric: 'streamersSummary.totalStreamers', expected: 3, actual: 4 },
    ])
  })

  it('rarityDistributionの不一致をrarityごとに報告する', () => {
    const rpc = { ...baseRpc, rarityDistribution: { common: 70, rare: 26, legendary: 5 } }
    const diffs = diffAggregates(baseBasic, rpc)
    expect(diffs).toEqual([
      { metric: 'rarityDistribution.rare', expected: 25, actual: 26 },
    ])
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
