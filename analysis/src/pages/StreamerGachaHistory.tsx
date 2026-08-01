import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  adminApi,
  GachaSummary,
  TimeRange,
  GachaTableRow,
} from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { RarityBadge } from '../components/RarityBadge'
import { DropRateStats } from '../components/DropRateStats'
import { Streamer, Rarity } from '../types/database'
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

/**
 * レアリティごとのチャート表示色
 * common: グレー、rare: 青、epic: 紫、legendary: 金
 */
const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b',
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

/**
 * StreamerGachaHistory - 特定ストリーマーのガチャ履歴ページ
 *
 * URLパラメータ（:streamerId）から該当ストリーマーを特定し、
 * そのストリーマーのカードに対するユーザーのガチャ履歴を表示
 *
 * 機能:
 * - 日別ガチャ数の折れ線チャート
 * - レアリティ分布の円チャート
 * - 人気カードランキング（TOP10）
 * - 排出率統計（設定率 vs 実際率）
 * - ガチャ履歴テーブル（サーバーサイドページネーション + フィルタ）
 * - 期間フィルタリング（7日/30日/90日/全期間）
 */
export function StreamerGachaHistory() {
  const { streamerId } = useParams<{ streamerId: string }>()
  const navigate = useNavigate()

  // --- 基本 state ---
  const [streamer, setStreamer] = useState<Streamer | null>(null)
  // 初回表示は直近7日。全期間はユーザーが明示的に選択したときだけ集計する。
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  // streamer本体のエラーはchartErrorに相乗りさせず専用のstateで持つ。
  // 相乗りさせるとtimeRange変更時のsetChartError(null)で「streamer取得は
  // 再試行されていないのに」エラー表示だけが消え、ヘッダーが黙って空のまま残る
  const [streamerError, setStreamerError] = useState<string | null>(null)
  const [chartError, setChartError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更すると対応するeffectを再実行させる）
  const [streamerRetryToken, setStreamerRetryToken] = useState(0)
  const [chartRetryToken, setChartRetryToken] = useState(0)
  const [tableRetryToken, setTableRetryToken] = useState(0)

  // --- チャート用集計（DB側GROUP BY済み。履歴行をクライアントへ持ち込まない） ---
  const [chartSummary, setChartSummary] = useState<GachaSummary>({
    totalGacha: 0,
    uniqueUsers: 0,
    legendaryCount: 0,
    dailyGachaData: [],
    rarityDistribution: [],
    popularCards: [],
  })
  const [chartLoading, setChartLoading] = useState(true)

  // --- テーブル用データ（ページネーション + フィルタ） ---
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
  // fetchStreamer: ストリーマー情報取得（streamerId変更時のみ）
  // ========================================
  useEffect(() => {
    if (!streamerId) return
    const controller = new AbortController()
    setStreamerError(null)
    ;(async () => {
      try {
        const data = await adminApi.getStreamer(streamerId, { signal: controller.signal })
        setStreamer(data)
      } catch (err) {
        if (controller.signal.aborted) return
        setStreamerError(
          (err instanceof Error && err.message) || 'ストリーマー情報の取得に失敗しました'
        )
      }
    })()
    return () => controller.abort()
  }, [streamerId, streamerRetryToken])

  // ========================================
  // fetchChartData: DB側で集計済みのチャート値を取得（streamerId/timeRange変更時）。
  // 大量の履歴行を取得してからブラウザで集計する経路を廃止し、日別・レアリティ・
  // 人気カード・ユニークユーザー数を1つの集計レスポンスで受け取る。
  // ========================================
  useEffect(() => {
    if (!streamerId) return
    // timeRangeの素早い切替時に後発リクエストと先発リクエストが競合しうるため、
    // AbortControllerで先発リクエスト自体を中断する
    const controller = new AbortController()

    const fetchChartData = async () => {
      setChartLoading(true)
      setChartError(null)
      try {
        const data = await adminApi.getGachaSummary(
          { range: timeRange, streamerId },
          { signal: controller.signal }
        )
        setChartSummary(data)
      } catch (err) {
        if (controller.signal.aborted) return
        setChartError(`Chart data error: ${(err instanceof Error && err.message) || 'Unknown error'}`)
      } finally {
        if (!controller.signal.aborted) setChartLoading(false)
      }
    }

    fetchChartData()
    return () => controller.abort()
  }, [streamerId, timeRange, chartRetryToken])

  // ========================================
  // fetchTableData: テーブル用データ取得（ページ/フィルタ/timeRange変更時）
  // /__admin/gacha/table 経由（サーバーサイドページネーション + フィルタ、count: 'exact'相当）
  // ========================================
  useEffect(() => {
    if (!streamerId) return
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
            streamerId,
          },
          { signal: controller.signal }
        )
        setTableData(rows)
        setTotalCount(count)
      } catch (err) {
        if (controller.signal.aborted) return
        setTableError(`Table data error: ${(err instanceof Error && err.message) || 'Unknown error'}`)
      } finally {
        if (!controller.signal.aborted) setTableLoading(false)
      }
    }

    fetchTableData()
    return () => controller.abort()
  }, [streamerId, timeRange, currentPage, pageSize, filters, tableRetryToken])

  const resetFilters = useCallback(() => {
    // デバウンスタイマーが残存していると古い入力値が再適用されるためキャンセル
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setFilters({ username: '', rarity: '', from: '', to: '' })
    setUsernameInput('')
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
      setFilters(prev => ({ ...prev, username: value }))
      setCurrentPage(1)
    }, 300)
  }, [])

  // timeRange変更時にページを1に戻す
  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range)
    setCurrentPage(1)
  }, [])

  // サマリーはDBのCOUNT/GROUP BY結果をそのまま表示する。履歴全件をブラウザで
  // Set/Map集計しないため、7日を超えるデータ量に初回表示が比例しない。
  const totalGacha = chartSummary.totalGacha
  const uniqueUsers = chartSummary.uniqueUsers
  const legendaryCount = chartSummary.legendaryCount
  const legendaryRate = totalGacha > 0 ? ((legendaryCount / totalGacha) * 100).toFixed(2) : '0'
  const dailyGachaData = chartSummary.dailyGachaData
  const rarityDistribution = chartSummary.rarityDistribution
  const popularCards = chartSummary.popularCards

  /** ガチャ履歴テーブルのカラム定義 */
  const columns = [
    {
      key: 'redeemed_at',
      header: '日時',
      render: (gacha: GachaTableRow) => (
        <span className="text-gray-600 text-sm">
          {new Date(gacha.redeemed_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'ユーザー',
      render: (gacha: GachaTableRow) => (
        <span className="font-medium">{gacha.user_twitch_username || 'Unknown'}</span>
      ),
    },
    {
      key: 'card',
      header: 'カード',
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
      header: 'レアリティ',
      render: (gacha: GachaTableRow) =>
        gacha.cards?.rarity ? <RarityBadge rarity={gacha.cards.rarity} /> : '-',
    },
  ]

  return (
    <div className="space-y-6">
      {/* ページヘッダー：ストリーマー情報と期間フィルタ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate(`/streamers/${streamerId}/cards`)}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="カード一覧に戻る"
          >
            <span className="text-gray-600">&larr; 戻る</span>
          </button>
          {streamer && (
            <div className="flex items-center space-x-3">
              {streamer.twitch_profile_image_url ? (
                <img
                  src={streamer.twitch_profile_image_url}
                  alt={streamer.twitch_display_name}
                  className="w-12 h-12 rounded-full"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
                  <span className="text-purple-600 text-lg">?</span>
                </div>
              )}
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {streamer.twitch_display_name} のガチャ履歴
                </h1>
                <p className="text-gray-500">@{streamer.twitch_username}</p>
              </div>
            </div>
          )}
        </div>
        {/* 期間フィルタボタン */}
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
              {range === '7d' ? '7日' : range === '30d' ? '30日' : range === '90d' ? '90日' : '全期間'}
            </button>
          ))}
        </div>
      </div>

      <ErrorBanner
        messages={[
          streamerError,
          chartError,
          tableError,
        ]}
        onRetry={() => {
          setStreamerRetryToken((t) => t + 1)
          setChartRetryToken((t) => t + 1)
          setTableRetryToken((t) => t + 1)
        }}
      />

      {/* サマリー統計カード */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総ガチャ数</p>
          {chartLoading ? (
            <div className="h-7 w-20 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{totalGacha.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">ユニークユーザー</p>
          {chartLoading ? (
            <div className="h-7 w-20 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{uniqueUsers.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー獲得数</p>
          {chartLoading ? (
            <div className="h-7 w-16 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold text-amber-600">{legendaryCount.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー率</p>
          {chartLoading ? (
            <div className="h-7 w-14 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{legendaryRate}%</p>
          )}
        </div>
      </div>
      {/* チャートセクション */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 日別ガチャ数 折れ線チャート */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">日別ガチャ数</h2>
          {chartLoading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : dailyGachaData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              データがありません
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <LineChart data={dailyGachaData}>
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

        {/* レアリティ分布 円チャート */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">レアリティ分布</h2>
          {chartLoading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : rarityDistribution.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              データがありません
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <PieChart>
                <Pie
                  data={rarityDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {rarityDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={RARITY_COLORS[entry.rarity]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 人気カードランキング 棒グラフ */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">人気カード (TOP 10)</h2>
        {chartLoading ? (
          <div className="h-64 bg-gray-100 animate-pulse rounded" />
        ) : popularCards.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-gray-500">
            データがありません
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={popularCards}
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
                formatter={(value: number) => [value, '回数']}
                labelFormatter={(label) => `カード: ${label}`}
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

      {/* 排出率統計セクション */}
      {streamerId && <DropRateStats streamerId={streamerId} timeRange={timeRange} />}

      {/* フィルタパネル + ガチャ履歴テーブル */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">ガチャ履歴</h2>

        {/* フィルタパネル */}
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* ユーザー名フィルタ */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">ユーザー名</label>
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder="部分一致検索"
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-40"
              />
            </div>

            {/* レアリティフィルタ */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">レアリティ</label>
              <select
                value={filters.rarity}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, rarity: e.target.value as Rarity | '' }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">すべて</option>
                <option value="legendary">Legendary</option>
                <option value="epic">Epic</option>
                <option value="rare">Rare</option>
                <option value="common">Common</option>
              </select>
            </div>

            {/* 開始日フィルタ */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">開始日</label>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, from: e.target.value }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* 終了日フィルタ */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">終了日</label>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, to: e.target.value }))
                  setCurrentPage(1)
                }}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* リセットボタン */}
            <button
              onClick={resetFilters}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-100 transition-colors"
            >
              リセット
            </button>
          </div>
          {/* 日付フィルタ使用時、上部の期間タブがテーブルに適用されないことを注記 */}
          {(filters.from || filters.to) && (
            <p className="text-xs text-gray-400 mt-2">
              ※ 開始日・終了日を指定すると、上部の期間ボタンはテーブルに適用されません（チャート・統計は期間ボタンに従います）
            </p>
          )}
        </div>

        {/* テーブル（サーバーサイドページネーション） */}
        <DataTable
          columns={columns}
          data={tableData}
          keyExtractor={(gacha) => gacha.id}
          loading={tableLoading}
          emptyMessage="ガチャ履歴がありません"
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
