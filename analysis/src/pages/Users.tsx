import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { User } from '../types/database'

// Extended user type with aggregated statistics
interface UserWithStats extends User {
  card_count: number
}

// ソート順の定義
type SortOrder = 'card_count_desc' | 'card_count_asc' | 'created_at_desc' | 'name_asc'

/**
 * Users page - Displays all registered users with their statistics
 * Shows card ownership counts and ToS acceptance status
 */
export function Users() {
  const [users, setUsers] = useState<UserWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  // ソート順（デフォルト: カード数の多い順）
  const [sortOrder, setSortOrder] = useState<SortOrder>('card_count_desc')
  // カード数0のユーザーを非表示にするフラグ
  const [hideZeroCards, setHideZeroCards] = useState(false)
  // ページネーション状態
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [error, setError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更するとeffectを再実行させる）
  const [retryToken, setRetryToken] = useState(0)

  // Fetches all users with their card counts
  // サーバーサイド（/__admin/users）でカード数を集計済みのデータを取得
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const rawData = await adminApi.getUsers({ signal: controller.signal })

        // Combine users with their statistics
        const usersWithStats: UserWithStats[] = rawData.map((user) => {
          const cardCount = user.user_cards?.[0]?.count ?? 0
          return {
            id: user.id,
            twitch_user_id: user.twitch_user_id,
            twitch_username: user.twitch_username,
            twitch_display_name: user.twitch_display_name,
            twitch_profile_image_url: user.twitch_profile_image_url,
            tos_accepted_at: user.tos_accepted_at,
            twitch_scopes: user.twitch_scopes ?? [],
            created_at: user.created_at,
            updated_at: user.updated_at,
            card_count: cardCount,
          }
        })

        setUsers(usersWithStats)
      } catch (err) {
        if (controller.signal.aborted) return
        console.error('Error fetching users:', err)
        setError((err instanceof Error && err.message) || 'ユーザー一覧の取得に失敗しました')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [retryToken])

  // フィルター条件が変わったらページを1に戻す
  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, sortOrder, hideZeroCards])

  // Filter users based on search term and hideZeroCards flag
  const filteredUsers = users.filter((user) => {
    // 検索フィルター
    const matchesSearch =
      user.twitch_username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.twitch_display_name.toLowerCase().includes(searchTerm.toLowerCase())
    // カード0件フィルター
    const matchesCardFilter = hideZeroCards ? user.card_count > 0 : true
    return matchesSearch && matchesCardFilter
  })

  /**
   * ソートを適用したユーザー一覧を生成
   */
  const sortedUsers = [...filteredUsers].sort((a, b) => {
    switch (sortOrder) {
      case 'card_count_desc':
        return b.card_count - a.card_count
      case 'card_count_asc':
        return a.card_count - b.card_count
      case 'name_asc':
        return a.twitch_display_name.localeCompare(b.twitch_display_name)
      case 'created_at_desc':
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
  })

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
        // カード数をクリックするとカード一覧ページに遷移
        <Link
          to={`/users/${user.id}/cards`}
          className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
          title="カード一覧を表示"
        >
          {user.card_count}枚 →
        </Link>
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

  // Calculate summary statistics（全データに基づく）
  const totalCards = users.reduce((sum, u) => sum + u.card_count, 0)
  const usersWithTos = users.filter((u) => u.tos_accepted_at).length
  const usersWithCards = users.filter((u) => u.card_count > 0).length

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="text-gray-500 mt-1">Manage and view all registered users</p>
      </div>

      <ErrorBanner messages={[error]} onRetry={() => setRetryToken((t) => t + 1)} />

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
      </div>

      {/* フィルター・ソートコントロール */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* 検索 */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="ユーザー名で検索..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-4 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>

          {/* ソート選択 */}
          <div className="flex items-center space-x-2">
            <label htmlFor="sort" className="text-sm text-gray-600">
              ソート:
            </label>
            <select
              id="sort"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="card_count_desc">カード数 (多い順)</option>
              <option value="card_count_asc">カード数 (少ない順)</option>
              <option value="name_asc">名前 (A-Z)</option>
              <option value="created_at_desc">登録日 (新しい順)</option>
            </select>
          </div>

          {/* カード数0を非表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hideZeroCards}
              onChange={(e) => setHideZeroCards(e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600">
              カード0件を非表示
            </span>
          </label>

          {/* 表示件数 */}
          <div className="text-sm text-gray-500">
            表示: {sortedUsers.length} / {users.length} 件
            {hideZeroCards && ` (カード所持: ${usersWithCards}件)`}
          </div>
        </div>
      </div>

      {/* Users Table */}
      <DataTable
        columns={columns}
        data={sortedUsers}
        keyExtractor={(user) => user.id}
        loading={loading}
        emptyMessage="No users found"
        pagination={{
          currentPage,
          pageSize,
          onPageChange: setCurrentPage,
          onPageSizeChange: (size) => {
            setPageSize(size)
            setCurrentPage(1)
          },
          pageSizeOptions: [10, 20, 50, 100],
        }}
      />
    </div>
  )
}
