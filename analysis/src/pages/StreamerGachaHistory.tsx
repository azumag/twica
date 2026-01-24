import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { RarityBadge } from '../components/RarityBadge'
import { GachaHistory, Card, Streamer, Rarity } from '../types/database'
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
 * ガチャ履歴に紐づくカード・ストリーマー情報を含む型
 */
interface GachaWithDetails extends GachaHistory {
  cards: Card
  streamers: Streamer
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
 * - ガチャ履歴一覧テーブル
 * - 期間フィルタリング（7日/30日/90日/全期間）
 */
export function StreamerGachaHistory() {
  const { streamerId } = useParams<{ streamerId: string }>()
  const navigate = useNavigate()
  const [streamer, setStreamer] = useState<Streamer | null>(null)
  const [gachaHistory, setGachaHistory] = useState<GachaWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d' | 'all'>('all')
  const [error, setError] = useState<string | null>(null)

  /**
   * streamerIdまたはtimeRangeが変更されたらデータを再取得
   */
  useEffect(() => {
    if (streamerId) {
      fetchStreamerAndGachaHistory()
    }
  }, [streamerId, timeRange])

  /**
   * ストリーマー情報とガチャ履歴を取得
   * ガチャ履歴はstreamer_idでフィルタリングして取得
   */
  async function fetchStreamerAndGachaHistory() {
    if (!streamerId) return

    setLoading(true)
    setError(null)

    try {
      // ストリーマー情報を取得
      const { data: streamerData, error: streamerError } = await supabase
        .from('streamers')
        .select('*')
        .eq('id', streamerId)
        .single()

      if (streamerError) {
        setError(`Streamer not found: ${streamerError.message}`)
        console.error('Streamer fetch error:', streamerError)
        return
      }

      setStreamer(streamerData as Streamer)

      // ガチャ履歴をストリーマーIDでフィルタリングして取得
      let query = supabase
        .from('gacha_history')
        .select('*, cards(*), streamers(*)')
        .eq('streamer_id', streamerId)
        .order('redeemed_at', { ascending: false })

      // 期間フィルタを適用（'all'以外の場合）
      if (timeRange !== 'all') {
        const now = new Date()
        const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
        const startDate = new Date(now.getTime() - daysMap[timeRange] * 24 * 60 * 60 * 1000).toISOString()
        query = query.gte('redeemed_at', startDate)
      }

      const { data: gachaData, error: gachaError } = await query

      if (gachaError) {
        setError(`Query Error: ${gachaError.message} (Code: ${gachaError.code})`)
        console.error('Gacha history fetch error:', gachaError)
        return
      }

      console.log('Gacha history fetched for streamer:', gachaData?.length || 0, 'records')
      setGachaHistory((gachaData as unknown as GachaWithDetails[]) || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(`Fetch Error: ${errorMessage}`)
      console.error('Error fetching data:', err)
    } finally {
      setLoading(false)
    }
  }

  /**
   * 日別ガチャ数を集計
   * 折れ線チャートのデータソースとして使用
   */
  const dailyGachaData = useMemo(() => {
    const dailyCounts = new Map<string, number>()

    gachaHistory.forEach((gacha) => {
      const date = new Date(gacha.redeemed_at).toLocaleDateString('ja-JP')
      dailyCounts.set(date, (dailyCounts.get(date) || 0) + 1)
    })

    // 日付順にソートして配列として返す
    const entries = Array.from(dailyCounts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => {
        const dateA = new Date(a.date.replace(/\//g, '-'))
        const dateB = new Date(b.date.replace(/\//g, '-'))
        return dateA.getTime() - dateB.getTime()
      })

    return entries
  }, [gachaHistory])

  /**
   * レアリティ分布を集計
   * 円チャートのデータソースとして使用
   */
  const rarityDistribution = useMemo(() => {
    const counts: Record<Rarity, number> = {
      common: 0,
      rare: 0,
      epic: 0,
      legendary: 0,
    }

    gachaHistory.forEach((gacha) => {
      if (gacha.cards?.rarity) {
        counts[gacha.cards.rarity]++
      }
    })

    // 0件のレアリティは除外して返す
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([rarity, count]) => ({
        name: rarity.charAt(0).toUpperCase() + rarity.slice(1),
        value: count,
        rarity: rarity as Rarity,
      }))
  }, [gachaHistory])

  /**
   * 人気カードランキングを集計
   * 出現回数が多い順にTOP10を返す
   */
  const popularCards = useMemo(() => {
    const cardCounts = new Map<string, { card: Card; count: number }>()

    gachaHistory.forEach((gacha) => {
      if (gacha.cards) {
        const existing = cardCounts.get(gacha.cards.id)
        if (existing) {
          existing.count++
        } else {
          cardCounts.set(gacha.cards.id, { card: gacha.cards, count: 1 })
        }
      }
    })

    return Array.from(cardCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [gachaHistory])

  /**
   * ガチャ履歴テーブルのカラム定義
   * 日時、ユーザー名、カード情報、レアリティを表示
   */
  const columns = [
    {
      key: 'redeemed_at',
      header: '日時',
      render: (gacha: GachaWithDetails) => (
        <span className="text-gray-600 text-sm">
          {new Date(gacha.redeemed_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'ユーザー',
      render: (gacha: GachaWithDetails) => (
        <span className="font-medium">{gacha.user_twitch_username || 'Unknown'}</span>
      ),
    },
    {
      key: 'card',
      header: 'カード',
      render: (gacha: GachaWithDetails) => (
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
      render: (gacha: GachaWithDetails) =>
        gacha.cards?.rarity ? <RarityBadge rarity={gacha.cards.rarity} /> : '-',
    },
  ]

  // サマリー統計を計算
  const totalGacha = gachaHistory.length
  const uniqueUsers = new Set(gachaHistory.map((g) => g.user_twitch_id)).size
  const legendaryCount = gachaHistory.filter((g) => g.cards?.rarity === 'legendary').length
  const legendaryRate = totalGacha > 0 ? ((legendaryCount / totalGacha) * 100).toFixed(2) : '0'

  return (
    <div className="space-y-6">
      {/* ページヘッダー：ストリーマー情報と期間フィルタ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          {/* 戻るボタン */}
          <button
            onClick={() => navigate(`/streamers/${streamerId}/cards`)}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="カード一覧に戻る"
          >
            <span className="text-gray-600">← 戻る</span>
          </button>
          {/* ストリーマー情報 */}
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
                  <span className="text-purple-600 text-lg">🎮</span>
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
              onClick={() => setTimeRange(range)}
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
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 font-medium">データの読み込みエラー</p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
          <p className="text-red-500 text-xs mt-2">
            詳細はブラウザコンソールを確認してください。
          </p>
        </div>
      )}

      {/* サマリー統計カード */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総ガチャ数</p>
          <p className="text-2xl font-bold">{totalGacha}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">ユニークユーザー</p>
          <p className="text-2xl font-bold">{uniqueUsers}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー獲得数</p>
          <p className="text-2xl font-bold text-amber-600">{legendaryCount}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">レジェンダリー率</p>
          <p className="text-2xl font-bold">{legendaryRate}%</p>
        </div>
      </div>

      {/* チャートセクション */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 日別ガチャ数 折れ線チャート */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">日別ガチャ数</h2>
          {loading ? (
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
          {loading ? (
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
        {loading ? (
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

      {/* ガチャ履歴テーブル */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">最近のガチャ履歴</h2>
        <DataTable
          columns={columns}
          data={gachaHistory.slice(0, 50)}
          keyExtractor={(gacha) => gacha.id}
          loading={loading}
          emptyMessage="ガチャ履歴がありません"
        />
        {gachaHistory.length > 50 && (
          <p className="text-center text-gray-500 mt-4 text-sm">
            {gachaHistory.length}件中 50件を表示
          </p>
        )}
      </div>
    </div>
  )
}
