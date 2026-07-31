import { useEffect, useState, useCallback, useRef } from 'react'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { RarityBadge } from '../components/RarityBadge'
import { StreamerPopup } from '../components/StreamerPopup'
import { Rarity } from '../types/database'
import {
  adminApi,
  TimeRange,
  GachaSummary,
  GachaTableRow,
  StreamerOption,
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
  // 全期間は明示選択時だけ許可し、初回の集計・履歴取得は直近7日に限定する。
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [chartError, setChartError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更するとeffectを再実行させる）
  const [chartRetryToken, setChartRetryToken] = useState(0)
  const [tableRetryToken, setTableRetryToken] = useState(0)

  // --- ストリーマー選択肢（軽量・最大100件。検索で候補を絞り込む） ---
  const [streamers, setStreamers] = useState<StreamerOption[]>([])
  const [streamerSearchInput, setStreamerSearchInput] = useState('')
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
  // fetchStreamerOptions: ドロップダウン専用の軽量候補をbounded取得する。
  // StreamerWithStats全件を取得してから並べ替える旧経路を廃止し、検索時も
  // 100件以内の候補だけを保持する。
  // ========================================
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      ;(async () => {
        try {
          const { rows } = await adminApi.getStreamerOptions(
            { page: 1, pageSize: 100, search: streamerSearchInput },
            { signal: controller.signal }
          )
          setStreamers((previousRows) => {
            // 検索結果を置き換えるだけだと、100件目以降の配信者を検索して
            // 選択した後に検索文字を消した際、その選択肢が先頭100件から外れて
            // selectの表示が空になる。現在選択中の候補だけは軽量な1行として
            // 次の結果にも残し、選択状態とサーバー側の集計条件を一致させる。
            const selected = previousRows.find((row) => row.id === selectedStreamerId)
            if (selected && !rows.some((row) => row.id === selected.id)) {
              return [selected, ...rows]
            }
            return rows
          })
        } catch (err) {
          if (controller.signal.aborted) return
          // 候補だけの取得失敗は集計・履歴テーブルをブロックさせない。
          console.error('Failed to fetch streamer options:', err)
        }
      })()
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [streamerSearchInput, selectedStreamerId])

  // ========================================
  // fetchSummary: チャート/統計用集計データ取得（timeRange/selectedStreamerId変更時）
  // ========================================
  useEffect(() => {
    // フィルタ切替を素早く行うと後発リクエストより先発リクエストが遅れて返ることがあるため、
    // AbortControllerで先発リクエスト自体を中断する(単に古いレスポンスの反映を防ぐ
    // だけでなく、不要になったサーバー側の処理・帯域も実際に打ち切る)
    const controller = new AbortController()

    const fetchSummary = async () => {
      setChartLoading(true)
      setChartError(null)
      try {
        const data = await adminApi.getGachaSummary(
          {
            range: timeRange,
            streamerId: selectedStreamerId || undefined,
          },
          { signal: controller.signal }
        )
        setSummary(data)
      } catch (err) {
        // エラーの型ではなくsignal自体の状態で中断済みかどうかを判定する。
        // abort後もresponse.json()のパース中に中断が割り込む等の経路では
        // AbortError以外の形(AdminApiRequestError等)でrejectされうるため、
        // エラーの「形」を見るとstaleなエラー表示が漏れて残るケースがある
        if (controller.signal.aborted) return
        setChartError(`Chart data error: ${(err instanceof Error && err.message) || 'Unknown error'}`)
      } finally {
        if (!controller.signal.aborted) setChartLoading(false)
      }
    }

    fetchSummary()
    return () => controller.abort()
  }, [timeRange, selectedStreamerId, chartRetryToken])

  // ========================================
  // fetchTableData: テーブル用データ取得（ページ/フィルタ/timeRange/selectedStreamerId変更時）
  // ========================================
  useEffect(() => {
    const controller = new AbortController()

    const fetchTableData = async () => {
      setTableLoading(true)
      setTableError(null)
      try {
        const { rows, count } = await adminApi.getGachaTable(
          {
            range: timeRange,
            page: currentPage,
            pageSize,
            username: filters.username,
            rarity: filters.rarity,
            from: filters.from,
            to: filters.to,
            streamerId: selectedStreamerId || undefined,
          },
          { signal: controller.signal }
        )
        setTableData(rows)
        setTotalCount(count)
      } catch (err) {
        // fetchSummaryのcatch節と同じ理由でsignal.abortedを見る(エラーの型では判定しない)
        if (controller.signal.aborted) return
        setTableError(`Table data error: ${(err instanceof Error && err.message) || 'Unknown error'}`)
      } finally {
        if (!controller.signal.aborted) setTableLoading(false)
      }
    }

    fetchTableData()
    return () => controller.abort()
  }, [timeRange, currentPage, pageSize, filters, selectedStreamerId, tableRetryToken])

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
  // CSVエクスポート: window.location.href によるフルページ遷移だと、サーバーが
  // エラー(JSON/500)を返した場合にSPAの状態(フィルタ等)が失われた上にエラーも
  // 画面に表示されない。fetch + blobダウンロードに切り替え、失敗時はtableErrorに出す
  const handleExportCsv = useCallback(async () => {
    const url = adminApi.getGachaExportUrl({
      range: timeRange,
      username: filters.username,
      rarity: filters.rarity,
      from: filters.from,
      to: filters.to,
      streamerId: selectedStreamerId || undefined,
    })
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Export failed (status ${response.status})`)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = 'gacha-export.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (err) {
      setTableError(`Export error: ${(err instanceof Error && err.message) || 'Unknown error'}`)
    }
  }, [timeRange, filters, selectedStreamerId])

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

      <ErrorBanner
        messages={[chartError, tableError]}
        onRetry={() => {
          setChartRetryToken((t) => t + 1)
          setTableRetryToken((t) => t + 1)
        }}
      />

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Gacha</p>
          {chartLoading ? (
            <div className="h-7 w-20 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{totalGacha.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Unique Users</p>
          {chartLoading ? (
            <div className="h-7 w-20 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{uniqueUsers.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Legendary Pulls</p>
          {chartLoading ? (
            <div className="h-7 w-16 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold text-amber-600">{legendaryCount.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Legendary Rate</p>
          {chartLoading ? (
            <div className="h-7 w-14 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{legendaryRate}%</p>
          )}
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
            onClick={handleExportCsv}
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
              <input
                type="text"
                value={streamerSearchInput}
                onChange={(e) => setStreamerSearchInput(e.target.value)}
                placeholder="候補を検索..."
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-40 mb-1"
              />
              <select
                value={selectedStreamerId}
                onChange={(e) => handleStreamerChange(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Streamers</option>
                {streamers.map((s) => (
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
