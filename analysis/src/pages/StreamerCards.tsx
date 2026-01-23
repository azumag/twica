import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { RarityBadge } from '../components/RarityBadge'
import { Streamer, Card } from '../types/database'

/**
 * StreamerCards - ストリーマーが登録しているカード一覧ページ
 * URLパラメータからストリーマーIDを取得し、そのストリーマーのカード詳細を表示
 * 画像URL、ステータス、スキル情報など全ての登録情報を確認可能
 */
export function StreamerCards() {
  const { streamerId } = useParams<{ streamerId: string }>()
  const navigate = useNavigate()
  const [streamer, setStreamer] = useState<Streamer | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  // コピー成功時のフィードバック用
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // 説明文の展開状態を管理するSet（展開されているカードのIDを保持）
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set())

  /**
   * 説明文の展開/折りたたみをトグル
   * クリックされたカードIDを展開状態のSetに追加または削除
   */
  const toggleDescription = (id: string) => {
    setExpandedDescriptions(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  useEffect(() => {
    if (streamerId) {
      fetchStreamerAndCards()
    }
  }, [streamerId])

  /**
   * ストリーマー情報とそのカード一覧を取得
   */
  async function fetchStreamerAndCards() {
    // streamerIdが未定義の場合は処理しない
    if (!streamerId) return

    setLoading(true)
    try {
      // ストリーマー情報とカード一覧を並列取得
      const [streamerResult, cardsResult] = await Promise.all([
        supabase
          .from('streamers')
          .select('*')
          .eq('id', streamerId)
          .single(),
        supabase
          .from('cards')
          .select('*')
          .eq('streamer_id', streamerId)
          .order('rarity', { ascending: false }) // レアリティ順（legendary優先）
          .order('created_at', { ascending: false })
          .range(0, 9999), // 最大10000件まで取得（Supabaseのデフォルト制限回避）
      ])

      if (streamerResult.error) {
        console.error('Streamer not found:', streamerResult.error)
        return
      }
      if (cardsResult.error) {
        console.error('Cards fetch error:', cardsResult.error)
      }

      setStreamer(streamerResult.data as Streamer)
      setCards((cardsResult.data || []) as Card[])
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  /**
   * 画像URLをクリップボードにコピー
   * コピー成功時は一時的にフィードバックを表示
   */
  const copyToClipboard = async (url: string, cardId: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(cardId)
      // 2秒後にフィードバックをリセット
      setTimeout(() => setCopiedId(null), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  // テーブルのカラム定義
  // NOTE: cardsテーブルにはステータス・スキル情報が存在しないため、基本情報のみ表示
  const columns = [
    {
      key: 'image',
      header: '画像',
      render: (card: Card) => (
        <div className="flex items-center">
          {card.image_url ? (
            <img
              src={card.image_url}
              alt={card.name}
              className="w-12 h-12 rounded object-cover"
            />
          ) : (
            <div className="w-12 h-12 rounded bg-gray-200 flex items-center justify-center">
              <span className="text-gray-400">🃏</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'name',
      header: 'カード名',
      render: (card: Card) => (
        <div>
          <p className="font-medium text-gray-900">{card.name}</p>
          {card.description && (
            <p
              className={`text-xs text-gray-500 cursor-pointer hover:text-gray-700 ${
                !expandedDescriptions.has(card.id) ? 'truncate max-w-xs' : ''
              }`}
              onClick={(e) => {
                // 親要素への伝播を防止（行クリックイベント等と干渉しないように）
                e.stopPropagation()
                toggleDescription(card.id)
              }}
              title={!expandedDescriptions.has(card.id) ? 'クリックで全文表示' : 'クリックで折りたたむ'}
            >
              {card.description}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'rarity',
      header: 'レアリティ',
      render: (card: Card) => <RarityBadge rarity={card.rarity} />,
    },
    {
      key: 'drop_rate',
      header: 'ドロップ率',
      render: (card: Card) => (
        <span className="text-sm">{(card.drop_rate * 100).toFixed(1)}%</span>
      ),
    },
    {
      key: 'is_active',
      header: '状態',
      render: (card: Card) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            card.is_active
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {card.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'image_url',
      header: '画像URL',
      render: (card: Card) => (
        <div className="max-w-xs">
          {card.image_url ? (
            <div className="flex items-center space-x-1">
              {/* URLを省略表示（クリックでコピー） */}
              <button
                onClick={() => copyToClipboard(card.image_url!, card.id)}
                className="text-xs text-blue-600 hover:text-blue-800 truncate max-w-[200px] text-left"
                title={card.image_url}
              >
                {card.image_url}
              </button>
              {/* コピーボタン */}
              <button
                onClick={() => copyToClipboard(card.image_url!, card.id)}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  copiedId === card.id
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {copiedId === card.id ? 'Copied!' : 'Copy'}
              </button>
            </div>
          ) : (
            <span className="text-xs text-gray-400">未設定</span>
          )}
        </div>
      ),
    },
    {
      key: 'created_at',
      header: '作成日',
      render: (card: Card) => (
        <span className="text-xs text-gray-500">
          {new Date(card.created_at).toLocaleDateString('ja-JP')}
        </span>
      ),
    },
  ]

  // レアリティごとのカード数を集計
  const rarityCount = cards.reduce(
    (acc, card) => {
      acc[card.rarity] = (acc[card.rarity] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          {/* 戻るボタン */}
          <button
            onClick={() => navigate('/streamers')}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Streamers一覧に戻る"
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
                  {streamer.twitch_display_name} のカード一覧
                </h1>
                <p className="text-gray-500">@{streamer.twitch_username}</p>
              </div>
            </div>
          )}
        </div>
        {/* Twitchリンク */}
        {streamer && (
          <a
            href={`https://twitch.tv/${streamer.twitch_username}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
          >
            Twitchで見る ↗
          </a>
        )}
      </div>

      {/* サマリー統計 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総カード数</p>
          <p className="text-2xl font-bold">{cards.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-amber-400">
          <p className="text-sm text-gray-500">Legendary</p>
          <p className="text-2xl font-bold text-amber-600">
            {rarityCount['legendary'] || 0}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-purple-400">
          <p className="text-sm text-gray-500">Epic</p>
          <p className="text-2xl font-bold text-purple-600">
            {rarityCount['epic'] || 0}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-400">
          <p className="text-sm text-gray-500">Rare</p>
          <p className="text-2xl font-bold text-blue-600">
            {rarityCount['rare'] || 0}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-gray-400">
          <p className="text-sm text-gray-500">Common</p>
          <p className="text-2xl font-bold text-gray-600">
            {rarityCount['common'] || 0}
          </p>
        </div>
      </div>

      {/* カード一覧テーブル */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">登録カード詳細</h2>
          <p className="text-sm text-gray-500">
            画像URLはクリックまたはCopyボタンでコピーできます
          </p>
        </div>
        <DataTable
          columns={columns}
          data={cards}
          keyExtractor={(card) => card.id}
          loading={loading}
          emptyMessage="カードが登録されていません"
        />
      </div>
    </div>
  )
}
