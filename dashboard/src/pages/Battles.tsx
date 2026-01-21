import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { Battle, BattleStats, User, BattleResult } from '../types/database'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts'

// Colors for battle result visualization
const RESULT_COLORS: Record<BattleResult, string> = {
  win: '#22c55e',
  lose: '#ef4444',
  draw: '#9ca3af',
}

/**
 * Battles page - Displays battle history, statistics, and analytics
 * Includes win rate distribution, turn count analysis, and user rankings
 */
export function Battles() {
  const [battles, setBattles] = useState<Battle[]>([])
  const [battleStats, setBattleStats] = useState<(BattleStats & { users?: User })[]>([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d'>('30d')

  useEffect(() => {
    fetchBattleData()
  }, [timeRange])

  /**
   * Fetches battle history and statistics
   */
  async function fetchBattleData() {
    setLoading(true)
    try {
      // Calculate date boundary based on selected time range
      const now = new Date()
      const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
      const startDate = new Date(now.getTime() - daysMap[timeRange] * 24 * 60 * 60 * 1000).toISOString()

      const [battlesResult, statsResult, usersResult] = await Promise.all([
        supabase
          .from('battles')
          .select('*')
          .gte('created_at', startDate)
          .order('created_at', { ascending: false }),
        supabase
          .from('battle_stats')
          .select('*')
          .order('win_rate', { ascending: false }),
        supabase
          .from('users')
          .select('id, twitch_username, twitch_display_name, twitch_profile_image_url'),
      ])

      if (battlesResult.error) throw battlesResult.error

      // Type assertions for query results
      const battlesData = (battlesResult.data || []) as Battle[]
      const statsData = (statsResult.data || []) as BattleStats[]
      const usersData = (usersResult.data || []) as Pick<User, 'id' | 'twitch_username' | 'twitch_display_name' | 'twitch_profile_image_url'>[]

      setBattles(battlesData)

      // Combine battle stats with user information
      const userMap = new Map<string, User>()
      usersData.forEach((user) => {
        userMap.set(user.id, user as User)
      })

      const statsWithUsers = statsData.map((stat) => ({
        ...stat,
        users: userMap.get(stat.user_id),
      }))

      setBattleStats(statsWithUsers)
    } catch (error) {
      console.error('Error fetching battle data:', error)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Calculates daily battle counts for the line chart
   */
  const dailyBattleData = useMemo(() => {
    const dailyCounts = new Map<string, { total: number; wins: number; losses: number; draws: number }>()

    battles.forEach((battle) => {
      const date = new Date(battle.created_at).toLocaleDateString('ja-JP')
      const existing = dailyCounts.get(date) || { total: 0, wins: 0, losses: 0, draws: 0 }
      existing.total++
      if (battle.result === 'win') existing.wins++
      else if (battle.result === 'lose') existing.losses++
      else existing.draws++
      dailyCounts.set(date, existing)
    })

    return Array.from(dailyCounts.entries())
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => {
        const dateA = new Date(a.date.replace(/\//g, '-'))
        const dateB = new Date(b.date.replace(/\//g, '-'))
        return dateA.getTime() - dateB.getTime()
      })
  }, [battles])

  /**
   * Calculates result distribution for the pie chart
   */
  const resultDistribution = useMemo(() => {
    const counts: Record<BattleResult, number> = { win: 0, lose: 0, draw: 0 }

    battles.forEach((battle) => {
      counts[battle.result]++
    })

    return [
      { name: 'Wins', value: counts.win, result: 'win' as BattleResult },
      { name: 'Losses', value: counts.lose, result: 'lose' as BattleResult },
      { name: 'Draws', value: counts.draw, result: 'draw' as BattleResult },
    ].filter((entry) => entry.value > 0)
  }, [battles])

  /**
   * Calculates turn count distribution for histogram
   */
  const turnCountDistribution = useMemo(() => {
    const counts = new Map<number, number>()

    battles.forEach((battle) => {
      // Group turn counts into buckets: 1-5, 6-10, 11-15, 16-20, 21+
      const bucket = Math.min(Math.ceil(battle.turn_count / 5) * 5, 25)
      counts.set(bucket, (counts.get(bucket) || 0) + 1)
    })

    return [5, 10, 15, 20, 25].map((bucket) => ({
      range: bucket === 25 ? '21+' : `${bucket - 4}-${bucket}`,
      count: counts.get(bucket) || 0,
    }))
  }, [battles])

  // Table column definitions for battle history
  const battleColumns = [
    {
      key: 'created_at',
      header: 'Date',
      render: (battle: Battle) => (
        <span className="text-gray-600 text-sm">
          {new Date(battle.created_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Result',
      render: (battle: Battle) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            battle.result === 'win'
              ? 'bg-green-100 text-green-800'
              : battle.result === 'lose'
              ? 'bg-red-100 text-red-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {battle.result === 'win' ? 'Victory' : battle.result === 'lose' ? 'Defeat' : 'Draw'}
        </span>
      ),
    },
    {
      key: 'turn_count',
      header: 'Turns',
      render: (battle: Battle) => (
        <span className="font-medium">{battle.turn_count}</span>
      ),
    },
    {
      key: 'user_id',
      header: 'User ID',
      render: (battle: Battle) => (
        <span className="text-gray-500 text-xs font-mono">{battle.user_id.slice(0, 8)}...</span>
      ),
    },
  ]

  // Table column definitions for rankings
  const rankingColumns = [
    {
      key: 'rank',
      header: '#',
      render: (_: BattleStats & { users?: User }, index: number) => (
        <span className="font-bold text-gray-500">{index + 1}</span>
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (stat: BattleStats & { users?: User }) => (
        <div className="flex items-center space-x-2">
          {stat.users?.twitch_profile_image_url ? (
            <img
              src={stat.users.twitch_profile_image_url}
              alt={stat.users.twitch_display_name}
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-gray-200" />
          )}
          <span className="font-medium">{stat.users?.twitch_display_name || 'Unknown'}</span>
        </div>
      ),
    },
    {
      key: 'total_battles',
      header: 'Battles',
      render: (stat: BattleStats) => <span>{stat.total_battles}</span>,
    },
    {
      key: 'record',
      header: 'W-L-D',
      render: (stat: BattleStats) => (
        <span className="text-sm">
          <span className="text-green-600">{stat.wins}</span>-
          <span className="text-red-600">{stat.losses}</span>-
          <span className="text-gray-600">{stat.draws}</span>
        </span>
      ),
    },
    {
      key: 'win_rate',
      header: 'Win Rate',
      render: (stat: BattleStats) => (
        <span
          className={`font-medium ${
            stat.win_rate >= 50 ? 'text-green-600' : 'text-red-600'
          }`}
        >
          {stat.win_rate.toFixed(1)}%
        </span>
      ),
    },
  ]

  // Calculate summary statistics
  const totalBattles = battles.length
  const totalWins = battles.filter((b) => b.result === 'win').length
  const totalLosses = battles.filter((b) => b.result === 'lose').length
  const avgTurnCount = battles.length > 0
    ? (battles.reduce((sum, b) => sum + b.turn_count, 0) / battles.length).toFixed(1)
    : '0'

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Battles</h1>
          <p className="text-gray-500 mt-1">Battle history and statistics</p>
        </div>
        {/* Time Range Selector */}
        <div className="flex space-x-2">
          {(['7d', '30d', '90d'] as const).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                timeRange === range
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {range === '7d' ? '7 Days' : range === '30d' ? '30 Days' : '90 Days'}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Battles</p>
          <p className="text-2xl font-bold">{totalBattles}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Wins / Losses</p>
          <p className="text-2xl font-bold">
            <span className="text-green-600">{totalWins}</span>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-red-600">{totalLosses}</span>
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Overall Win Rate</p>
          <p className="text-2xl font-bold">
            {totalBattles > 0 ? ((totalWins / totalBattles) * 100).toFixed(1) : 0}%
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Avg. Turns</p>
          <p className="text-2xl font-bold">{avgTurnCount}</p>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily Battles Line Chart */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Battles</h2>
          {loading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : dailyBattleData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <LineChart data={dailyBattleData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  name="Total"
                />
                <Line
                  type="monotone"
                  dataKey="wins"
                  stroke="#22c55e"
                  strokeWidth={2}
                  name="Wins"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Result Distribution Pie Chart */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Result Distribution</h2>
          {loading ? (
            <div className="h-64 bg-gray-100 animate-pulse rounded" />
          ) : resultDistribution.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <PieChart>
                <Pie
                  data={resultDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {resultDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={RESULT_COLORS[entry.result]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Turn Count Distribution Bar Chart */}
        <div className="bg-white rounded-lg shadow p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Turn Count Distribution</h2>
          {loading ? (
            <div className="h-48 bg-gray-100 animate-pulse rounded" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={turnCountDistribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="range" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} name="Battles" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* User Rankings */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Players by Win Rate</h2>
        <DataTable
          columns={rankingColumns}
          data={battleStats.filter((s) => s.total_battles >= 5).slice(0, 20)}
          keyExtractor={(stat) => stat.id}
          loading={loading}
          emptyMessage="No ranking data (minimum 5 battles required)"
        />
      </div>

      {/* Recent Battles Table */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Battles</h2>
        <DataTable
          columns={battleColumns}
          data={battles.slice(0, 50)}
          keyExtractor={(battle) => battle.id}
          loading={loading}
          emptyMessage="No battle history"
        />
        {battles.length > 50 && (
          <p className="text-center text-gray-500 mt-4 text-sm">
            Showing 50 of {battles.length} records
          </p>
        )}
      </div>
    </div>
  )
}
