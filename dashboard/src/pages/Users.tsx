import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { User, BattleStats, UserCard } from '../types/database'

// Extended user type with aggregated statistics
interface UserWithStats extends User {
  card_count: number
  battle_stats: BattleStats | null
}

/**
 * Users page - Displays all registered users with their statistics
 * Shows card ownership counts, battle statistics, and ToS acceptance status
 */
export function Users() {
  const [users, setUsers] = useState<UserWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    fetchUsers()
  }, [])

  /**
   * Fetches all users with their card counts and battle statistics
   * Uses multiple queries and combines the data on the client side
   */
  async function fetchUsers() {
    setLoading(true)
    try {
      // Fetch users, user_cards counts, and battle_stats in parallel
      const [usersResult, userCardsResult, battleStatsResult] = await Promise.all([
        supabase
          .from('users')
          .select('*')
          .order('created_at', { ascending: false }),
        // Get card counts per user using a group query
        supabase
          .from('user_cards')
          .select('user_id'),
        supabase
          .from('battle_stats')
          .select('*'),
      ])

      if (usersResult.error) throw usersResult.error

      // Type assertions for query results
      const usersData = usersResult.data as User[]
      const userCardsData = (userCardsResult.data || []) as Pick<UserCard, 'user_id'>[]
      const battleStatsData = (battleStatsResult.data || []) as BattleStats[]

      // Create a map of user_id -> card count
      const cardCountMap = new Map<string, number>()
      userCardsData.forEach((uc) => {
        const current = cardCountMap.get(uc.user_id) || 0
        cardCountMap.set(uc.user_id, current + 1)
      })

      // Create a map of user_id -> battle stats
      const battleStatsMap = new Map<string, BattleStats>()
      battleStatsData.forEach((bs) => {
        battleStatsMap.set(bs.user_id, bs)
      })

      // Combine users with their statistics
      const usersWithStats: UserWithStats[] = usersData.map((user) => ({
        ...user,
        card_count: cardCountMap.get(user.id) || 0,
        battle_stats: battleStatsMap.get(user.id) || null,
      }))

      setUsers(usersWithStats)
    } catch (error) {
      console.error('Error fetching users:', error)
    } finally {
      setLoading(false)
    }
  }

  // Filter users based on search term
  const filteredUsers = users.filter(
    (user) =>
      user.twitch_username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.twitch_display_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // Table column definitions
  const columns = [
    {
      key: 'profile',
      header: 'User',
      render: (user: UserWithStats) => (
        <div className="flex items-center space-x-3">
          {user.twitch_profile_image_url ? (
            <img
              src={user.twitch_profile_image_url}
              alt={user.twitch_display_name}
              className="w-8 h-8 rounded-full"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
              <span className="text-gray-500 text-sm">👤</span>
            </div>
          )}
          <div>
            <p className="font-medium text-gray-900">{user.twitch_display_name}</p>
            <p className="text-xs text-gray-500">@{user.twitch_username}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'card_count',
      header: 'Cards',
      render: (user: UserWithStats) => (
        <span className="font-medium">{user.card_count}</span>
      ),
    },
    {
      key: 'battles',
      header: 'Battles',
      render: (user: UserWithStats) => (
        <div className="text-sm">
          {user.battle_stats ? (
            <>
              <span className="font-medium">{user.battle_stats.total_battles}</span>
              <span className="text-gray-500 ml-1">
                ({user.battle_stats.wins}W / {user.battle_stats.losses}L)
              </span>
            </>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </div>
      ),
    },
    {
      key: 'win_rate',
      header: 'Win Rate',
      render: (user: UserWithStats) => (
        <div>
          {user.battle_stats && user.battle_stats.total_battles > 0 ? (
            <span
              className={`font-medium ${
                user.battle_stats.win_rate >= 50
                  ? 'text-green-600'
                  : 'text-red-600'
              }`}
            >
              {user.battle_stats.win_rate.toFixed(1)}%
            </span>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </div>
      ),
    },
    {
      key: 'tos',
      header: 'ToS',
      render: (user: UserWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            user.tos_accepted_at
              ? 'bg-green-100 text-green-800'
              : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {user.tos_accepted_at ? 'Accepted' : 'Pending'}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Registered',
      render: (user: UserWithStats) => (
        <span className="text-gray-500 text-sm">
          {new Date(user.created_at).toLocaleDateString('ja-JP')}
        </span>
      ),
    },
  ]

  // Calculate summary statistics
  const totalCards = users.reduce((sum, u) => sum + u.card_count, 0)
  const usersWithTos = users.filter((u) => u.tos_accepted_at).length
  const usersWithBattles = users.filter((u) => u.battle_stats && u.battle_stats.total_battles > 0).length

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="text-gray-500 mt-1">Manage and view all registered users</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Users</p>
          <p className="text-2xl font-bold">{users.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Cards Owned</p>
          <p className="text-2xl font-bold">{totalCards}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">ToS Accepted</p>
          <p className="text-2xl font-bold">
            {usersWithTos}
            <span className="text-sm font-normal text-gray-500 ml-1">
              ({users.length > 0 ? ((usersWithTos / users.length) * 100).toFixed(1) : 0}%)
            </span>
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Active Battlers</p>
          <p className="text-2xl font-bold">{usersWithBattles}</p>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <input
          type="text"
          placeholder="Search by username..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Users Table */}
      <DataTable
        columns={columns}
        data={filteredUsers}
        keyExtractor={(user) => user.id}
        loading={loading}
        emptyMessage="No users found"
      />
    </div>
  )
}
