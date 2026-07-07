import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { DataTable } from '../components/DataTable'
import { RarityBadge } from '../components/RarityBadge'
import { StreamerPopup } from '../components/StreamerPopup'
import { Rarity } from '../types/database'
import {
  adminApi,
  TimeRange,
  GachaSummary,
  GachaTableRow,
  StreamerWithStats,
} from '../lib/adminApi'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts'

/**
 * フィルタ状態の型
 * username: ILIKE部分一致、rarity: 完全一致、from/to: 日付範囲
 */
interface FilterState {
  username: string
  rarity: Rarity | ''
  from: string
  to: string
}

// Color mapping for rarity in charts
const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b',
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

/**
 * Gacha page - Displays gacha history, statistics, and analytics across all streamers
 * Includes time-series charts, rarity distribution, popular cards ranking, a streamer
 * filter, and a paginated/filterable history table (server-side, via /__admin/gacha/*)
 */
export function Gacha() {
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [chartError, setChartError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)

  // --- 全ストリーマー一覧（ストリーマーフィルタのドロップダウン用、マウント時に一度だけ取得） ---
  const [streamers, setStreamers] = useState<StreamerWithStats[]>([])
  const [selectedStreamerId, setSelectedStreamerId] = useState('')

  // --- チャート/統計用集計データ（/__admin/gacha/summary でDB側GROUP BY済み） ---
  const [summary, setSummary] = useState<GachaSummary>({
    totalGacha: 0,
    uniqueUsers: 0,
    legendaryCount: 0,
    dailyGachaData: [],
    rarityDistribution: [],
    popularCards: [],
  })
  const [chartLoading, setChartLoading] = useState(true)

  // --- テーブル用データ（サーバーサイドページネーション + フィルタ） ---
  const [tableData, setTableData] = useState<GachaTableRow[]>([])
  const [tableLoading, setTableLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // --- フィルタ state ---
  const [filters, setFilters] = useState<FilterState>({ username: '', rarity: '', from: '', to: '' })
  // デバウンス用: 入力中のユーザー名
  const [usernameInput, setUsernameInput] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ========================================
  // fetchStreamers: ストリーマーフィルタ用の一覧取得（マウント時に一度だけ）
  // ========================================
  useEffect(() => {
    ;(async () => {
      try {
        const data = await adminApi.getStreamers()
        setStreamers(data)
      } catch (err) {
        // ドロップダウンが空のままになるだけなので致命的ではない
        console.error('Failed to fetch streamers:', err)
      }
    })()
  }, [])

  // ========================================
  // fetchSummary: チャート/統計用集計データ取得（timeRange/selectedStreamerId変更時）
  // ========================================
  useEffect(() => {
    const fetchSummary = async () => {
      setChartLoading(true)
      setChartError(null)
      try {
        const data = await adminApi.getGachaSummary({
          range: timeRange,
          streamerId: selectedStreamerId || undefined,
        })
        setSummary(data)
      } catch (err) {
        setChartError(`Chart data error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        setChartLoading(false)
      }
    }

    fetchSummary()
  }, [timeRange, selectedStreamerId])

  // ========================================
  // fetchTableData: テーブル用データ取得（ページ/フィルタ/timeRange/selectedStreamerId変更時）
  // ========================================
  const fetchTableData = useCallback(async () => {
    setTableLoading(true)
    setTableError(null)
    try {
      const { rows, count } = await adminApi.getGachaTable({
        range: timeRange,
        page: currentPage,
        pageSize,
        username: filters.username,
        rarity: filters.rarity,
        from: filters.from,
        to: filters.to,
        streamerId: selectedStreamerId || undefined,
      })
      setTableData(rows)
      setTotalCount(count)
    } catch (err) {
      setTableError(`Table data error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setTableLoading(false)
    }
  }, [timeRange, currentPage, pageSize, filters, selectedStreamerId])

  useEffect(() => {
    fetchTableData()
  }, [fetchTableData])

  const resetFilters = useCallback(() => {
    // デバウンスタイマーが残存していると古い入力値が再適用されるためキャンセル
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setFilters({ username: '', rarity: '', from: '', to: '' })
    setUsernameInput('')
    setSelectedStreamerId('')
    setCurrentPage(1)
  }, [])

  // アンマウント時にデバウンスタイマーをクリーンアップ
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // ユーザー名入力の300msデバウンス
  const handleUsernameChange = useCallback((value: string) => {
    setUsernameInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, username: value }))
      setCurrentPage(1)
    }, 300)
  }, [])

  // timeRange変更時にページを1に戻す
  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range)
    setCurrentPage(1)
  }, [])

  // ストリーマーフィルタ変更時にページを1に戻す
  const handleStreamerChange = useCallback((streamerId: string) => {
    setSelectedStreamerId(streamerId)
    setCurrentPage(1)
  }, [])

  // ストリーマーフィルタ用ドロップダウンの選択肢（カード数の多い順）
  const sortedStreamers = useMemo(
    () => [...streamers].sort((a, b) => b.card_count - a.card_count),
    [streamers]
  )

  // Table column definitions
  const columns = [
    {
      key: 'redeemed_at',
      header: 'Date',
      render: (gacha: GachaTableRow) => (
        <span className="text-gray-600 text-sm">
          {new Date(gacha.redeemed_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (gacha: GachaTableRow) => (
        <span className="font-medium">{gacha.user_twitch_username || 'Unknown'}</span>
      ),
    },
    {
      key: 'card',
      header: 'Card',
      render: (gacha: GachaTableRow) => (
        <div className="flex items-center space-x-2">
          {gacha.cards?.image_url && (
            <img
              src={gacha.cards.image_url}
              alt={gacha.cards.name}
              className="w-8 h-8 rounded object-cover"
            />
          )}
          <span>{gacha.cards?.name || 'Unknown'}</span>
        </div>
      ),
    },
    {
      key: 'rarity',
      header: 'Rarity',
      render: (gacha: GachaTableRow) =>
        gacha.cards?.rarity ? <RarityBadge rarity={gacha.cards.rarity} /> : '-',
    },
    {
      key: 'streamer',
      header: 'Streamer',
      render: (gacha: GachaTableRow) => (
        <StreamerPopup streamer={gacha.streamers}>
          <span className="text-gray-600 hover:text-purple-600">
            {gacha.streamers?.twitch_display_name || 'Unknown'}
          </span>
        </StreamerPopup>
      ),
    },
  ]

  // Calculate summary statistics (DB集計済みデータ)
  const totalGacha = summary.totalGacha
  const uniqueUsers = summary.uniqueUsers
  const legendaryCount = summary.legendaryCount
  const legendaryRate = totalGacha > 0 ? ((legendaryCount / totalGacha) * 100).toFixed(2) : '0'

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Gacha</h1>
          <p className="text-gray-500 mt-1">Gacha history and statistics</p>
        </div>
        {/* Time Range Selector */}
        <div className="flex space-x-2">
          {(['7d', '30d', '90d', 'all'] as const).map((range) => (
            <button
              key={range}
              onClick={() => handleTimeRangeChange(range)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                timeRange === range
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {range === '7d' ? '7 Days' : range === '30d' ? '30 Days' : range === '90d' ? '90 Days' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Error Display */}
      {(chartError || tableError) && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 font-medium">Error loading data</p>
          {chartError && <p className="text-red-600 text-sm mt-1">{chartError}</p>}
          {tableError && <p className="text-red-600 text-sm mt-1">{tableError}</p>}
          <p className="text-red-500 text-xs mt-2">
            Check browser console for details.
          </p>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Gacha</p>
          <p className="text-2xl font-bold">{totalGacha.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Unique Users</p>
          <p className="text-2xl font-bold">{uniqueUsers.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Legendary Pulls</p>
          <p className="text-2xl font-bold text-amber-600">{legendaryCount.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Legendary Rate</p>
          <p className="text-2xl font-bold">{legendaryRate}%</p>
        </div>
      </div>
      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily Gacha Line Chart */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Gacha Count</h2>
          {chartLoading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : summary.dailyGachaData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <LineChart data={summary.dailyGachaData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: '#3b82f6' }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Rarity Distribution Pie Chart */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Rarity Distribution</h2>
          {chartLoading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : summary.rarityDistribution.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <PieChart>
                <Pie
                  data={summary.rarityDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {summary.rarityDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={RARITY_COLORS[entry.rarity]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Popular Cards Ranking */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Popular Cards (Top 10)</h2>
        {chartLoading ? (
          <div className="h-64 bg-gray-100 animate-pulse rounded" />
        ) : summary.popularCards.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-gray-500">
            No data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={summary.popularCards}
              layout="vertical"
              margin={{ left: 100 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis
                type="category"
                dataKey="card.name"
                tick={{ fontSize: 12 }}
                width={100}
              />
              <Tooltip
                formatter={(value: number) => [value, 'Count']}
                labelFormatter={(label) => `Card: ${label}`}
              />
              <Bar
                dataKey="count"
                fill="#3b82f6"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Gacha History Table */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Gacha History</h2>
          <button
            onClick={() =>
              (window.location.href = adminApi.getGachaExportUrl({
                range: timeRange,
                username: filters.username,
                rarity: filters.rarity,
                from: filters.from,
                to: filters.to,
                streamerId: selectedStreamerId || undefined,
              }))
            }
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
          >
            Export CSV
          </button>
        </div>

        {/* Filter Panel */}
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* Streamer Filter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Streamer</label>
              <select
                value={selectedStreamerId}
                onChange={(e) => handleStreamerChange(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Streamers</option>
                {sortedStreamers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.twitch_display_name}
                  </option>
                ))}
              </select>
            </div>

            {/* Username Filter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Username</label>
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder="Partial match"
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-40"
              />
            </div>

            {/* Rarity Filter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Rarity</label>
              <select
                value={filters.rarity}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, rarity: e.target.value as Rarity | '' }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All</option>
                <option value="legendary">Legendary</option>
                <option value="epic">Epic</option>
                <option value="rare">Rare</option>
                <option value="common">Common</option>
              </select>
            </div>

            {/* From Date Filter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">From</label>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, from: e.target.value }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* To Date Filter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">To</label>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, to: e.target.value }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Reset Button */}
            <button
              onClick={resetFilters}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-100 transition-colors"
            >
              Reset
            </button>
          </div>
          {/* 日付フィルタ使用時、上部の期間タブがテーブルに適用されないことを注記 */}
          {(filters.from || filters.to) && (
            <p className="text-xs text-gray-400 mt-2">
              When From/To dates are set, the time range buttons above no longer apply to the table
              (charts and summary stats still follow the time range buttons).
            </p>
          )}
        </div>

        {/* Table (server-side pagination) */}
        <DataTable
          columns={columns}
          data={tableData}
          keyExtractor={(gacha) => gacha.id}
          loading={tableLoading}
          emptyMessage="No gacha history"
          pagination={{
            currentPage,
            pageSize,
            totalItems: totalCount,
            onPageChange: setCurrentPage,
            onPageSizeChange: (size) => {
              setPageSize(size)
              setCurrentPage(1)
            },
            pageSizeOptions: PAGE_SIZE_OPTIONS,
          }}
        />
      </div>
    </div>
  )
}
