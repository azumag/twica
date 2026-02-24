import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { RarityBadge } from '../components/RarityBadge'
import { StreamerPopup } from '../components/StreamerPopup'
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

// Type for gacha history with joined card and streamer data
interface GachaWithDetails extends GachaHistory {
  cards: Card
  streamers: Streamer
}

// Color mapping for rarity in charts
const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b',
}

/**
 * Gacha page - Displays gacha history, statistics, and analytics
 * Includes time-series charts, rarity distribution, and popular cards ranking
 */
export function Gacha() {
  const [gachaHistory, setGachaHistory] = useState<GachaWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d' | 'all'>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchGachaHistory()
  }, [timeRange])

  /**
   * Fetches gacha history with card and streamer details
   */
  async function fetchGachaHistory() {
    setLoading(true)
    setError(null)
    try {
      // Build query based on time range
      let query = supabase
        .from('gacha_history')
        .select('*, cards(*), streamers(*)')
        .order('redeemed_at', { ascending: false })

      // Apply date filter if not 'all'
      if (timeRange !== 'all') {
        const now = new Date()
        const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
        const startDate = new Date(now.getTime() - daysMap[timeRange] * 24 * 60 * 60 * 1000).toISOString()
        query = query.gte('redeemed_at', startDate)
      }

      const { data, error: queryError } = await query

      if (queryError) {
        // Display detailed error information for debugging
        setError(`Query Error: ${queryError.message} (Code: ${queryError.code})`)
        console.error('Supabase query error:', queryError)
        return
      }

      console.log('Gacha history fetched:', data?.length || 0, 'records')
      setGachaHistory((data as unknown as GachaWithDetails[]) || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(`Fetch Error: ${errorMessage}`)
      console.error('Error fetching gacha history:', err)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Calculates daily gacha counts for the line chart
   */
  const dailyGachaData = useMemo(() => {
    const dailyCounts = new Map<string, number>()

    gachaHistory.forEach((gacha) => {
      const date = new Date(gacha.redeemed_at).toLocaleDateString('ja-JP')
      dailyCounts.set(date, (dailyCounts.get(date) || 0) + 1)
    })

    // Convert to array sorted by date
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
   * Calculates rarity distribution for the pie chart
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

    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([rarity, count]) => ({
        name: rarity.charAt(0).toUpperCase() + rarity.slice(1),
        value: count,
        rarity: rarity as Rarity,
      }))
  }, [gachaHistory])

  /**
   * Calculates popular cards ranking
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

  // Table column definitions
  const columns = [
    {
      key: 'redeemed_at',
      header: 'Date',
      render: (gacha: GachaWithDetails) => (
        <span className="text-gray-600 text-sm">
          {new Date(gacha.redeemed_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (gacha: GachaWithDetails) => (
        <span className="font-medium">{gacha.user_twitch_username || 'Unknown'}</span>
      ),
    },
    {
      key: 'card',
      header: 'Card',
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
      header: 'Rarity',
      render: (gacha: GachaWithDetails) =>
        gacha.cards?.rarity ? <RarityBadge rarity={gacha.cards.rarity} /> : '-',
    },
    {
      key: 'streamer',
      header: 'Streamer',
      render: (gacha: GachaWithDetails) => (
        <StreamerPopup streamer={gacha.streamers}>
          <span className="text-gray-600 hover:text-purple-600">
            {gacha.streamers?.twitch_display_name || 'Unknown'}
          </span>
        </StreamerPopup>
      ),
    },
  ]

  // Calculate summary statistics
  const totalGacha = gachaHistory.length
  const uniqueUsers = new Set(gachaHistory.map((g) => g.user_twitch_id)).size
  const legendaryCount = gachaHistory.filter((g) => g.cards?.rarity === 'legendary').length
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
              onClick={() => setTimeRange(range)}
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
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 font-medium">Error loading data</p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
          <p className="text-red-500 text-xs mt-2">
            Check browser console for details. Verify that RLS policies allow SELECT for anon key.
          </p>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Gacha</p>
          <p className="text-2xl font-bold">{totalGacha}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Unique Users</p>
          <p className="text-2xl font-bold">{uniqueUsers}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Legendary Pulls</p>
          <p className="text-2xl font-bold text-amber-600">{legendaryCount}</p>
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
          {loading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : dailyGachaData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
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

        {/* Rarity Distribution Pie Chart */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Rarity Distribution</h2>
          {loading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : rarityDistribution.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
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

      {/* Popular Cards Ranking */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Popular Cards (Top 10)</h2>
        {loading ? (
          <div className="h-64 bg-gray-100 animate-pulse rounded" />
        ) : popularCards.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-gray-500">
            No data available
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
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Gacha History</h2>
        <DataTable
          columns={columns}
          data={gachaHistory.slice(0, 50)}
          keyExtractor={(gacha) => gacha.id}
          loading={loading}
          emptyMessage="No gacha history"
        />
        {gachaHistory.length > 50 && (
          <p className="text-center text-gray-500 mt-4 text-sm">
            Showing 50 of {gachaHistory.length} records
          </p>
        )}
      </div>
    </div>
  )
}
