import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { StatCard } from '../components/StatCard'
import { StreamerPopup } from '../components/StreamerPopup'
import { GachaHistory, Battle, Card, Streamer } from '../types/database'
import { RarityBadge } from '../components/RarityBadge'

/**
 * Overview page - Main dashboard view
 * Displays key statistics and recent activity across the platform
 */
export function Overview() {
  // State for statistics
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalStreamers: 0,
    totalCards: 0,
    todayGacha: 0,
    weekGacha: 0,
    monthGacha: 0,
  })
  const [recentGacha, setRecentGacha] = useState<(GachaHistory & { cards: Card; streamers: Streamer })[]>([])
  const [recentBattles, setRecentBattles] = useState<Battle[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  /**
   * Fetches all dashboard statistics from Supabase
   * Performs multiple queries in parallel for efficiency
   */
  async function fetchData() {
    setLoading(true)
    try {
      // Calculate date boundaries for time-based statistics
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

      // Fetch all data in parallel for better performance
      const [
        usersResult,
        streamersResult,
        cardsResult,
        todayGachaResult,
        weekGachaResult,
        monthGachaResult,
        recentGachaResult,
        recentBattlesResult,
      ] = await Promise.all([
        // Count total users
        supabase.from('users').select('*', { count: 'exact', head: true }),
        // Count total streamers
        supabase.from('streamers').select('*', { count: 'exact', head: true }),
        // Count total cards
        supabase.from('cards').select('*', { count: 'exact', head: true }),
        // Count today's gacha
        supabase
          .from('gacha_history')
          .select('*', { count: 'exact', head: true })
          .gte('redeemed_at', todayStart),
        // Count this week's gacha
        supabase
          .from('gacha_history')
          .select('*', { count: 'exact', head: true })
          .gte('redeemed_at', weekStart),
        // Count this month's gacha
        supabase
          .from('gacha_history')
          .select('*', { count: 'exact', head: true })
          .gte('redeemed_at', monthStart),
        // Get recent gacha history with card and streamer details
        supabase
          .from('gacha_history')
          .select('*, cards(*), streamers(*)')
          .order('redeemed_at', { ascending: false })
          .limit(10),
        // Get recent battles
        supabase
          .from('battles')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10),
      ])

      setStats({
        totalUsers: usersResult.count || 0,
        totalStreamers: streamersResult.count || 0,
        totalCards: cardsResult.count || 0,
        todayGacha: todayGachaResult.count || 0,
        weekGacha: weekGachaResult.count || 0,
        monthGacha: monthGachaResult.count || 0,
      })

      // Type assertion for joined query results
      setRecentGacha(
        (recentGachaResult.data as unknown as (GachaHistory & { cards: Card; streamers: Streamer })[]) || []
      )
      setRecentBattles(recentBattlesResult.data || [])
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

        {/* Recent Battles */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Battles</h2>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 animate-pulse rounded" />
              ))}
            </div>
          ) : recentBattles.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No battle history</p>
          ) : (
            <ul className="space-y-3">
              {recentBattles.map((battle) => (
                <li
                  key={battle.id}
                  className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                >
                  <div className="flex items-center space-x-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                        battle.result === 'win'
                          ? 'bg-green-100'
                          : battle.result === 'lose'
                          ? 'bg-red-100'
                          : 'bg-gray-100'
                      }`}
                    >
                      {battle.result === 'win' ? '🏆' : battle.result === 'lose' ? '💀' : '🤝'}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {battle.result === 'win'
                          ? 'Victory'
                          : battle.result === 'lose'
                          ? 'Defeat'
                          : 'Draw'}
                      </p>
                      <p className="text-xs text-gray-500">
                        {battle.turn_count} turns
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">
                    {formatRelativeTime(battle.created_at)}
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
