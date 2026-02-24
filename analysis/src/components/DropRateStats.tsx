import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { RarityBadge } from './RarityBadge'
import { Rarity } from '../types/database'

interface DropRateStatsProps {
  streamerId: string
  timeRange: '7d' | '30d' | '90d' | 'all'
}

interface CardStat {
  cardId: string
  cardName: string
  rarity: Rarity
  imageUrl: string | null
  configuredRate: number
  actualCount: number
  actualRate: number
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

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)

    // 期間フィルタの開始日を算出
    let fromDate: string | null = null
    if (timeRange !== 'all') {
      const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
      const now = new Date()
      fromDate = new Date(now.getTime() - daysMap[timeRange] * 24 * 60 * 60 * 1000).toISOString()
    }

    // 3つの独立クエリを並列実行してレイテンシを削減
    // 1. count-onlyクエリで正確な総回数（1000行制限回避）
    // 2. card_id + rarity で排出回数集計（limit 10000で近似）
    // 3. 全アクティブカード（排出0回も含めるため）
    let countQuery = supabase
      .from('gacha_history')
      .select('id', { count: 'exact', head: true })
      .eq('streamer_id', streamerId)
    let historyQuery = supabase
      .from('gacha_history')
      .select('card_id, cards(rarity)')
      .eq('streamer_id', streamerId)
      .limit(10000)
    const cardsQuery = supabase
      .from('cards')
      .select('id, name, rarity, image_url, drop_rate')
      .eq('streamer_id', streamerId)
      .eq('is_active', true)

    if (fromDate) {
      countQuery = countQuery.gte('redeemed_at', fromDate)
      historyQuery = historyQuery.gte('redeemed_at', fromDate)
    }

    const [countResult, historyResult, cardsResult] = await Promise.all([
      countQuery,
      historyQuery,
      cardsQuery,
    ])

    if (countResult.error || historyResult.error || cardsResult.error) {
      console.error('DropRateStats fetch error:', countResult.error, historyResult.error, cardsResult.error)
      setError('排出率データの取得に失敗しました')
      setLoading(false)
      return
    }

    const safeTotal = countResult.count || 0
    // Supabase の型推論が select('card_id, cards(rarity)') に対して不完全なため明示キャスト
    const history = (historyResult.data || []) as unknown as Array<{ card_id: string; cards: { rarity: string } | null }>
    const allCards = (cardsResult.data || []) as unknown as Array<{
      id: string; name: string; rarity: string; image_url: string | null; drop_rate: number
    }>

    // カードごとの排出回数を集計
    const drawCounts = new Map<string, number>()
    for (const h of history) {
      drawCounts.set(h.card_id, (drawCounts.get(h.card_id) || 0) + 1)
    }

    // 設定重み合計（パーセンテージ計算用）
    // drop_rate は Supabase DECIMAL型のため Number() でキャスト
    const totalWeight = allCards.reduce((sum, c) => sum + Number(c.drop_rate || 0), 0)

    // カードごとの統計を構築
    // 率計算の分母は count-only クエリの正確な総数 (safeTotal) を使用
    // （参照実装 dashboard-data.ts:getGachaStats と同一ロジック）
    // 10000件超のとき actualCount はサンプルからの近似値だが、
    // 分母を正確な総数にすることで設定率との比較精度を維持
    const stats: CardStat[] = allCards.map((card) => {
      const actualCount = drawCounts.get(card.id) || 0
      return {
        cardId: card.id,
        cardName: card.name,
        rarity: card.rarity as Rarity,
        imageUrl: card.image_url,
        configuredRate: totalWeight > 0 ? (Number(card.drop_rate) / totalWeight) * 100 : 0,
        actualCount,
        actualRate: safeTotal > 0 ? (actualCount / safeTotal) * 100 : 0,
      }
    })

    // レアリティレベルの統計を構築
    const rarityMap = new Map<string, number>()
    for (const h of history) {
      if (h.cards) {
        rarityMap.set(h.cards.rarity, (rarityMap.get(h.cards.rarity) || 0) + 1)
      }
    }

    const rStats: RarityStat[] = ['legendary', 'epic', 'rare', 'common'].map((rarity) => {
      const count = rarityMap.get(rarity) || 0
      return { rarity, count, rate: safeTotal > 0 ? (count / safeTotal) * 100 : 0 }
    })

    // レアリティ優先（legendary→common）、同レアリティ内は設定率降順でソート
    const rarityOrder: Record<string, number> = { legendary: 0, epic: 1, rare: 2, common: 3 }
    stats.sort((a, b) => (rarityOrder[a.rarity] ?? 9) - (rarityOrder[b.rarity] ?? 9) || b.configuredRate - a.configuredRate)

    setTotalDraws(safeTotal)
    setCardStats(stats)
    setRarityStats(rStats)
    setLoading(false)
  }, [streamerId, timeRange])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

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
        {/* カード別集計は10000件上限のため、超過時は近似値になることを注記 */}
        {totalDraws > 10000 && (
          <p className="text-xs text-amber-600 mt-1">
            ※ カード別排出率はサンプル10,000件からの近似値です
          </p>
        )}
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
                return (
                  <tr key={card.cardId} className={highlightClass}>
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
                      {card.actualCount.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
