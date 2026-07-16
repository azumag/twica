import { useEffect, useState } from 'react'
import {
  adminApi,
  type OverviewStats,
  type OverviewData,
  type StreamerLeaderboardEntry,
} from '../lib/adminApi'
import { StatCard } from '../components/StatCard'
import { StreamerPopup } from '../components/StreamerPopup'
import { GachaHistory, Card, Streamer } from '../types/database'
import { RarityBadge } from '../components/RarityBadge'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

/**
 * Overview page - Main dashboard view
 * Displays key statistics and recent activity across the platform
 */
export function Overview() {
  // State for statistics
  const [stats, setStats] = useState<OverviewStats>({
    totalUsers: 0,
    totalStreamers: 0,
    totalCards: 0,
    todayGacha: 0,
    weekGacha: 0,
    monthGacha: 0,
  })
  const [recentGacha, setRecentGacha] = useState<(GachaHistory & { cards: Card; streamers: Streamer })[]>([])
  const [userGrowth, setUserGrowth] = useState<OverviewData['userGrowth']>([])
  const [gachaGrowth, setGachaGrowth] = useState<OverviewData['gachaGrowth']>([])
  const [loading, setLoading] = useState(true)

  // Cross-streamer leaderboardは/__admin/overview/leaderboardが直近30日のgacha_history
  // 全件をNode側集計するため約20秒かかる。他の統計をブロックしないよう、独立したuseEffect/
  // loading stateで取得する(analysis/src/pages/StreamerGachaHistory.tsxの
  // chart/table/drop-rate-statsの分離パターンと同様)
  const [leaderboard, setLeaderboard] = useState<StreamerLeaderboardEntry[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    let cancelled = false

    const fetchLeaderboard = async () => {
      setLeaderboardLoading(true)
      try {
        const data = await adminApi.getOverviewLeaderboard()
        if (!cancelled) setLeaderboard(data)
      } catch (error) {
        console.error('Error fetching streamer leaderboard:', error)
      } finally {
        if (!cancelled) setLeaderboardLoading(false)
      }
    }

    fetchLeaderboard()

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Fetches all dashboard statistics via the /__admin API
   * Performs multiple queries in parallel for efficiency
   */
  async function fetchData() {
    setLoading(true)
    try {
      const data = await adminApi.getOverview()
      setStats(data.stats)
      setRecentGacha(data.recentGacha as (GachaHistory & { cards: Card; streamers: Streamer })[])
      setUserGrowth(data.userGrowth)
      setGachaGrowth(data.gachaGrowth)
    } catch (error) {
      console.error('Error fetching dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Formats a timestamp into a relative time string (e.g., "2 hours ago")
   */
  function formatRelativeTime(timestamp: string): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-gray-500 mt-1">Dashboard statistics and recent activity</p>
      </div>

      {/* Main Statistics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          title="Total Users"
          value={stats.totalUsers}
          icon="👥"
          color="blue"
          loading={loading}
        />
        <StatCard
          title="Total Streamers"
          value={stats.totalStreamers}
          icon="🎮"
          color="purple"
          loading={loading}
        />
        <StatCard
          title="Total Cards"
          value={stats.totalCards}
          icon="🃏"
          color="green"
          loading={loading}
        />
      </div>

      {/* Gacha Statistics */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Gacha Activity</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Today's Gacha"
            value={stats.todayGacha}
            icon="🎰"
            color="amber"
            loading={loading}
          />
          <StatCard
            title="This Week"
            value={stats.weekGacha}
            description="Last 7 days"
            color="amber"
            loading={loading}
          />
          <StatCard
            title="This Month"
            value={stats.monthGacha}
            description="Current month"
            color="amber"
            loading={loading}
          />
        </div>
      </div>

      {/* Recent Activity Section */}
      <div className="grid grid-cols-1 gap-6">
        {/* Recent Gacha */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Gacha</h2>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 animate-pulse rounded" />
              ))}
            </div>
          ) : recentGacha.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No gacha history</p>
          ) : (
            <ul className="space-y-3">
              {recentGacha.map((gacha) => (
                <li
                  key={gacha.id}
                  className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-sm">
                      🎰
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {gacha.user_twitch_username || 'Unknown User'}
                      </p>
                      <p className="text-xs text-gray-500">
                        Got {gacha.cards?.name || 'Unknown Card'}
                        {gacha.cards && (
                          <span className="ml-2">
                            <RarityBadge rarity={gacha.cards.rarity} />
                          </span>
                        )}
                        {gacha.streamers && (
                          <span className="ml-2">
                            from{' '}
                            <StreamerPopup streamer={gacha.streamers}>
                              <span className="text-purple-600 hover:text-purple-800">
                                {gacha.streamers.twitch_display_name}
                              </span>
                            </StreamerPopup>
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">
                    {formatRelativeTime(gacha.redeemed_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Growth Trends Section */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Growth Trends (Last 30 Days)</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* New User Signups Line Chart */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-md font-semibold text-gray-900 mb-4">New User Signups</h3>
            {loading ? (
              <div className="h-64 bg-gray-100 animate-pulse rounded" />
            ) : userGrowth.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-gray-500">
                No data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={256}>
                <LineChart data={userGrowth}>
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

          {/* Gacha Draws Line Chart */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-md font-semibold text-gray-900 mb-4">Gacha Draws Per Day</h3>
            {loading ? (
              <div className="h-64 bg-gray-100 animate-pulse rounded" />
            ) : gachaGrowth.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-gray-500">
                No data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={256}>
                <LineChart data={gachaGrowth}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={{ fill: '#f59e0b' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Cross-Streamer Leaderboard Section */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Streamers (Last 30 Days)</h2>
        <div className="bg-white rounded-lg shadow p-6">
          {leaderboardLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 animate-pulse rounded" />
              ))}
            </div>
          ) : leaderboard.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No gacha history in the last 30 days</p>
          ) : (
            <ul className="space-y-3">
              {leaderboard.map((entry, index) => (
                <li
                  key={entry.streamerId}
                  className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                >
                  <div className="flex items-center space-x-3">
                    <span className="w-6 text-sm font-semibold text-gray-400 text-right">
                      #{index + 1}
                    </span>
                    {entry.profileImageUrl ? (
                      <img
                        src={entry.profileImageUrl}
                        alt={entry.displayName}
                        className="w-8 h-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-sm">
                        🎮
                      </div>
                    )}
                    <p className="text-sm font-medium text-gray-900">{entry.displayName}</p>
                  </div>
                  <span className="text-sm text-gray-600">
                    {entry.drawCount.toLocaleString()} draws
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
