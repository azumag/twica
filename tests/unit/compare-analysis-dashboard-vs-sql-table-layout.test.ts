import { afterEach, describe, expect, it, vi } from 'vitest'
import { printDiffTable } from '../../scripts/compare-analysis-dashboard-vs-sql.mjs'

describe('printDiffTable separator layout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ネスト名を含む実在メトリクスで区切り線の各列幅を固定する', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // 平坦なメトリクス名も正当だが、実出力で使うネスト名を fixture へ含め、
    // 「誤った名前の修正」ではなく列幅契約を実出力へ寄せる意図を明確にする。
    printDiffTable([
      { metric: 'usersSummary.totalUsers', expected: 10, actual: 11 },
      { metric: 'rarityDistribution.rare', expected: 25, actual: 26 },
    ])

    const lines = log.mock.calls.map(([line]) => String(line).trimEnd())
    const expectedWidths = [
      Math.max('METRIC'.length, 'usersSummary.totalUsers'.length, 'rarityDistribution.rare'.length),
      Math.max('基礎集計SQL'.length, '10'.length, '25'.length),
      Math.max('get_analysis_* RPC'.length, '11'.length, '26'.length),
    ]

    expect(lines[1]).toBe(
      expectedWidths.map((width) => '-'.repeat(width)).join('  ')
    )
  })
})
