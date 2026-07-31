import { useEffect, useState, useCallback, Fragment } from 'react'
import { adminApi } from '../lib/adminApi'
import { RarityBadge } from './RarityBadge'
import { Rarity } from '../types/database'

interface DropRateStatsProps {
  streamerId: string
  timeRange: '7d' | '30d' | '90d' | 'all'
}

interface CardStatDrawer {
  userTwitchId: string
  username: string
  drawCount: number
  lastDrawnAt: string
}

interface CardStat {
  cardId: string
  cardName: string
  rarity: Rarity
  imageUrl: string | null
  configuredRate: number
  actualCount: number
  actualRate: number
  drawerCount: number
  drawers: CardStatDrawer[]
}

interface RarityStat {
  rarity: string
  count: number
  rate: number
}

/**
 * 排出率統計コンポーネント
 * 設定排出率と実際の排出率を比較し、乖離をハイライト表示する
 * dashboard-data.ts の getGachaStats() ロジックを移植
 */
export function DropRateStats({ streamerId, timeRange }: DropRateStatsProps) {
  const [totalDraws, setTotalDraws] = useState(0)
  const [cardStats, setCardStats] = useState<CardStat[]>([])
  const [rarityStats, setRarityStats] = useState<RarityStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 「カード別排出率比較」テーブルで排出者一覧を展開中のカードID集合
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set())

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      // __admin/drop-rate-stats 経由で get_gacha_drop_stats RPC を呼び出す。
      // DBサイドの正確なCOUNT/GROUP BY集計のため、履歴行数に依存した近似値の懸念はない。
      const data = await adminApi.getDropRateStats({ streamerId, range: timeRange })

      const stats: CardStat[] = data.card_stats.map((c) => ({
        cardId: c.card_id,
        cardName: c.card_name,
        rarity: c.rarity,
        imageUrl: c.image_url,
        configuredRate: c.configured_rate,
        actualCount: c.actual_count,
        actualRate: c.actual_rate,
        drawerCount: c.drawer_count,
        drawers: c.drawers.map((d) => ({
          userTwitchId: d.user_twitch_id,
          username: d.username,
          drawCount: d.draw_count,
          lastDrawnAt: d.last_drawn_at,
        })),
      }))

      // レアリティ優先（legendary→common）、同レアリティ内は設定率降順でソート
      // RPCは rarity_order ASC, created_at DESC で返す（同レアリティ内は作成日時順）ため、
      // 「設定率が高い順」という現行UXを保つにはクライアント側の再ソートが必要
      const rarityOrder: Record<string, number> = { legendary: 0, epic: 1, rare: 2, common: 3 }
      stats.sort((a, b) => (rarityOrder[a.rarity] ?? 9) - (rarityOrder[b.rarity] ?? 9) || b.configuredRate - a.configuredRate)

      setTotalDraws(data.total_draws)
      setCardStats(stats)
      setRarityStats(data.rarity_stats)
    } catch (err) {
      console.error('DropRateStats fetch error:', err)
      setError('排出率データの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [streamerId, timeRange])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const toggleExpanded = useCallback((cardId: string) => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) {
        next.delete(cardId)
      } else {
        next.add(cardId)
      }
      return next
    })
  }, [])

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">排出率統計</h2>
        <div className="h-48 bg-gray-100 animate-pulse rounded" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">排出率統計</h2>
        <p className="text-red-600 text-center py-8">{error}</p>
      </div>
    )
  }

  if (totalDraws === 0 || cardStats.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">排出率統計</h2>
        <p className="text-gray-500 text-center py-8">
          {totalDraws === 0 ? 'この期間のガチャデータがありません' : 'アクティブなカードが設定されていません'}
        </p>
      </div>
    )
  }

  const timeRangeLabel = timeRange === '7d' ? '7日' : timeRange === '30d' ? '30日' : timeRange === '90d' ? '90日' : '全期間'

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">排出率統計</h2>

      {/* 総ガチャ回数サマリー */}
      <div className="bg-blue-50 rounded-lg p-4 text-center">
        <p className="text-3xl font-bold text-blue-700">{totalDraws.toLocaleString()}</p>
        <p className="text-sm text-blue-500">総ガチャ回数（{timeRangeLabel}）</p>
      </div>

      {/* レアリティ別サマリー（4カラムグリッド） */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">レアリティ別サマリー</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {rarityStats.map((rs) => (
            <div key={rs.rarity} className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-gray-800">{rs.count.toLocaleString()}</p>
              <div className="flex items-center justify-center gap-2 mt-1">
                <RarityBadge rarity={rs.rarity as Rarity} />
                <span className="text-sm text-gray-500">({rs.rate.toFixed(1)}%)</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* カードごとの排出率比較テーブル */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">カード別排出率比較</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-3 py-2">カード名</th>
                <th className="px-3 py-2">レアリティ</th>
                <th className="px-3 py-2 text-right">設定率</th>
                <th className="px-3 py-2 text-right">実際率</th>
                <th className="px-3 py-2 text-right">排出回数</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {cardStats.map((card) => {
                // 乖離5pt超で黄色ハイライト
                const deviation = Math.abs(card.configuredRate - card.actualRate)
                const highlightClass = (card.configuredRate > 0 || card.actualRate > 0) && deviation > 5
                  ? 'bg-yellow-50'
                  : ''
                const isExpanded = expandedCardIds.has(card.cardId)
                const hasDrawers = card.drawerCount > 0
                return (
                  <Fragment key={card.cardId}>
                    <tr className={highlightClass}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {card.imageUrl ? (
                            <img src={card.imageUrl} alt={card.cardName} className="w-6 h-6 rounded object-cover" />
                          ) : (
                            <div className="w-6 h-6 rounded bg-gray-200 flex items-center justify-center text-xs">?</div>
                          )}
                          <span className="text-gray-800">{card.cardName}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <RarityBadge rarity={card.rarity} />
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        {card.configuredRate.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">
                        {card.actualRate.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        <div className="flex items-center justify-end gap-1.5">
                          <span>{card.actualCount.toLocaleString()}</span>
                          {hasDrawers && (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(card.cardId)}
                              className="text-xs text-blue-600 hover:text-blue-800 hover:underline cursor-pointer"
                              title={isExpanded ? 'クリックで折りたたむ' : 'クリックで排出者一覧を表示'}
                            >
                              {card.drawerCount.toLocaleString()}人{isExpanded ? ' ▲' : ' ▼'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && hasDrawers && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-3 py-2">
                          <p className="text-xs text-gray-500 mb-1">
                            排出者一覧（上位{card.drawers.length}人{card.drawerCount > card.drawers.length ? `/ 全${card.drawerCount}人` : ''}）
                          </p>
                          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0.5 text-xs text-gray-600">
                            {card.drawers.map((drawer) => (
                              <li key={drawer.userTwitchId} className="flex justify-between gap-2">
                                <span className="truncate">{drawer.username}</span>
                                <span className="text-gray-400 shrink-0">{drawer.drawCount.toLocaleString()}回</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
