import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const migration = readFileSync(
  resolve(repoRoot, 'supabase/migrations/20260731120000_paginate_analysis_dashboard.sql'),
  'utf8'
)
const usersPage = readFileSync(resolve(repoRoot, 'analysis/src/pages/Users.tsx'), 'utf8')
const streamersPage = readFileSync(resolve(repoRoot, 'analysis/src/pages/Streamers.tsx'), 'utf8')
const app = readFileSync(resolve(repoRoot, 'analysis/src/App.tsx'), 'utf8')
const gachaPage = readFileSync(resolve(repoRoot, 'analysis/src/pages/Gacha.tsx'), 'utf8')
const localAdminApi = readFileSync(resolve(repoRoot, 'analysis/dev/localAdminApi.ts'), 'utf8')
const streamerGachaPage = readFileSync(
  resolve(repoRoot, 'analysis/src/pages/StreamerGachaHistory.tsx'),
  'utf8'
)

describe('analysis dashboard: bounded data contract', () => {
  it('DB RPCは一覧を最大100行に制限し、安定したid tie-breakerを持つ', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_users_page(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_users_summary()')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_streamers_page(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_streamers_summary()')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_streamer_options_page(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_gacha_summary(')
    const pageRpcBodies = [
      'get_analysis_users_page',
      'get_analysis_streamer_options_page',
      'get_analysis_streamers_page',
    ].map((functionName) => {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}(`)
      const end = migration.indexOf('\nCREATE OR REPLACE FUNCTION ', start + 1)

      expect(start).toBeGreaterThanOrEqual(0)
      return migration.slice(start, end === -1 ? migration.length : end)
    })

    // streamers pageは動的SQLのため、LIMIT/OFFSET内の引数名が$2になる。
    expect(pageRpcBodies).toHaveLength(3)
    for (const body of pageRpcBodies) {
      expect(body).toMatch(
        /LIMIT LEAST\(GREATEST\(COALESCE\((?:p_page_size|\$2), \d+\), 1\), 100\)/,
      )
    }
    expect(migration).toContain('fu.id ASC')
    expect(migration).toContain('fs.id ASC')
    expect(migration).toContain('p.id ASC')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION get_analysis_users_page')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION get_analysis_streamers_page')
  })

  it('検索条件はカード/ボーナス集計より前の候補CTEへ適用する', () => {
    const usersCandidate = migration.indexOf('WITH candidate_users AS MATERIALIZED')
    const usersCardCount = migration.indexOf('FROM user_cards uc')
    const streamersCandidate = migration.indexOf('WITH candidate_streamers AS MATERIALIZED')

    expect(usersCandidate).toBeGreaterThanOrEqual(0)
    expect(usersCardCount).toBeGreaterThan(usersCandidate)
    expect(migration).toContain('JOIN candidate_users cu ON cu.id = uc.user_id')
    expect(streamersCandidate).toBeGreaterThan(usersCandidate)
    expect(migration.indexOf('candidate_card_counts AS MATERIALIZED')).toBeGreaterThan(streamersCandidate)
    expect(migration).toContain('JOIN candidate_streamers cs ON cs.id = c.streamer_id')
    expect(migration).toContain('FROM get_analysis_user_candidate_rows(p_search) AS u')
    expect(migration).toContain('FROM get_analysis_streamer_candidate_rows(')
    expect(migration).not.toContain('JOIN get_analysis_user_candidate_ids')
    expect(migration).not.toContain('JOIN get_analysis_streamer_candidate_ids')
    expect(migration).toContain('s.twitch_username ILIKE $3 ESCAPE E')
    expect(migration).toContain('LEFT JOIN users u ON u.twitch_user_id = s.twitch_user_id')
    expect(migration).toContain("v_filter := 'gh.redeemed_at >= $1'")
  })

  it('一覧ページは現在ページのrowsとDB countをDataTableへ渡し、全件をローカルsliceしない', () => {
    expect(usersPage).toContain('page: currentPage')
    expect(usersPage).toContain('debouncedSearchTerm')
    expect(usersPage).toContain('if (searchTerm !== debouncedSearchTerm) return')
    expect(usersPage).toContain('totalItems: totalCount')
    expect(usersPage).not.toContain('data={sortedUsers}')
    expect(streamersPage).toContain('page: currentPage')
    expect(streamersPage).toContain('debouncedSearchQuery')
    expect(streamersPage).toContain('if (searchQuery !== debouncedSearchQuery) return')
    expect(streamersPage).toContain('totalItems: totalCount')
    expect(streamersPage).not.toContain('data={filteredAndSortedStreamers}')
  })

  it('一覧とsummaryの失敗状態を分離し、lazy route失敗後の遷移でboundaryを再生成する', () => {
    // summary RPCは検索・ページ変更では再取得しないため、一覧の成功でsummaryの
    // エラーが消える実装へ戻ると、初期値の集計を正常値として表示してしまう。
    // React二重解決を避けるため、ここではページの状態契約とroute keyをsource-level
    // で固定し、実DBfixtureとは異なるUI回帰を軽量に検出する。
    expect(usersPage).toContain('summaryError')
    expect(usersPage).toContain('listError')
    expect(usersPage).toContain('summaryRetryToken')
    expect(usersPage).toContain('listRetryToken')
    expect(streamersPage).toContain('summaryError')
    expect(streamersPage).toContain('listError')
    expect(streamersPage).toContain('summaryRetryToken')
    expect(streamersPage).toContain('listRetryToken')
    expect(app).toContain('const location = useLocation()')
    expect(app).toContain('<RouteErrorBoundary key={location.key}>')
  })

  it('Gacha系の初回期間は7日で、チャートは行取得ではなく集計RPCを使う', () => {
    expect(gachaPage).toContain("useState<TimeRange>('7d')")
    expect(gachaPage).toContain('adminApi.getStreamerOptions(')
    expect(gachaPage).toContain('const selected = previousRows.find')
    expect(gachaPage).not.toContain('adminApi.getStreamers(')
    expect(streamerGachaPage).toContain("useState<TimeRange>('7d')")
    expect(streamerGachaPage).toContain('adminApi.getGachaSummary(')
    expect(streamerGachaPage).not.toContain('adminApi.getGachaChart(')
    expect(streamerGachaPage).not.toContain('new Set(chartData')
    expect(localAdminApi).toContain("path === '/gacha/table'")
    expect(localAdminApi).toContain('parsePagination(url, 100)')
    expect(localAdminApi).toContain("path === '/users/summary'")
    expect(localAdminApi).toContain("path === '/streamers/summary'")
  })
})
