import { afterEach, describe, expect, it, vi } from 'vitest'

import { printDiffTable } from '../../scripts/compare-analysis-dashboard-vs-sql.mjs'

/**
 * Issue #1082 のフォローアップ。
 * DB接続を伴わず、差分テーブルの列見出し・区切り・各差分行が欠落せず出力される契約を
 * 固定する。値の比較自体は diffAggregates の既存テストが担うため、ここでは表示整形だけを
 * 対象にし、console.log は spy へ閉じ込めてテストログを汚さない。
 */
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

    const lines = log.mock.calls.map(([line]) => String(line))

    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('METRIC')
    expect(lines[0]).toContain('基礎集計SQL')
    expect(lines[0]).toContain('get_analysis_* RPC')
    expect(lines[1]).toMatch(/^-+\s{2}-+\s{2}-+$/)
    expect(lines[2]).toMatch(/^totalUsers\s+10\s+11$/)
    expect(lines[3]).toMatch(/^rarityDistribution\.rare\s+25\s+26$/)
  })
})
