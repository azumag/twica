import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { RarityBadge } from '../components/RarityBadge'
import { User, Card, Streamer } from '../types/database'

// ユーザーが所持しているカードの詳細情報
interface UserCardWithDetails {
  id: string
  card_id: string
  obtained_at: string
  card: Card
  streamer: Streamer | null
}

/**
 * UserCards - ユーザーが取得したカード一覧ページ
 * URLパラメータからユーザーIDを取得し、そのユーザーが所持するカード詳細を表示
 */
export function UserCards() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [userCards, setUserCards] = useState<UserCardWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
    if (userId) {
      fetchUserAndCards()
    } else {
      setError('ユーザーIDが指定されていません')
      setLoading(false)
    }
  }, [userId])

  /**
   * ユーザー情報とそのカード一覧を取得
   */
  async function fetchUserAndCards() {
    if (!userId) return

    setLoading(true)
    try {
      // ユーザー情報を取得
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single()

      if (userError) {
        console.error('User not found:', userError)
        setError(`ユーザーが見つかりません: ${userError.message}`)
        setLoading(false)
        return
      }

      setUser(userData as User)

      // ユーザーのカード一覧を取得（カード情報も結合）
      // NOTE: cardsテーブルの実際のカラムに合わせてクエリを修正
      const { data: userCardsData, error: cardsError } = await supabase
        .from('user_cards')
        .select(`
          id,
          card_id,
          obtained_at,
          cards (
            id,
            streamer_id,
            name,
            description,
            image_url,
            rarity,
            drop_rate,
            is_active,
            created_at,
            updated_at
          )
        `)
        .eq('user_id', userId)
        .order('obtained_at', { ascending: false })
        .range(0, 9999)

      if (cardsError) {
        console.error('Cards fetch error:', cardsError)
      }

      // ストリーマー情報を取得
      const { data: streamersData } = await supabase
        .from('streamers')
        .select('*')

      const streamersMap = new Map<string, Streamer>()
      const streamersArray = (streamersData || []) as Streamer[]
      streamersArray.forEach((s) => {
        streamersMap.set(s.id, s)
      })

      // データを整形
      const cardsWithDetails: UserCardWithDetails[] = ((userCardsData || []) as unknown as {
        id: string
        card_id: string
        obtained_at: string
        cards: Card
      }[]).map((uc) => ({
        id: uc.id,
        card_id: uc.card_id,
        obtained_at: uc.obtained_at,
        card: uc.cards,
        streamer: uc.cards ? streamersMap.get(uc.cards.streamer_id) || null : null,
      }))

      setUserCards(cardsWithDetails)
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  // テーブルのカラム定義
  // NOTE: cardsテーブルにはステータス・スキル情報が存在しないため、基本情報のみ表示
  const columns = [
    {
      key: 'image',
      header: '画像',
      render: (uc: UserCardWithDetails) => (
        <div className="flex items-center">
          {uc.card?.image_url ? (
            <img
              src={uc.card.image_url}
              alt={uc.card.name}
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
      render: (uc: UserCardWithDetails) => (
        <div>
          <p className="font-medium text-gray-900">{uc.card?.name || 'Unknown'}</p>
          {uc.card?.description && (
            <p
              className={`text-xs text-gray-500 cursor-pointer hover:text-gray-700 ${
                !expandedDescriptions.has(uc.id) ? 'truncate max-w-xs' : ''
              }`}
              onClick={(e) => {
                // 親要素への伝播を防止（行クリックイベント等と干渉しないように）
                e.stopPropagation()
                toggleDescription(uc.id)
              }}
              title={!expandedDescriptions.has(uc.id) ? 'クリックで全文表示' : 'クリックで折りたたむ'}
            >
              {uc.card.description}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'streamer',
      header: 'ストリーマー',
      render: (uc: UserCardWithDetails) => (
        <div className="flex items-center space-x-2">
          {uc.streamer?.twitch_profile_image_url ? (
            <img
              src={uc.streamer.twitch_profile_image_url}
              alt={uc.streamer.twitch_display_name}
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center">
              <span className="text-purple-600 text-xs">🎮</span>
            </div>
          )}
          <span className="text-sm text-gray-700">
            {uc.streamer?.twitch_display_name || 'Unknown'}
          </span>
        </div>
      ),
    },
    {
      key: 'rarity',
      header: 'レアリティ',
      render: (uc: UserCardWithDetails) =>
        uc.card ? <RarityBadge rarity={uc.card.rarity} /> : <span>-</span>,
    },
    {
      key: 'drop_rate',
      header: 'ドロップ率',
      render: (uc: UserCardWithDetails) =>
        uc.card ? (
          <span className="text-sm">{(uc.card.drop_rate * 100).toFixed(1)}%</span>
        ) : (
          <span>-</span>
        ),
    },
    {
      key: 'obtained_at',
      header: '取得日時',
      render: (uc: UserCardWithDetails) => (
        <span className="text-xs text-gray-500">
          {new Date(uc.obtained_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
  ]

  // レアリティごとのカード数を集計
  const rarityCount = userCards.reduce(
    (acc, uc) => {
      if (uc.card) {
        acc[uc.card.rarity] = (acc[uc.card.rarity] || 0) + 1
      }
      return acc
    },
    {} as Record<string, number>
  )

  // ストリーマーごとのカード数を集計
  const streamerCount = userCards.reduce(
    (acc, uc) => {
      const name = uc.streamer?.twitch_display_name || 'Unknown'
      acc[name] = (acc[name] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  // エラー表示
  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate('/users')}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <span className="text-gray-600">← 戻る</span>
          </button>
          <h1 className="text-2xl font-bold text-gray-900">エラー</h1>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          {/* 戻るボタン */}
          <button
            onClick={() => navigate('/users')}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Users一覧に戻る"
          >
            <span className="text-gray-600">← 戻る</span>
          </button>
          {/* ユーザー情報 */}
          {user && (
            <div className="flex items-center space-x-3">
              {user.twitch_profile_image_url ? (
                <img
                  src={user.twitch_profile_image_url}
                  alt={user.twitch_display_name}
                  className="w-12 h-12 rounded-full"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                  <span className="text-gray-500 text-lg">👤</span>
                </div>
              )}
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {user.twitch_display_name} のカード一覧
                </h1>
                <p className="text-gray-500">@{user.twitch_username}</p>
              </div>
            </div>
          )}
        </div>
        {/* Twitchリンク */}
        {user && (
          <a
            href={`https://twitch.tv/${user.twitch_username}`}
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
          <p className="text-2xl font-bold">{userCards.length}</p>
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

      {/* ストリーマー別カード数 */}
      {Object.keys(streamerCount).length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">
            ストリーマー別カード数
          </h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(streamerCount)
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => (
                <span
                  key={name}
                  className="px-2 py-1 bg-gray-100 rounded text-sm text-gray-700"
                >
                  {name}: {count}枚
                </span>
              ))}
          </div>
        </div>
      )}

      {/* カード一覧テーブル */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">所持カード詳細</h2>
          <p className="text-sm text-gray-500">取得日時が新しい順に表示</p>
        </div>
        <DataTable
          columns={columns}
          data={userCards}
          keyExtractor={(uc) => uc.id}
          loading={loading}
          emptyMessage="カードを所持していません"
        />
      </div>
    </div>
  )
}
