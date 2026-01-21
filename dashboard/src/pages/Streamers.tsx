import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { StreamerPopup } from '../components/StreamerPopup'
import { Streamer, Card } from '../types/database'

// Extended streamer type with card statistics
interface StreamerWithStats extends Streamer {
  card_count: number
  cards: Card[]
}

/**
 * Streamers page - Displays all registered streamers with their card collections
 * Shows active status, EventSub configuration, and card statistics
 * ストリーマー名をクリックするとポップアップでTwitchリンクが表示される
 */
export function Streamers() {
  const [streamers, setStreamers] = useState<StreamerWithStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStreamers()
  }, [])

  /**
   * Fetches all streamers with their associated cards
   */
  async function fetchStreamers() {
    setLoading(true)
    try {
      // Fetch streamers with their cards
      const [streamersResult, cardsResult] = await Promise.all([
        supabase
          .from('streamers')
          .select('*')
          .order('created_at', { ascending: false }),
        supabase
          .from('cards')
          .select('*'),
      ])

      if (streamersResult.error) throw streamersResult.error

      // Type assertions for query results
      const streamersData = streamersResult.data as Streamer[]
      const cardsData = (cardsResult.data || []) as Card[]

      // Group cards by streamer_id
      const cardsByStreamer = new Map<string, Card[]>()
      cardsData.forEach((card) => {
        const existing = cardsByStreamer.get(card.streamer_id) || []
        cardsByStreamer.set(card.streamer_id, [...existing, card])
      })

      // Combine streamers with their cards
      const streamersWithStats: StreamerWithStats[] = streamersData.map((streamer) => ({
        ...streamer,
        cards: cardsByStreamer.get(streamer.id) || [],
        card_count: (cardsByStreamer.get(streamer.id) || []).length,
      }))

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
        <span className="font-medium">{streamer.card_count}</span>
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

  // Calculate summary statistics
  const activeStreamers = streamers.filter((s) => s.is_active).length
  const configuredStreamers = streamers.filter((s) => s.channel_point_reward_id).length
  const totalCards = streamers.reduce((sum, s) => sum + s.card_count, 0)

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

      {/* Streamers Table */}
      <DataTable
        columns={columns}
        data={streamers}
        keyExtractor={(streamer) => streamer.id}
        loading={loading}
        emptyMessage="No streamers registered"
      />
    </div>
  )
}
