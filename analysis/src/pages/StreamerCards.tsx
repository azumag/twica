import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { adminApi } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { RarityBadge } from '../components/RarityBadge'
import { Streamer, Card } from '../types/database'

const PAGE_SIZE_OPTIONS = [20, 50, 100]

// レアリティ集計用サマリー取得の上限件数。
// 従来の .range(0, 9999) と同じ上限を維持する（新規バックエンドエンドポイントは追加しない）。
const SUMMARY_FETCH_SIZE = 10000

/**
 * StreamerCards - ストリーマーが登録しているカード一覧ページ
 * URLパラメータからストリーマーIDを取得し、そのストリーマーのカード詳細を表示
 * 画像URL、ステータス、スキル情報など全ての登録情報を確認可能
 */
export function StreamerCards() {
  const { streamerId } = useParams<{ streamerId: string }>()
  const navigate = useNavigate()
  const [streamer, setStreamer] = useState<Streamer | null>(null)

  // --- テーブル用（サーバーサイドページネーション） ---
  const [cards, setCards] = useState<Card[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [streamerError, setStreamerError] = useState<string | null>(null)
  const [cardsError, setCardsError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更すると対応するeffectを再実行させる）
  const [streamerRetryToken, setStreamerRetryToken] = useState(0)
  const [cardsRetryToken, setCardsRetryToken] = useState(0)

  // --- レアリティ別サマリー統計用（ページングとは独立させ、常に全件ベースの正確な数値を保つ） ---
  const [allCards, setAllCards] = useState<Card[]>([])
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryRetryToken, setSummaryRetryToken] = useState(0)

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

  /**
   * ストリーマー情報を取得
   */
  async function fetchStreamer(signal: AbortSignal) {
    if (!streamerId) return
    setStreamerError(null)
    try {
      const data = await adminApi.getStreamer(streamerId, { signal })
      setStreamer(data)
    } catch (err) {
      if (signal.aborted) return
      console.error('Error fetching streamer:', err)
      setStreamerError((err instanceof Error && err.message) || 'ストリーマー情報の取得に失敗しました')
    }
  }

  /**
   * カード一覧（現在ページ分）をサーバーサイドページネーションで取得
   * page を引数で明示的に受け取る: streamerId変更時に「ページを1に戻すeffect」と
   * 「取得effect」が同一コミット内でcurrentPageのstate更新を共有できず、
   * 前ストリーマーのページ番号のまま新ストリーマーを取得してしまう競合を避けるため
   */
  async function fetchCardsPage(page: number, signal: AbortSignal) {
    if (!streamerId) return
    setLoading(true)
    setCardsError(null)
    try {
      const { rows, count } = await adminApi.getStreamerCards({ streamerId, page, pageSize }, { signal })
      setCards(rows)
      setTotalCount(count)
    } catch (err) {
      if (signal.aborted) return
      console.error('Cards fetch error:', err)
      setCardsError((err instanceof Error && err.message) || 'カード一覧の取得に失敗しました')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }

  /**
   * レアリティ別サマリー統計用に全カード（最大SUMMARY_FETCH_SIZE件）を取得。
   * 既存エンドポイントのみを使う制約のため、専用の集計APIではなくgetStreamerCardsを
   * 大きいpageSizeで呼び出す形で対応（テーブル表示用のページングとは別リクエスト）。
   */
  async function fetchAllCardsForSummary(signal: AbortSignal) {
    if (!streamerId) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const { rows } = await adminApi.getStreamerCards(
        {
          streamerId,
          page: 1,
          pageSize: SUMMARY_FETCH_SIZE,
        },
        { signal }
      )
      setAllCards(rows)
    } catch (err) {
      if (signal.aborted) return
      console.error('Cards summary fetch error:', err)
      setSummaryError((err instanceof Error && err.message) || 'サマリー統計の取得に失敗しました')
    } finally {
      if (!signal.aborted) setSummaryLoading(false)
    }
  }

  useEffect(() => {
    if (!streamerId) return
    // streamerIdを素早く連続変更すると後発リクエストと先発リクエストが競合しうるため、
    // AbortControllerで先発リクエスト自体を中断する
    const controller = new AbortController()
    fetchStreamer(controller.signal)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamerId, streamerRetryToken])

  // streamerId変更時はページを1に戻して取得する。setCurrentPage(1)とfetchCardsPage()を
  // 別々のeffectに分けると、同一コミット内では新しいcurrentPageがまだ反映されず
  // 前ストリーマーのページ番号で新ストリーマーを取得する一過性の誤フェッチが発生するため、
  // prevStreamerIdRefでstreamerId変更を検知する1本のeffectにまとめる。
  // currentPageが1でなかった場合はsetCurrentPage(1)だけ行ってこのpassでは取得せず、
  // 1に更新された次のpassで(streamerIdChanged=false, currentPage=1)として単発取得する
  // (即時fetchCardsPage(1)も呼ぶと、リセット後の再発火と合わせて同一ページを二重取得してしまうため)
  const prevStreamerIdRef = useRef(streamerId)
  useEffect(() => {
    if (!streamerId) return

    const streamerIdChanged = prevStreamerIdRef.current !== streamerId
    prevStreamerIdRef.current = streamerId

    if (streamerIdChanged && currentPage !== 1) {
      setCurrentPage(1)
      return
    }

    const controller = new AbortController()
    fetchCardsPage(currentPage, controller.signal)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamerId, currentPage, pageSize, cardsRetryToken])

  useEffect(() => {
    if (!streamerId) return
    const controller = new AbortController()
    fetchAllCardsForSummary(controller.signal)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamerId, summaryRetryToken])

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

  // レアリティごとのカード数を集計（ページングとは独立した全件取得結果から算出）
  const rarityCount = allCards.reduce(
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
        {/* アクションボタン群 */}
        {streamer && (
          <div className="flex items-center space-x-2">
            {/* ガチャ履歴ページへのリンク */}
            <button
              onClick={() => navigate(`/streamers/${streamerId}/gacha`)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              ガチャ履歴
            </button>
            {/* Twitchリンク */}
            <a
              href={`https://twitch.tv/${streamer.twitch_username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
            >
              Twitchで見る ↗
            </a>
          </div>
        )}
      </div>

      <ErrorBanner
        messages={[streamerError, cardsError, summaryError]}
        onRetry={() => {
          setStreamerRetryToken((t) => t + 1)
          setCardsRetryToken((t) => t + 1)
          setSummaryRetryToken((t) => t + 1)
        }}
      />

      {/* サマリー統計 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総カード数</p>
          <p className="text-2xl font-bold">{totalCount}</p>
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
      {/* レアリティ集計は上限件数まで（従来のrange(0,9999)と同じ制約）のため、超過時は注記 */}
      {!summaryLoading && allCards.length >= SUMMARY_FETCH_SIZE && (
        <p className="text-xs text-amber-600">
          ※ レアリティ内訳は先頭{SUMMARY_FETCH_SIZE.toLocaleString()}件からの算出です（総カード数は正確な値です）。
        </p>
      )}

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
          pagination={{
            currentPage,
            pageSize,
            totalItems: totalCount,
            onPageChange: setCurrentPage,
            onPageSizeChange: (size) => {
              setPageSize(size)
              setCurrentPage(1)
            },
            pageSizeOptions: PAGE_SIZE_OPTIONS,
          }}
        />
      </div>
    </div>
  )
}
