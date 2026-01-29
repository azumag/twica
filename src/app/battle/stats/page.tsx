'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'

import Header from '@/components/Header'
import Link from 'next/link'
import { TwitchLoginRedirect } from '@/components/TwitchLoginRedirect'
import { fetchSession } from '@/lib/api-client'
import { type Session } from '@/lib/session'

interface CardStats {
  cardId: string
  cardName: string
  cardImage: string | null
  cardRarity: 'common' | 'rare' | 'epic' | 'legendary'
  totalBattles: number
  wins: number
  losses: number
  draws: number
  winRate: number
}

interface BattleStats {
  totalBattles: number
  wins: number
  losses: number
  draws: number
  winRate: number
  recentBattles: Array<{
    battleId: string
    result: 'win' | 'lose' | 'draw'
    opponentCardName: string
    turnCount: number
    createdAt: string
    userCardName: string
  }>
  cardStats: CardStats[]
}

export default function BattleStatsPage() {
  const [session, setSession] = useState<Session | null>(null)
  const [stats, setStats] = useState<BattleStats | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const loadData = async () => {
      try {
        const currentSession = await fetchSession()
        if (!currentSession) {
          setLoading(false)
          return
        }
        setSession(currentSession)

        // Fetch battle stats
        const response = await fetch('/api/battle/stats')
        if (response.ok) {
          const battleStats = await response.json()
          setStats(battleStats)
        }
      } catch (error) {
        console.error('[BattleStatsPage]', error)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [router])

  const getResultColor = (result: 'win' | 'lose' | 'draw') => {
    switch (result) {
      case 'win':
        return 'text-green-400'
      case 'lose':
        return 'text-red-400'
      case 'draw':
        return 'text-yellow-400'
      default:
        return 'text-gray-400'
    }
  }

  const getResultBg = (result: 'win' | 'lose' | 'draw') => {
    switch (result) {
      case 'win':
        return 'bg-green-900'
      case 'lose':
        return 'bg-red-900'
      case 'draw':
        return 'bg-yellow-900'
      default:
        return 'bg-gray-900'
    }
  }

  const getResultText = (result: 'win' | 'lose' | 'draw') => {
    switch (result) {
      case 'win':
        return '勝利'
      case 'lose':
        return '敗北'
      case 'draw':
        return '引き分け'
      default:
        return result
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">読み込み中...</div>
      </div>
    )
  }

  if (!session) {
    return <TwitchLoginRedirect />
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <Header session={session} />

      <main className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-white">対戦記録</h1>
          <Link
            href="/battle"
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            対戦ページへ
          </Link>
        </div>

        {stats && (
          <div className="space-y-8">
            {/* Overall Stats */}
            <section>
              <h2 className="mb-6 text-2xl font-semibold text-white">総合成績</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="rounded-xl bg-gray-800 p-6 text-center">
                  <div className="text-3xl font-bold text-white mb-2">{stats.totalBattles}</div>
                  <div className="text-gray-400">総対戦数</div>
                </div>
                <div className="rounded-xl bg-green-800 p-6 text-center">
                  <div className="text-3xl font-bold text-white mb-2">{stats.wins}</div>
                  <div className="text-green-200">勝利</div>
                </div>
                <div className="rounded-xl bg-red-800 p-6 text-center">
                  <div className="text-3xl font-bold text-white mb-2">{stats.losses}</div>
                  <div className="text-red-200">敗北</div>
                </div>
                <div className="rounded-xl bg-yellow-800 p-6 text-center">
                  <div className="text-3xl font-bold text-white mb-2">{stats.draws}</div>
                  <div className="text-yellow-200">引き分け</div>
                </div>
                <div className="rounded-xl bg-blue-800 p-6 text-center">
                  <div className="text-3xl font-bold text-white mb-2">{stats.winRate.toFixed(1)}%</div>
                  <div className="text-blue-200">勝率</div>
                </div>
              </div>
            </section>

            {/* Card Statistics */}
            <section>
              <h2 className="mb-6 text-2xl font-semibold text-white">カード別成績</h2>
              {stats.cardStats.length === 0 ? (
                <div className="rounded-xl bg-gray-800 p-8 text-center">
                  <p className="text-gray-400">
                    まだカード別の対戦記録がありません。
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {stats.cardStats.map((card) => (
                    <div key={card.cardId} className="rounded-xl bg-gray-800 p-6">
                      <div className="flex items-center gap-4">
                        <div className="h-16 w-16 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0">
                          {card.cardImage ? (
                            // unoptimized: ImageCropperで最適化済みのため、Vercel Image Transformationsをスキップしてコスト削減
                            <Image
                              src={card.cardImage}
                              alt={card.cardName}
                              width={64}
                              height={64}
                              className="h-full w-full object-cover rounded-lg"
                              unoptimized
                            />
                          ) : (
                            <div className="text-2xl">🎴</div>
                          )}
                        </div>
                        <div className="flex-grow">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-semibold text-white">{card.cardName}</span>
                            <span className={`px-2 py-1 rounded-full text-xs text-white ${
                              card.cardRarity === 'common' ? 'bg-gray-500' :
                              card.cardRarity === 'rare' ? 'bg-blue-500' :
                              card.cardRarity === 'epic' ? 'bg-purple-500' :
                              'bg-yellow-500'
                            }`}>
                              {card.cardRarity}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
                            <div className="text-gray-400">
                              総戦: <span className="text-white font-semibold">{card.totalBattles}</span>
                            </div>
                            <div className="text-green-400">
                              勝利: <span className="text-white font-semibold">{card.wins}</span>
                            </div>
                            <div className="text-red-400">
                              敗北: <span className="text-white font-semibold">{card.losses}</span>
                            </div>
                            <div className="text-yellow-400">
                              引分: <span className="text-white font-semibold">{card.draws}</span>
                            </div>
                            <div className="text-blue-400">
                              勝率: <span className="text-white font-semibold">{card.winRate.toFixed(1)}%</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`text-2xl font-bold ${
                            card.winRate >= 70 ? 'text-green-400' :
                            card.winRate >= 50 ? 'text-yellow-400' :
                            'text-red-400'
                          }`}>
                            {card.winRate.toFixed(1)}%
                          </div>
                          <div className="text-xs text-gray-400">勝率</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Recent Battles */}
            <section>
              <h2 className="mb-6 text-2xl font-semibold text-white">最近の対戦</h2>
              {stats.recentBattles.length === 0 ? (
                <div className="rounded-xl bg-gray-800 p-8 text-center">
                  <p className="text-gray-400">
                    まだ対戦記録がありません。
                    <br />
                    <Link href="/battle" className="text-blue-400 hover:text-blue-300">
                      ここをクリックして対戦を開始
                    </Link>
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {stats.recentBattles.map((battle) => (
                    <div key={battle.battleId} className="rounded-xl bg-gray-800 p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className={`px-3 py-1 rounded-full text-sm font-semibold ${getResultBg(battle.result)} ${getResultColor(battle.result)}`}>
                            {getResultText(battle.result)}
                          </div>
                          <div className="text-white">
                            <span className="font-semibold">{battle.userCardName}</span>
                            <span className="text-gray-400 mx-2">vs</span>
                            <span>{battle.opponentCardName}</span>
                          </div>
                        </div>
                        <div className="text-right text-gray-400 text-sm">
                          <div>{battle.turnCount}ターン</div>
                          <div>{new Date(battle.createdAt).toLocaleDateString('ja-JP')}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Navigation */}
            <div className="flex justify-center">
              <Link
                href="/battle"
                className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                新しい対戦を開始
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}