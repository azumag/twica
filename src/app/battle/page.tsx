'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { Session } from '@/lib/session'
import type { UserCardWithDetails } from '@/types/database'
import Header from '@/components/Header'
import AnimatedBattle from '@/components/AnimatedBattle'
import Image from 'next/image'
import { TwitchLoginRedirect } from '@/components/TwitchLoginRedirect'

interface BattleCard {
  id: string
  name: string
  hp: number
  currentHp: number
  atk: number
  def: number
  spd: number
  skill_type: 'attack' | 'defense' | 'heal' | 'special'
  skill_name: string
  skill_power: number
  image_url?: string | null
  rarity?: 'common' | 'rare' | 'epic' | 'legendary'
}

interface BattleResult {
  battleId: string
  result: 'win' | 'lose' | 'draw'
  turnCount: number
  userCard: BattleCard
  opponentCard: BattleCard
  logs: Array<{
    turn: number
    actor: 'user' | 'opponent'
    action: 'attack' | 'skill'
    damage?: number
    heal?: number
    message: string
  }>
}

const rarityColors = {
  common: 'bg-gray-500',
  rare: 'bg-blue-500',
  epic: 'bg-purple-500',
  legendary: 'bg-yellow-500'
}

const skillTypeIcons = {
  attack: '⚔️',
  defense: '🛡️',
  heal: '💚',
  special: '✨'
}

export default function BattlePage() {
  const [session, setSession] = useState<Session | null>(null)
  const [userCards, setUserCards] = useState<UserCardWithDetails[]>([])
  const [selectedCard, setSelectedCard] = useState<UserCardWithDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [battleLoading, setBattleLoading] = useState(false)
  const [battleResult, setBattleResult] = useState<BattleResult | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [showAnimation, setShowAnimation] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const loadData = async () => {
      try {
        // Get session from API endpoint
        const sessionResponse = await fetch('/api/session')
        if (!sessionResponse.ok) {
          setLoading(false)
          return
        }
        const currentSession = await sessionResponse.json()
        setSession(currentSession)

        // Fetch user's cards
        const response = await fetch('/api/user-cards')
        if (response.ok) {
          const cards = await response.json()
          setUserCards(cards)
        } else {
          const error = await response.json()
          alert(error.error || 'カード情報の取得に失敗しました')
        }
      } catch (error) {
        console.error('Failed to load data:', error)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [router])

  const startBattle = async () => {
    if (!selectedCard) return

    setBattleLoading(true)
    try {
      const response = await fetch('/api/battle/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userCardId: selectedCard.id,
          opponentType: 'cpu'
        })
      })

        if (response.ok) {
          const result = await response.json()
          setBattleResult(result)
          setShowAnimation(true)
        } else {
        const error = await response.json()
        alert(error.error || '対戦の開始に失敗しました')
      }
    } catch (error) {
      console.error('Battle error:', error)
      alert('対戦の開始に失敗しました')
    } finally {
      setBattleLoading(false)
    }
  }

  const resetBattle = () => {
    setSelectedCard(null)
    setBattleResult(null)
    setShowResult(false)
    setShowAnimation(false)
  }

  const handleAnimationComplete = () => {
    setShowAnimation(false)
    setShowResult(true)
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
        <h1 className="mb-8 text-3xl font-bold text-white">カード対戦</h1>

        {!showResult ? (
          /* Card Selection */
          <div>
            <h2 className="mb-6 text-2xl font-semibold text-white">対戦カードを選択</h2>

            {userCards.length === 0 ? (
              <div className="rounded-xl bg-gray-800 p-8 text-center">
                <p className="text-gray-400">
                  対戦できるカードがありません。
                  <br />
                  まずはカードを集めましょう！
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 mb-8">
                  {userCards.map((userCard) => (
                    <div
                      key={userCard.id}
                      onClick={() => setSelectedCard(userCard)}
                      className={`group relative overflow-hidden rounded-lg bg-gray-800 cursor-pointer transition-all ${
                        selectedCard?.id === userCard.id
                          ? 'ring-4 ring-blue-500'
                          : 'hover:ring-2 hover:ring-gray-600'
                      }`}
                    >
                      <div className="aspect-[3/4] bg-gray-700">
                        {userCard.card.image_url ? (
                          <Image
                            src={userCard.card.image_url}
                            alt={userCard.card.name}
                            width={200}
                            height={300}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-4xl">
                            🎴
                          </div>
                        )}
                      </div>
                      <div className="p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <h4 className="font-semibold text-white">{userCard.card.name}</h4>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs text-white ${rarityColors[userCard.card.rarity]}`}
                          >
                            {userCard.card.rarity}
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 space-y-1">
                          <div>HP: {userCard.card.hp}</div>
                          <div>ATK: {userCard.card.atk} / DEF: {userCard.card.def}</div>
                          <div>SPD: {userCard.card.spd}</div>
                          <div>
                            {skillTypeIcons[userCard.card.skill_type]} {userCard.card.skill_name}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {selectedCard && (
                  <div className="rounded-xl bg-gray-800 p-6">
                    <h3 className="mb-4 text-xl font-semibold text-white">選択されたカード</h3>
                    <div className="flex items-center gap-4 mb-4">
                      <div className="h-20 w-20 bg-gray-700 rounded-lg flex items-center justify-center">
                        {selectedCard.card.image_url ? (
                          <Image
                            src={selectedCard.card.image_url}
                            alt={selectedCard.card.name}
                            width={80}
                            height={80}
                            className="h-full w-full object-cover rounded-lg"
                          />
                        ) : (
                          <div className="text-2xl">🎴</div>
                        )}
                      </div>
                      <div className="text-white">
                        <div className="font-semibold">{selectedCard.card.name}</div>
                        <div className="text-sm text-gray-400">
                          HP: {selectedCard.card.hp} | ATK: {selectedCard.card.atk} | DEF: {selectedCard.card.def} | SPD: {selectedCard.card.spd}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={startBattle}
                      disabled={battleLoading}
                      className="bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                    >
                      {battleLoading ? '対戦中...' : 'CPU対戦を開始'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : showAnimation && battleResult ? (
          /* Battle Animation */
          <div>
            <h2 className="mb-6 text-2xl font-semibold text-white">対戦中</h2>
            <AnimatedBattle
              userCard={battleResult.userCard}
              opponentCard={battleResult.opponentCard}
              battleLogs={battleResult.logs}
              onComplete={handleAnimationComplete}
            />
          </div>
        ) : (
          /* Battle Result */
          <div>
            <h2 className="mb-6 text-2xl font-semibold text-white">対戦結果</h2>

            {battleResult && (
              <div className="space-y-6">
                {/* Result Header */}
                <div className={`rounded-xl p-6 text-center ${
                  battleResult.result === 'win' ? 'bg-green-800' :
                  battleResult.result === 'lose' ? 'bg-red-800' : 'bg-yellow-800'
                }`}>
                  <div className="text-3xl font-bold text-white mb-2">
                    {battleResult.result === 'win' ? '🎉 勝利！' :
                     battleResult.result === 'lose' ? '😔 敗北...' : '🤝 引き分け'}
                  </div>
                  <div className="text-white">
                    {battleResult.turnCount}ターンで決着
                  </div>
                </div>

                {/* Cards Comparison */}
                <div className="grid md:grid-cols-2 gap-6">
                  {/* User Card */}
                  <div className="rounded-xl bg-gray-800 p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">あなたのカード</h3>
                    <div className="flex items-center gap-4 mb-4">
                      <div className="h-24 w-24 bg-gray-700 rounded-lg flex items-center justify-center">
                        {battleResult.userCard.image_url ? (
                          <Image
                            src={battleResult.userCard.image_url}
                            alt={battleResult.userCard.name}
                            width={96}
                            height={96}
                            className="h-full w-full object-cover rounded-lg"
                          />
                        ) : (
                          <div className="text-3xl">🎴</div>
                        )}
                      </div>
                      <div className="text-white">
                        <div className="font-semibold">{battleResult.userCard.name}</div>
                        <div className="text-sm text-gray-400">HP: {battleResult.userCard.currentHp}/{battleResult.userCard.hp}</div>
                      </div>
                    </div>
                  </div>

                  {/* Opponent Card */}
                  <div className="rounded-xl bg-gray-800 p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">CPUカード</h3>
                    <div className="flex items-center gap-4 mb-4">
                      <div className="h-24 w-24 bg-gray-700 rounded-lg flex items-center justify-center">
                        {battleResult.opponentCard.image_url ? (
                          <Image
                            src={battleResult.opponentCard.image_url}
                            alt={battleResult.opponentCard.name}
                            width={96}
                            height={96}
                            className="h-full w-full object-cover rounded-lg"
                          />
                        ) : (
                          <div className="text-3xl">🎴</div>
                        )}
                      </div>
                      <div className="text-white">
                        <div className="font-semibold">{battleResult.opponentCard.name}</div>
                        <div className="text-sm text-gray-400">HP: {battleResult.opponentCard.currentHp}/{battleResult.opponentCard.hp}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Battle Log */}
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="text-lg font-semibold text-white mb-4">バトルログ</h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {battleResult.logs.map((log, index) => (
                      <div
                        key={index}
                        className={`p-2 rounded text-sm ${
                          log.actor === 'user' ? 'bg-blue-900 text-blue-100' : 'bg-red-900 text-red-100'
                        }`}
                      >
                        <span className="font-semibold">
                          ターン{log.turn} {log.actor === 'user' ? 'あなた' : 'CPU'}:
                        </span>
                        {' '}{log.message}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-4 justify-center">
                  <button
                    onClick={resetBattle}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                  >
                    他のカードで対戦
                  </button>
                  <a
                    href="/battle/stats"
                    className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors inline-block"
                  >
                    対戦記録を見る
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}