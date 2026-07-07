import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  adminApi,
  DropRateStatsResponse,
  TimeRange,
  GachaChartRow,
  GachaChartCard,
  GachaTableRow,
} from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
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
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [chartError, setChartError] = useState<string | null>(null)
  const [tableError, setTableError] = useState<string | null>(null)

  // --- チャート用データ（bounded 10000件、timeRange で再取得。/__admin/gacha/chart 経由） ---
  const [chartData, setChartData] = useState<GachaChartRow[]>([])
  const [chartLoading, setChartLoading] = useState(true)

  // --- サマリー統計用データ（get_gacha_drop_stats RPC、正確な集計） ---
  // <DropRateStats> も内部で同じRPCを呼ぶが、props経由で状態を共有せず
  // あえて独立に取得する（疎結合を優先。DB側は軽量なインデックス集計のため許容）
  const [dropRateStats, setDropRateStats] = useState<DropRateStatsResponse | null>(null)
  const [dropRateStatsLoading, setDropRateStatsLoading] = useState(true)
  const [dropRateStatsError, setDropRateStatsError] = useState<string | null>(null)

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
    ;(async () => {
      const { data, error: err } = await supabase
        .from('streamers')
        .select('*')
        .eq('id', streamerId)
        .single()
      if (err) {
        setChartError(`Streamer not found: ${err.message}`)
        return
      }
      setStreamer(data as Streamer)
    })()
  }, [streamerId])

  // ========================================
  // fetchChartData: チャート用bounded(10000件)データ取得（streamerId/timeRange変更時）
  // /__admin/gacha/chart 経由（anon keyではRLSによりgacha_historyを直接読めないため）
  // ========================================
  useEffect(() => {
    if (!streamerId) return
    // timeRangeの素早い切替時に古いレスポンスが後から返って新しい表示を
    // 上書きしないよう、クリーンアップでcancelledを立てる
    let cancelled = false

    const fetchChartData = async () => {
      setChartLoading(true)
      setChartError(null)
      try {
        const data = await adminApi.getGachaChart({ range: timeRange, streamerId })
        if (cancelled) return
        setChartData(data)
      } catch (err) {
        if (cancelled) return
        setChartError(`Chart data error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        if (!cancelled) setChartLoading(false)
      }
    }

    fetchChartData()
    return () => {
      cancelled = true
    }
  }, [streamerId, timeRange])

  // ========================================
  // fetchDropRateStats: サマリー統計用の正確な集計取得（streamerId/timeRange変更時）
  // get_gacha_drop_stats RPC（10000件キャップなし、DB側で正確なCOUNT/GROUP BY）から
  // totalGacha/legendaryCount/legendaryRate を導出する。<DropRateStats> とは独立に取得。
  // ========================================
  useEffect(() => {
    if (!streamerId) return
    let cancelled = false

    const fetchDropRateStats = async () => {
      setDropRateStatsLoading(true)
      setDropRateStatsError(null)
      try {
        const data = await adminApi.getDropRateStats({ streamerId, range: timeRange })
        if (!cancelled) setDropRateStats(data)
      } catch (err) {
        if (!cancelled) {
          setDropRateStatsError(err instanceof Error ? err.message : 'Unknown error')
        }
      } finally {
        if (!cancelled) setDropRateStatsLoading(false)
      }
    }

    fetchDropRateStats()
    return () => {
      cancelled = true
    }
  }, [streamerId, timeRange])

  // ========================================
  // fetchTableData: テーブル用データ取得（ページ/フィルタ/timeRange変更時）
  // /__admin/gacha/table 経由（サーバーサイドページネーション + フィルタ、count: 'exact'相当）
  // ========================================
  useEffect(() => {
    if (!streamerId) return
    let cancelled = false

    const fetchTableData = async () => {
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
          streamerId,
        })
        if (cancelled) return
        setTableData(rows)
        setTotalCount(count)
      } catch (err) {
        if (cancelled) return
        setTableError(`Table data error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        if (!cancelled) setTableLoading(false)
      }
    }

    fetchTableData()
    return () => {
      cancelled = true
    }
  }, [streamerId, timeRange, currentPage, pageSize, filters])

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

  // ========================================
  // チャート用の集計データ（useMemo）
  // ========================================

  /** 日別ガチャ数を集計（折れ線チャート用） */
  const dailyGachaData = useMemo(() => {
    // ISO日付文字列（YYYY-MM-DD）をキーに集計し、ロケール依存のパース問題を回避
    const dailyCounts = new Map<string, number>()
    chartData.forEach((gacha) => {
      const isoDate = gacha.redeemed_at.slice(0, 10) // "2024-01-05"
      dailyCounts.set(isoDate, (dailyCounts.get(isoDate) || 0) + 1)
    })
    return Array.from(dailyCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([isoDate, count]) => ({
        date: new Date(isoDate).toLocaleDateString('ja-JP'),
        count,
      }))
  }, [chartData])

  /** レアリティ分布を集計（円チャート用） */
  const rarityDistribution = useMemo(() => {
    const counts: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 }
    chartData.forEach((gacha) => {
      if (gacha.cards?.rarity) counts[gacha.cards.rarity]++
    })
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([rarity, count]) => ({
        name: rarity.charAt(0).toUpperCase() + rarity.slice(1),
        value: count,
        rarity: rarity as Rarity,
      }))
  }, [chartData])

  /** 人気カードランキング（TOP10） */
  const popularCards = useMemo(() => {
    const cardCounts = new Map<string, { card: GachaChartCard; count: number }>()
    chartData.forEach((gacha) => {
      if (gacha.cards) {
        const existing = cardCounts.get(gacha.cards.id)
        if (existing) existing.count++
        else cardCounts.set(gacha.cards.id, { card: gacha.cards, count: 1 })
      }
    })
    return Array.from(cardCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [chartData])

  // サマリー統計（get_gacha_drop_stats RPCの正確な集計から算出。10000件キャップなし）
  const totalGacha = dropRateStats?.total_draws ?? 0
  const legendaryCount = dropRateStats?.rarity_stats.find((r) => r.rarity === 'legendary')?.count ?? 0
  const legendaryRate = totalGacha > 0 ? ((legendaryCount / totalGacha) * 100).toFixed(2) : '0'
  // uniqueUsers はRPCに対応フィールドがないため、引き続きチャートデータ（10000件上限）から近似算出
  const uniqueUsers = new Set(chartData.map((g) => g.user_twitch_id)).size

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

      {/* エラー表示 */}
      {(chartError || tableError || dropRateStatsError) && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 font-medium">データの読み込みエラー</p>
          {chartError && <p className="text-red-600 text-sm mt-1">{chartError}</p>}
          {tableError && <p className="text-red-600 text-sm mt-1">{tableError}</p>}
          {dropRateStatsError && <p className="text-red-600 text-sm mt-1">Summary stats error: {dropRateStatsError}</p>}
          <p className="text-red-500 text-xs mt-2">
            詳細はブラウザコンソールを確認してください。
          </p>
        </div>
      )}

      {/* サマリー統計カード */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総ガチャ数</p>
          {dropRateStatsLoading ? (
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
          {/* uniqueUsers に対応する正確な集計RPCがないため、引き続きチャートの10000件上限からの近似値 */}
          {chartData.length >= 10000 && (
            <p className="text-xs text-amber-600 mt-1">※ 直近10,000件からの概算です</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー獲得数</p>
          {dropRateStatsLoading ? (
            <div className="h-7 w-16 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold text-amber-600">{legendaryCount.toLocaleString()}</p>
          )}
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー率</p>
          {dropRateStatsLoading ? (
            <div className="h-7 w-14 bg-gray-100 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold">{legendaryRate}%</p>
          )}
        </div>
      </div>
      {/* チャート（日別推移・レアリティ分布・人気カード）は10000件上限のため、超過時は近似値であることを注記 */}
      {chartData.length >= 10000 && (
        <p className="text-xs text-amber-600">
          ※ 下記チャートは直近10,000件からの算出です。正確な総回数は下部の排出率統計を参照してください。
        </p>
      )}

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
