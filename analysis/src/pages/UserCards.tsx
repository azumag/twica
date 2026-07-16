import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { adminApi } from '../lib/adminApi'
import type { UserCardCountEntry, UserCardsTableRow } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import { RarityBadge } from '../components/RarityBadge'
import { User } from '../types/database'

const PAGE_SIZE_OPTIONS = [20, 50, 100]

/**
 * UserCards - ユーザーが取得したカード一覧ページ
 * URLパラメータからユーザーIDを取得し、そのユーザーが所持するカード詳細を表示
 *
 * データ取得は2系統に分離:
 * - サマリー（ユーザー情報 + カード種別ごとの所持数）: adminApi.getUserCardsSummary
 * - カード詳細テーブル（コピー単位、サーバーサイドページネーション）: adminApi.getUserCardsTable
 */
export function UserCards() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()

  // --- サマリー用 state（ユーザー情報 + レアリティ/ストリーマー別集計） ---
  const [user, setUser] = useState<User | null>(null)
  const [cardCounts, setCardCounts] = useState<UserCardCountEntry[]>([])
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更すると対応するeffectを再実行させる）
  const [summaryRetryToken, setSummaryRetryToken] = useState(0)

  // --- テーブル用 state（カード所持詳細、ページネーション） ---
  const [tableRows, setTableRows] = useState<UserCardsTableRow[]>([])
  const [tableCount, setTableCount] = useState(0)
  const [tableLoading, setTableLoading] = useState(true)
  const [tableError, setTableError] = useState<string | null>(null)
  const [tableRetryToken, setTableRetryToken] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

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
   * ユーザー情報とカード所持サマリー（種別ごとの所持数）を取得
   */
  async function fetchSummary(signal: AbortSignal) {
    if (!userId) return

    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const data = await adminApi.getUserCardsSummary(userId, { signal })
      setUser(data.user)
      setCardCounts(data.cardCounts)
    } catch (err) {
      if (signal.aborted) return
      console.error('Failed to fetch user cards summary:', err)
      setSummaryError((err instanceof Error && err.message) || 'ユーザー情報の取得に失敗しました')
    } finally {
      if (!signal.aborted) setSummaryLoading(false)
    }
  }

  /**
   * 所持カード詳細（コピー単位）をページネーション付きで取得
   * page を引数で明示的に受け取る: userId変更時に「ページを1に戻すeffect」と
   * 「取得effect」が同一コミット内でcurrentPageのstate更新を共有できず、
   * 前ユーザーのページ番号のまま新ユーザーを取得してしまう競合を避けるため
   */
  async function fetchTable(page: number, signal: AbortSignal) {
    if (!userId) return

    setTableLoading(true)
    setTableError(null)
    try {
      const { rows, count } = await adminApi.getUserCardsTable({ userId, page, pageSize }, { signal })
      setTableRows(rows)
      setTableCount(count)
    } catch (err) {
      if (signal.aborted) return
      console.error('Failed to fetch user cards table:', err)
      setTableError((err instanceof Error && err.message) || 'カード一覧の取得に失敗しました')
    } finally {
      if (!signal.aborted) setTableLoading(false)
    }
  }

  useEffect(() => {
    if (!userId) {
      setSummaryError('ユーザーIDが指定されていません')
      setSummaryLoading(false)
      setTableLoading(false)
      return
    }
    // userIdを素早く連続変更すると後発リクエストと先発リクエストが競合しうるため、
    // AbortControllerで先発リクエスト自体を中断する
    const controller = new AbortController()
    fetchSummary(controller.signal)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, summaryRetryToken])

  // userId変更時はページを1に戻して取得する。setCurrentPage(1)とfetchTable()を
  // 別々のeffectに分けると、同一コミット内では新しいcurrentPageがまだ反映されず
  // 前ユーザーのページ番号で新ユーザーを取得する一過性の誤フェッチが発生するため、
  // prevUserIdRefでuserId変更を検知する1本のeffectにまとめる。
  // currentPageが1でなかった場合はsetCurrentPage(1)だけ行ってこのpassでは取得せず、
  // 1に更新された次のpassで(userIdChanged=false, currentPage=1)として単発取得する
  // (即時fetchTable(1)も呼ぶと、リセット後の再発火と合わせて同一ページを二重取得してしまうため)
  const prevUserIdRef = useRef(userId)
  useEffect(() => {
    if (!userId) return

    const userIdChanged = prevUserIdRef.current !== userId
    prevUserIdRef.current = userId

    if (userIdChanged && currentPage !== 1) {
      setCurrentPage(1)
      return
    }

    const controller = new AbortController()
    fetchTable(currentPage, controller.signal)
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, currentPage, pageSize, tableRetryToken])

  // テーブルのカラム定義
  // NOTE: cardsテーブルにはステータス・スキル情報が存在しないため、基本情報のみ表示
  const columns = [
    {
      key: 'image',
      header: '画像',
      render: (row: UserCardsTableRow) => (
        <div className="flex items-center">
          {row.cards?.image_url ? (
            <img
              src={row.cards.image_url}
              alt={row.cards.name}
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
      render: (row: UserCardsTableRow) => (
        <div>
          <p className="font-medium text-gray-900">{row.cards?.name || 'Unknown'}</p>
          {row.cards?.description && (
            <p
              className={`text-xs text-gray-500 cursor-pointer hover:text-gray-700 ${
                !expandedDescriptions.has(row.id) ? 'truncate max-w-xs' : ''
              }`}
              onClick={(e) => {
                // 親要素への伝播を防止（行クリックイベント等と干渉しないように）
                e.stopPropagation()
                toggleDescription(row.id)
              }}
              title={!expandedDescriptions.has(row.id) ? 'クリックで全文表示' : 'クリックで折りたたむ'}
            >
              {row.cards.description}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'streamer',
      header: 'ストリーマー',
      render: (row: UserCardsTableRow) => (
        <div className="flex items-center space-x-2">
          {row.streamer?.twitch_profile_image_url ? (
            <img
              src={row.streamer.twitch_profile_image_url}
              alt={row.streamer.twitch_display_name}
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center">
              <span className="text-purple-600 text-xs">🎮</span>
            </div>
          )}
          <span className="text-sm text-gray-700">
            {row.streamer?.twitch_display_name || 'Unknown'}
          </span>
        </div>
      ),
    },
    {
      key: 'rarity',
      header: 'レアリティ',
      render: (row: UserCardsTableRow) =>
        row.cards ? <RarityBadge rarity={row.cards.rarity} /> : <span>-</span>,
    },
    {
      key: 'drop_rate',
      header: 'ドロップ率',
      render: (row: UserCardsTableRow) =>
        row.cards ? (
          <span className="text-sm">{(row.cards.drop_rate * 100).toFixed(1)}%</span>
        ) : (
          <span>-</span>
        ),
    },
    {
      key: 'obtained_at',
      header: '取得日時',
      render: (row: UserCardsTableRow) => (
        <span className="text-xs text-gray-500">
          {new Date(row.obtained_at).toLocaleString('ja-JP')}
        </span>
      ),
    },
  ]

  // 総所持カード数（コピー数含む）: 各エントリのcountを合算
  const totalCards = cardCounts.reduce((sum, entry) => sum + entry.count, 0)

  // レアリティごとのカード数を集計（コピー数を反映するためentry.countを加算）
  const rarityCount = cardCounts.reduce(
    (acc, entry) => {
      acc[entry.card.rarity] = (acc[entry.card.rarity] || 0) + entry.count
      return acc
    },
    {} as Record<string, number>
  )

  // ストリーマーごとのカード数を集計（コピー数を反映するためentry.countを加算）
  const streamerCount = cardCounts.reduce(
    (acc, entry) => {
      const name = entry.streamer?.twitch_display_name || 'Unknown'
      acc[name] = (acc[name] || 0) + entry.count
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

      <ErrorBanner
        messages={[summaryError, tableError]}
        onRetry={() => {
          setSummaryRetryToken((t) => t + 1)
          setTableRetryToken((t) => t + 1)
        }}
      />

      {/* サマリー統計 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">総カード数</p>
          <p className="text-2xl font-bold">{totalCards}</p>
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
      {!summaryLoading && Object.keys(streamerCount).length > 0 && (
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
          data={tableRows}
          keyExtractor={(row) => row.id}
          loading={tableLoading}
          emptyMessage="カードを所持していません"
          pagination={{
            currentPage,
            pageSize,
            totalItems: tableCount,
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
