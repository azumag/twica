import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { StreamerPopup } from '../components/StreamerPopup'
import { Streamer } from '../types/database'

// チャット通知の送信に必要なTwitch OAuthスコープ
const CHAT_WRITE_SCOPE = 'user:write:chat'

// 投票キャンペーンの識別子（2026選挙応援キャンペーン）
// キャンペーン終了後はこの定数とクエリを削除すること
const VOTE_CAMPAIGN_TYPE = 'campaign' as const
const VOTE_CAMPAIGN_MEMO = '2026選挙応援' as const

/**
 * SHA-256ハッシュの先頭8文字を取得（ユーザープレフィックス用）
 * blob_filesテーブルのuser_prefixと同じ方式で生成
 * アップロード時にsha256Prefix(twitchUserId)でプレフィックスが生成されるため、
 * ストリーマーのtwitch_user_idから同じプレフィックスを計算して突き合わせる
 */
async function sha256Prefix(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(data)
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hash.substring(0, 8)
}

// Extended streamer type with card statistics and storage usage
// ストリーマーのカード統計とストレージ使用量を含む拡張型
interface StreamerWithStats extends Streamer {
  card_count: number
  // ストレージ使用量（バイト単位）- blob_filesのuser_prefix集計による実使用量
  storage_bytes: number
  // usersテーブルのtwitch_scopesにuser:write:chatが含まれているか
  // チャット通知の送信にはこのスコープが必要
  has_chat_scope: boolean
  // 投票キャンペーンボーナスを有効化しているか
  has_vote_campaign_bonus: boolean
}

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

/**
 * Supabaseの1000行デフォルト制限を回避するバッチ取得ヘルパー
 * 1000行ずつ.range()で取得し、全行を結合して返す
 * buildQueryは呼び出すたびに新しいクエリを生成する関数（.range()は自動付与）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllPaged(buildQuery: () => any): Promise<{ data: any[]; error: any }> {
  const BATCH_SIZE = 1000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery().range(from, from + BATCH_SIZE - 1)
    if (error) return { data: all, error }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < BATCH_SIZE) break
    from += BATCH_SIZE
  }
  return { data: all, error: null }
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

  useEffect(() => {
    fetchStreamers()
  }, [])

  // フィルター条件が変わったらページを1に戻す
  useEffect(() => {
    setCurrentPage(1)
  }, [sortOrder, hideZeroCards, filterChatEnabled, filterHasTemplate, filterMissingScope, filterVoteCampaign, searchQuery])

  /**
   * Fetches all streamers with card counts and storage usage
   * Supabaseのリレーション機能を使って効率的にカード数を取得
   * ストレージ使用量はstorage_usageテーブル（集計済み）から取得
   * 本番のstorage-status APIと同じデータソースを使用することで正確な値を表示
   * blob_filesの全行再集計ではSupabaseのデフォルト行数上限(1000行)で途中切れが発生するため不採用
   */
  async function fetchStreamers() {
    setLoading(true)
    try {
      // ストリーマーとstorage_usageとstorage_bonusを並行取得（第1段階）
      // cards(count) はカード数のみ取得
      // storage_usageはuser_prefixごとの集計済みバイト数を保持（本番APIと同じデータソース）
      // streamer_storage_bonusから投票キャンペーンボーナス適用済みストリーマーを取得
      // fetchAllPagedで1000行制限を回避して全行取得
      const [streamersResult, storageUsageResult, storageBonusResult] = await Promise.all([
        fetchAllPaged(() =>
          supabase.from('streamers').select('*, cards(count)')
            .order('created_at', { ascending: false })
            .order('id', { ascending: true }) // 安定ソート: created_atが同一の場合にページ間で行の重複/欠落を防ぐ
        ),
        fetchAllPaged(() =>
          supabase.from('storage_usage').select('user_prefix, bytes_used').neq('user_prefix', '_global_')
        ),
        fetchAllPaged(() =>
          supabase.from('streamer_storage_bonus').select('streamer_id').eq('type', VOTE_CAMPAIGN_TYPE).eq('memo', VOTE_CAMPAIGN_MEMO)
        ),
      ])

      // 全てのクエリのエラーチェック
      if (streamersResult.error) throw streamersResult.error
      if (storageUsageResult.error) {
        console.error('Failed to fetch storage usage:', storageUsageResult.error)
        // 続行は可能だが、ストレージ情報が0になることを記録
      }
      if (storageBonusResult.error) {
        console.error('Failed to fetch vote campaign bonus:', storageBonusResult.error)
        // 続行は可能だが、投票キャンペーン情報が空になることを記録
      }

      // ストリーマーのtwitch_user_id一覧を抽出して、対応するusersのみクエリする（第2段階）
      const streamerTwitchIds = (streamersResult.data || []).map(
        (s: { twitch_user_id: string }) => s.twitch_user_id
      )
      // ストリーマー数が多い場合、in()のURLサイズ制限とSupabase行数制限を回避するためバッチ取得
      // 各バッチは並列実行でパフォーマンスを確保
      const userScopesByTwitchId = new Map<string, string[]>()
      if (streamerTwitchIds.length > 0) {
        const IN_BATCH_SIZE = 500
        const batches: string[][] = []
        for (let i = 0; i < streamerTwitchIds.length; i += IN_BATCH_SIZE) {
          batches.push(streamerTwitchIds.slice(i, i + IN_BATCH_SIZE))
        }
        const batchResults = await Promise.all(
          batches.map((batch) =>
            supabase.from('users').select('twitch_user_id, twitch_scopes').in('twitch_user_id', batch)
          )
        )
        for (const usersResult of batchResults) {
          if (usersResult.error) {
            console.warn('Users query error (twitch_scopes取得失敗):', usersResult.error)
            continue
          }
          const users = (usersResult.data || []) as { twitch_user_id: string; twitch_scopes: string[] }[]
          users.forEach((user) => {
            userScopesByTwitchId.set(user.twitch_user_id, user.twitch_scopes || [])
          })
        }
        console.log(`Streamer users with scopes loaded: ${userScopesByTwitchId.size}/${streamerTwitchIds.length}件`)
      }

      // storage_usageテーブルからuser_prefixごとの使用量Mapを構築
      // storage_usageはアップロード/削除時にRPCで自動更新される集計済みテーブルのため、
      // blob_filesの全行スキャン（1000行制限あり）より正確かつ高速
      const storageUsageData = (storageUsageResult.data || []) as { user_prefix: string; bytes_used: number }[]
      const storageSizeByPrefix = new Map<string, number>()
      storageUsageData.forEach((row) => {
        storageSizeByPrefix.set(row.user_prefix, row.bytes_used)
      })

      // 投票キャンペーン適用済みストリーマーのIDセット構築
      const voteCampaignBonusData = (storageBonusResult.data || []) as { streamer_id: string }[]
      const voteCampaignStreamerIdSet = new Set(
        voteCampaignBonusData.map(row => row.streamer_id)
      )

      // 各ストリーマーのtwitch_user_idからSHA256プレフィックスを計算
      // storage_usageのuser_prefixと突き合わせるために必要
      const prefixByTwitchId = new Map<string, string>()
      await Promise.all(
        streamerTwitchIds.map(async (twitchId: string) => {
          const prefix = await sha256Prefix(twitchId)
          prefixByTwitchId.set(twitchId, prefix)
        })
      )

      // 型定義: Supabaseのリレーション結果の形式
      type StreamerWithRelations = Streamer & {
        cards: { count: number }[]
      }

      // Supabaseのリレーション結果を変換
      const rawData = streamersResult.data as unknown as StreamerWithRelations[]
      const streamersWithStats: StreamerWithStats[] = (rawData || []).map((streamer) => {
        // Supabaseのリレーションカウントは { count: number } の配列として返る
        const cardCount = streamer.cards?.[0]?.count ?? 0

        // user_prefix（SHA256先頭8文字）でblob_filesの合計サイズを参照
        const userPrefix = prefixByTwitchId.get(streamer.twitch_user_id) || ''
        const storageBytes = storageSizeByPrefix.get(userPrefix) || 0

        // ストリーマーに対応するユーザーのスコープを確認
        // user:write:chat スコープがあればチャット通知の送信権限あり
        const userScopes = userScopesByTwitchId.get(streamer.twitch_user_id) || []
        const hasChatScope = userScopes.includes(CHAT_WRITE_SCOPE)

        // 投票キャンペーンボーナスの有無を確認
        const hasVoteCampaignBonus = voteCampaignStreamerIdSet.has(streamer.id)

        return {
          id: streamer.id,
          twitch_user_id: streamer.twitch_user_id,
          twitch_username: streamer.twitch_username,
          twitch_display_name: streamer.twitch_display_name,
          twitch_profile_image_url: streamer.twitch_profile_image_url,
          channel_point_reward_id: streamer.channel_point_reward_id,
          channel_point_reward_name: streamer.channel_point_reward_name,
          is_active: streamer.is_active,
          gacha_sound_url: streamer.gacha_sound_url,
          gacha_sound_enabled: streamer.gacha_sound_enabled,
          chat_announcement_enabled: streamer.chat_announcement_enabled,
          chat_announcement_template: streamer.chat_announcement_template,
          created_at: streamer.created_at,
          updated_at: streamer.updated_at,
          card_count: cardCount,
          storage_bytes: storageBytes,
          has_chat_scope: hasChatScope,
          has_vote_campaign_bonus: hasVoteCampaignBonus,
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
      // 通知ONなのにuser:write:chatスコープが無い場合は警告アイコンを表示
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
          {/* 通知ONだが権限がない場合に警告表示 */}
          {streamer.chat_announcement_enabled && !streamer.has_chat_scope && (
            <span
              className="text-amber-500"
              title="通知ONですがuser:write:chatスコープが未付与のため送信できません"
            >
              ⚠
            </span>
          )}
        </div>
      ),
    },
    {
      // Chat権限(user:write:chatスコープ)の有無を表示するカラム
      // usersテーブルのtwitch_scopesから判定
      key: 'chat_scope',
      header: 'Chat権限',
      render: (streamer: StreamerWithStats) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.has_chat_scope
              ? 'bg-blue-100 text-blue-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {streamer.has_chat_scope ? '付与済み' : '未付与'}
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
  // Chat通知ONだがuser:write:chatスコープが未付与のストリーマー数（要対応）
  const chatEnabledNoScope = streamers.filter((s) => s.chat_announcement_enabled && !s.has_chat_scope).length
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

    // フィルター: Chat通知ONだが権限(user:write:chat)未付与のストリーマーのみ表示
    if (filterMissingScope) {
      result = result.filter((s) => s.chat_announcement_enabled && !s.has_chat_scope)
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

      {/* Chat通知ONなのに権限がないストリーマーがいる場合に警告バナーを表示 */}
      {chatEnabledNoScope > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-3">
          <span className="text-amber-500 text-xl">⚠</span>
          <div>
            <p className="text-sm font-medium text-amber-800">
              Chat通知ONだが権限(user:write:chat)が未付与: {chatEnabledNoScope}件
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              該当ストリーマーはチャット通知が送信されません。再認証が必要です。
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

          {/* Chat通知ONだが権限未付与のみ表示トグル */}
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterMissingScope}
              onChange={(e) => setFilterMissingScope(e.target.checked)}
              className="w-4 h-4 text-amber-500 border-gray-300 rounded focus:ring-amber-500"
            />
            <span className="text-sm text-amber-600 font-medium">
              通知ON・権限なし
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
