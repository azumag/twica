import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, type StreamerWithStats } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { StreamerPopup } from '../components/StreamerPopup'

/**
 * Formats byte count into human-readable string (KB, MB, GB)
 * バイト数を人間が読みやすい形式（KB, MB, GB）にフォーマット
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// ソート順の定義
type SortOrder = 'card_count_desc' | 'card_count_asc' | 'created_at_desc' | 'name_asc' | 'storage_desc'

/**
 * Streamers page - Displays all registered streamers with their card collections
 * Shows active status, EventSub configuration, card statistics, and storage usage
 * ストリーマー名をクリックするとポップアップでTwitchリンクが表示される
 * ストレージ使用量はblob_filesのuser_prefixに基づく実使用量を表示
 * 検索フォームでユーザー名・表示名・Twitch User IDでフィルタリング可能
 */
export function Streamers() {
  const [streamers, setStreamers] = useState<StreamerWithStats[]>([])
  const [loading, setLoading] = useState(true)
  // 検索クエリ（ユーザー名・表示名・Twitch User IDでフィルタリング）
  const [searchQuery, setSearchQuery] = useState('')
  // ソート順（デフォルト: カード数の多い順）
  const [sortOrder, setSortOrder] = useState<SortOrder>('card_count_desc')
  // カード数0のストリーマーを非表示にするフラグ
  const [hideZeroCards, setHideZeroCards] = useState(false)
  // チャット通知ONのストリーマーのみ表示するフラグ
  const [filterChatEnabled, setFilterChatEnabled] = useState(false)
  // カスタムテンプレート設定済みのストリーマーのみ表示するフラグ
  const [filterHasTemplate, setFilterHasTemplate] = useState(false)
  // Chat通知ONだが権限(user:write:chat)が未付与のストリーマーのみ表示するフラグ
  const [filterMissingScope, setFilterMissingScope] = useState(false)
  // 投票キャンペーン有効化済みのストリーマーのみ表示するフラグ
  const [filterVoteCampaign, setFilterVoteCampaign] = useState(false)
  // ページネーション状態
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [error, setError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更するとeffectを再実行させる）
  const [retryToken, setRetryToken] = useState(0)

  // Fetches all streamers with card counts and storage usage
  // カード数・ストレージ使用量・チャット送信可否・投票キャンペーン適用状況は
  // すべてサーバーサイド（/__admin/streamers）で集計済みのため、1回のAPI呼び出しで完結する
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const streamers = await adminApi.getStreamers({ signal: controller.signal })
        setStreamers(streamers)
      } catch (err) {
        if (controller.signal.aborted) return
        console.error('Error fetching streamers:', err)
        setError((err instanceof Error && err.message) || 'ストリーマー一覧の取得に失敗しました')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [retryToken])

  // フィルター条件が変わったらページを1に戻す
  useEffect(() => {
    setCurrentPage(1)
  }, [sortOrder, hideZeroCards, filterChatEnabled, filterHasTemplate, filterMissingScope, filterVoteCampaign, searchQuery])

  // Table column definitions
  const columns = [
    {
      key: 'profile',
      header: 'Streamer',
      render: (streamer: StreamerWithStats) => (
        <div className="flex items-center space-x-3">
          {streamer.twitch_profile_image_url ? (
            <img
              src={streamer.twitch_profile_image_url}
              alt={streamer.twitch_display_name}
              className="w-10 h-10 rounded-full"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
              <span className="text-purple-600">🎮</span>
            </div>
          )}
          <div>
            {/* ストリーマー名をクリックするとポップアップ表示 */}
            <StreamerPopup streamer={streamer}>
              <span className="font-medium text-gray-900 hover:text-purple-600">
                {streamer.twitch_display_name}
              </span>
            </StreamerPopup>
            <p className="text-xs text-gray-500">@{streamer.twitch_username}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.is_active
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {streamer.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'card_count',
      header: 'Cards',
      render: (streamer: StreamerWithStats) => (
        // カード数をクリックするとカード一覧ページに遷移
        <Link
          to={`/streamers/${streamer.id}/cards`}
          className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
          title="カード一覧を表示"
        >
          {streamer.card_count}枚 →
        </Link>
      ),
    },
    {
      // Storage column - displays total file size of all card images for this streamer
      // ストレージ列 - このストリーマーの全カード画像のファイルサイズ合計を表示
      key: 'storage',
      header: 'Storage',
      render: (streamer: StreamerWithStats) => (
        <span className={`text-sm ${streamer.storage_bytes > 0 ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
          {formatBytes(streamer.storage_bytes)}
        </span>
      ),
    },
    {
      key: 'eventsub',
      header: 'EventSub',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.channel_point_reward_id
              ? 'bg-blue-100 text-blue-800'
              : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {streamer.channel_point_reward_id ? 'Configured' : 'Not Set'}
        </span>
      ),
    },
    {
      // チャット通知設定の有効/無効を表示するカラム
      // 通知ONなのに現在の送信方式で送信できない場合は警告アイコンを表示
      key: 'chat_announcement',
      header: 'Chat通知',
      render: (streamer: StreamerWithStats) => (
        <div className="flex items-center gap-1">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              streamer.chat_announcement_enabled
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {streamer.chat_announcement_enabled ? 'ON' : 'OFF'}
          </span>
          {/* 通知ONだが現在の送信方式で送信できない場合に警告表示 */}
          {streamer.chat_announcement_enabled && !streamer.chat_send_available && (
            <span
              className="text-amber-500"
              title="通知ONですが現在の送信方式では送信できません"
            >
              ⚠
            </span>
          )}
        </div>
      ),
    },
    {
      // 現在のチャット通知送信可否を表示するカラム
      key: 'chat_scope',
      header: 'Chat送信',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.chat_send_available
              ? 'bg-blue-100 text-blue-800'
              : 'bg-gray-100 text-gray-800'
          }`}
          title={
            streamer.has_active_bot_sender
              ? '有効なBOT送信設定があります'
              : streamer.has_chat_scope
                ? '配信者本人にuser:write:chatが付与されています'
                : '現在の送信方式ではチャット通知を送信できません'
          }
        >
          {streamer.chat_send_available
            ? streamer.has_active_bot_sender ? 'BOT送信可' : '本人送信可'
            : '送信不可'}
        </span>
      ),
    },
    {
      // カスタムテンプレート設定の有無を表示するカラム
      // chat_announcement_template が null でなければカスタム設定済み
      key: 'custom_template',
      header: 'カスタムテンプレート',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.chat_announcement_template
              ? 'bg-purple-100 text-purple-800'
              : 'bg-gray-100 text-gray-800'
          }`}
          title={streamer.chat_announcement_template || 'デフォルトテンプレート使用'}
        >
          {streamer.chat_announcement_template ? '設定あり' : '未設定'}
        </span>
      ),
    },
    {
      // 投票キャンペーンボーナスの有無を表示するカラム
      // streamer_storage_bonusテーブルにtype='campaign', memo='2026選挙応援'のレコードがあればボーナス適用済み
      key: 'vote_campaign',
      header: '投票キャンペーン',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.has_vote_campaign_bonus
              ? 'bg-pink-100 text-pink-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {streamer.has_vote_campaign_bonus ? '有効化済み' : '未使用'}
        </span>
      ),
    },
    {
      key: 'reward_name',
      header: 'Reward Name',
      render: (streamer: StreamerWithStats) => (
        <span className="text-gray-600 text-sm">
          {streamer.channel_point_reward_name || '-'}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Registered',
      render: (streamer: StreamerWithStats) => (
        <span className="text-gray-500 text-sm">
          {new Date(streamer.created_at).toLocaleDateString('ja-JP')}
        </span>
      ),
    },
  ]

  // Calculate summary statistics including total storage usage
  // 全ストリーマーの統計情報を計算（ストレージ使用量を含む）
  const activeStreamers = streamers.filter((s) => s.is_active).length
  const configuredStreamers = streamers.filter((s) => s.channel_point_reward_id).length
  const totalCards = streamers.reduce((sum, s) => sum + s.card_count, 0)
  const totalStorage = streamers.reduce((sum, s) => sum + s.storage_bytes, 0)
  const streamersWithCards = streamers.filter((s) => s.card_count > 0).length
  // チャット通知ONのストリーマー数
  const chatEnabledStreamers = streamers.filter((s) => s.chat_announcement_enabled).length
  // カスタムテンプレート設定済みのストリーマー数
  const customTemplateStreamers = streamers.filter((s) => s.chat_announcement_template).length
  // Chat通知ONだが現在の送信方式で送信できないストリーマー数（要対応）
  const chatEnabledNoSender = streamers.filter((s) => s.chat_announcement_enabled && !s.chat_send_available).length
  // 投票キャンペーンボーナスを有効化したユーザー数
  const voteCampaignUsers = streamers.filter((s) => s.has_vote_campaign_bonus).length

  /**
   * フィルターとソートを適用したストリーマー一覧を生成
   * 検索クエリ、カード数フィルター、ソート順を適用
   * パフォーマンス最適化のためuseMemoでメモ化
   */
  const filteredAndSortedStreamers = useMemo(() => {
    let result = streamers

    // フィルター: 検索クエリ（ユーザー名、表示名、またはTwitch User IDに部分一致）
    // broadcasterTwitchUserIdで配信者を特定する運用ケースに対応
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      result = result.filter(
        (s) =>
          s.twitch_username.toLowerCase().includes(query) ||
          s.twitch_display_name.toLowerCase().includes(query) ||
          s.twitch_user_id.includes(query)
      )
    }

    // フィルター: カード数0を非表示にする場合
    if (hideZeroCards) {
      result = result.filter((s) => s.card_count > 0)
    }

    // フィルター: チャット通知ONのストリーマーのみ表示
    if (filterChatEnabled) {
      result = result.filter((s) => s.chat_announcement_enabled)
    }

    // フィルター: カスタムテンプレート設定済みのストリーマーのみ表示
    if (filterHasTemplate) {
      result = result.filter((s) => s.chat_announcement_template)
    }

    // フィルター: Chat通知ONだが現在の送信方式で送信できないストリーマーのみ表示
    if (filterMissingScope) {
      result = result.filter((s) => s.chat_announcement_enabled && !s.chat_send_available)
    }

    // フィルター: 投票キャンペーン有効化済みのストリーマーのみ表示
    if (filterVoteCampaign) {
      result = result.filter((s) => s.has_vote_campaign_bonus)
    }

    // ソート
    result = [...result].sort((a, b) => {
      switch (sortOrder) {
        case 'card_count_desc':
          return b.card_count - a.card_count
        case 'card_count_asc':
          return a.card_count - b.card_count
        case 'storage_desc':
          return b.storage_bytes - a.storage_bytes
        case 'name_asc':
          return a.twitch_display_name.localeCompare(b.twitch_display_name)
        case 'created_at_desc':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
    })

    return result
  }, [streamers, searchQuery, hideZeroCards, filterChatEnabled, filterHasTemplate, filterMissingScope, filterVoteCampaign, sortOrder])

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Streamers</h1>
        <p className="text-gray-500 mt-1">Manage and view all registered streamers</p>
      </div>

      <ErrorBanner messages={[error]} onRetry={() => setRetryToken((t) => t + 1)} />

      {/* Summary Stats - includes total storage usage across all streamers */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Streamers</p>
          <p className="text-2xl font-bold">{streamers.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Active</p>
          <p className="text-2xl font-bold text-green-600">{activeStreamers}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">EventSub Configured</p>
          <p className="text-2xl font-bold text-blue-600">{configuredStreamers}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Cards</p>
          <p className="text-2xl font-bold">{totalCards}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Storage</p>
          <p className="text-2xl font-bold text-purple-600">{formatBytes(totalStorage)}</p>
        </div>
        {/* チャット通知をONにしているストリーマー数 */}
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Chat通知 ON</p>
          <p className="text-2xl font-bold text-green-600">{chatEnabledStreamers}</p>
        </div>
        {/* カスタムテンプレートを設定済みのストリーマー数 */}
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">カスタムテンプレート</p>
          <p className="text-2xl font-bold text-purple-600">{customTemplateStreamers}</p>
        </div>
        {/* 投票キャンペーンボーナスを有効化したユーザー数 */}
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">投票キャンペーン</p>
          <p className="text-2xl font-bold text-pink-600">{voteCampaignUsers}</p>
        </div>
      </div>

      {/* Chat通知ONなのに現在の送信方式で送信できないストリーマーがいる場合に警告バナーを表示 */}
      {chatEnabledNoSender > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-3">
          <span className="text-amber-500 text-xl">⚠</span>
          <div>
            <p className="text-sm font-medium text-amber-800">
              Chat通知ONだが現在の送信方式では送信不可: {chatEnabledNoSender}件
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              配信者本人の再認証、または有効なBOT送信設定が必要です。
            </p>
          </div>
        </div>
      )}

      {/* 検索フォーム */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <svg
              className="h-5 w-5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ストリーマー名 または Twitch User ID で検索..."
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-4 text-gray-900 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          {/* 検索クエリをクリアするボタン */}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
              title="クリア"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* フィルター・ソートコントロール */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* ソート選択 */}
          <div className="flex items-center space-x-2">
            <label htmlFor="sort" className="text-sm text-gray-600">
              ソート:
            </label>
            <select
              id="sort"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              <option value="card_count_desc">カード数 (多い順)</option>
              <option value="card_count_asc">カード数 (少ない順)</option>
              <option value="storage_desc">ストレージ (大きい順)</option>
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
              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
            />
            <span className="text-sm text-gray-600">
              カード0件を非表示
            </span>
          </label>

          {/* チャット通知ONのみ表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterChatEnabled}
              onChange={(e) => setFilterChatEnabled(e.target.checked)}
              className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
            />
            <span className="text-sm text-gray-600">
              Chat通知ONのみ
            </span>
          </label>

          {/* カスタムテンプレート設定済みのみ表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterHasTemplate}
              onChange={(e) => setFilterHasTemplate(e.target.checked)}
              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
            />
            <span className="text-sm text-gray-600">
              カスタムテンプレートありのみ
            </span>
          </label>

          {/* Chat通知ONだが送信不可のみ表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterMissingScope}
              onChange={(e) => setFilterMissingScope(e.target.checked)}
              className="w-4 h-4 text-amber-500 border-gray-300 rounded focus:ring-amber-500"
            />
            <span className="text-sm text-amber-600 font-medium">
              通知ON・送信不可
            </span>
          </label>

          {/* 投票キャンペーン有効化済みのみ表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterVoteCampaign}
              onChange={(e) => setFilterVoteCampaign(e.target.checked)}
              className="w-4 h-4 text-pink-600 border-gray-300 rounded focus:ring-pink-500"
            />
            <span className="text-sm text-gray-600">
              投票キャンペーンのみ
            </span>
          </label>

          {/* 表示件数 */}
          <div className="text-sm text-gray-500 ml-auto">
            表示: {filteredAndSortedStreamers.length} / {streamers.length} 件
            {searchQuery && ` (検索: "${searchQuery}")`}
            {hideZeroCards && ` (カードあり: ${streamersWithCards}件)`}
          </div>
        </div>
      </div>

      {/* Streamers Table */}
      <DataTable
        columns={columns}
        data={filteredAndSortedStreamers}
        keyExtractor={(streamer) => streamer.id}
        loading={loading}
        emptyMessage="No streamers registered"
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
