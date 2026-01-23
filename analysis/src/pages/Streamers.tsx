import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { StreamerPopup } from '../components/StreamerPopup'
import { Streamer } from '../types/database'

// Extended streamer type with card statistics
interface StreamerWithStats extends Streamer {
  card_count: number
}

// ソート順の定義
type SortOrder = 'card_count_desc' | 'card_count_asc' | 'created_at_desc' | 'name_asc'

/**
 * Streamers page - Displays all registered streamers with their card collections
 * Shows active status, EventSub configuration, and card statistics
 * ストリーマー名をクリックするとポップアップでTwitchリンクが表示される
 */
export function Streamers() {
  const [streamers, setStreamers] = useState<StreamerWithStats[]>([])
  const [loading, setLoading] = useState(true)
  // ソート順（デフォルト: カード数の多い順）
  const [sortOrder, setSortOrder] = useState<SortOrder>('card_count_desc')
  // カード数0のストリーマーを非表示にするフラグ
  const [hideZeroCards, setHideZeroCards] = useState(false)
  // ページネーション状態
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  useEffect(() => {
    fetchStreamers()
  }, [])

  // フィルター条件が変わったらページを1に戻す
  useEffect(() => {
    setCurrentPage(1)
  }, [sortOrder, hideZeroCards])

  /**
   * Fetches all streamers with card counts
   * Supabaseのリレーション機能を使って効率的にカード数を取得
   * 全カードを取得するのではなく、カウントのみを取得することで
   * Supabaseの1000件制限の影響を受けない
   */
  async function fetchStreamers() {
    setLoading(true)
    try {
      // Supabaseのリレーション機能でストリーマーとカード数を同時に取得
      // cards(count) は外部キー制約を利用してカード数のみを取得する
      const { data, error } = await supabase
        .from('streamers')
        .select('*, cards(count)')
        .order('created_at', { ascending: false })

      if (error) throw error

      // 型定義: Supabaseのリレーションカウント結果の形式
      type StreamerWithCardCount = Streamer & {
        cards: { count: number }[]
      }

      // Supabaseのリレーションカウントの結果を変換
      // cards: [{ count: number }] の形式で返ってくる
      const rawData = data as unknown as StreamerWithCardCount[]
      const streamersWithStats: StreamerWithStats[] = (rawData || []).map((streamer) => {
        // Supabaseのリレーションカウントは { count: number } の配列として返る
        const cardCount = streamer.cards?.[0]?.count ?? 0

        return {
          id: streamer.id,
          twitch_user_id: streamer.twitch_user_id,
          twitch_username: streamer.twitch_username,
          twitch_display_name: streamer.twitch_display_name,
          twitch_profile_image_url: streamer.twitch_profile_image_url,
          channel_point_reward_id: streamer.channel_point_reward_id,
          channel_point_reward_name: streamer.channel_point_reward_name,
          is_active: streamer.is_active,
          created_at: streamer.created_at,
          updated_at: streamer.updated_at,
          card_count: cardCount,
        }
      })

      setStreamers(streamersWithStats)
    } catch (error) {
      console.error('Error fetching streamers:', error)
    } finally {
      setLoading(false)
    }
  }

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

  // Calculate summary statistics（全データに基づく）
  const activeStreamers = streamers.filter((s) => s.is_active).length
  const configuredStreamers = streamers.filter((s) => s.channel_point_reward_id).length
  const totalCards = streamers.reduce((sum, s) => sum + s.card_count, 0)
  const streamersWithCards = streamers.filter((s) => s.card_count > 0).length

  /**
   * フィルターとソートを適用したストリーマー一覧を生成
   */
  const filteredAndSortedStreamers = (() => {
    // フィルター: カード数0を非表示にする場合
    let result = hideZeroCards
      ? streamers.filter((s) => s.card_count > 0)
      : streamers

    // ソート
    result = [...result].sort((a, b) => {
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

    return result
  })()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Streamers</h1>
        <p className="text-gray-500 mt-1">Manage and view all registered streamers</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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

          {/* 表示件数 */}
          <div className="text-sm text-gray-500 ml-auto">
            表示: {filteredAndSortedStreamers.length} / {streamers.length} 件
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
