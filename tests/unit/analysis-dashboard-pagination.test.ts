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
const gachaPage = readFileSync(resolve(repoRoot, 'analysis/src/pages/Gacha.tsx'), 'utf8')
const localAdminApi = readFileSync(resolve(repoRoot, 'analysis/dev/localAdminApi.ts'), 'utf8')
const streamerGachaPage = readFileSync(
  resolve(repoRoot, 'analysis/src/pages/StreamerGachaHistory.tsx'),
  'utf8'
)

describe('analysis dashboard: bounded data contract', () => {
  it('DB RPCは一覧を最大100行に制限し、安定したid tie-breakerを持つ', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_users_page(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_streamers_page(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION get_analysis_streamer_options_page(')
    expect(migration.match(/LIMIT LEAST\(GREATEST\(COALESCE\(p_page_size/g)).toHaveLength(3)
    expect(migration).toContain('), 100)')
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
    const streamersCardCount = migration.indexOf('FROM cards c')

    expect(usersCandidate).toBeGreaterThanOrEqual(0)
    expect(usersCardCount).toBeGreaterThan(usersCandidate)
    expect(migration).toContain('JOIN candidate_users cu ON cu.id = uc.user_id')
    expect(streamersCandidate).toBeGreaterThan(usersCandidate)
    expect(streamersCardCount).toBeGreaterThan(streamersCandidate)
    expect(migration).toContain('JOIN candidate_streamers cs ON cs.id = c.streamer_id')
    expect(migration).toContain('FROM summary_streamer_base sb')
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
  })
})
