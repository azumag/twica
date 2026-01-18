'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import type { BattleCard, BattleLog } from '@/types/database'
import { UI_STRINGS } from '@/lib/constants'

interface AnimatedBattleProps {
  userCard: BattleCard
  opponentCard: BattleCard
  battleLogs: BattleLog[]
  onComplete: () => void
}

export default function AnimatedBattle({ 
  userCard, 
  opponentCard, 
  battleLogs, 
  onComplete 
}: AnimatedBattleProps) {
  // Use a key to force re-initialization when cards change
  const battleKey = `${userCard?.id || 'unknown'}-${opponentCard?.id || 'unknown'}`
  
  const [currentLogIndex, setCurrentLogIndex] = useState(0)
  const [userHp, setUserHp] = useState(() => userCard?.hp || 0)
  const [opponentHp, setOpponentHp] = useState(() => opponentCard?.hp || 0)
  const [shakeUser, setShakeUser] = useState(false)
  const [shakeOpponent, setShakeOpponent] = useState(false)
  const [healUser, setHealUser] = useState(false)
  const [healOpponent, setHealOpponent] = useState(false)
  const [showSkillEffect, setShowSkillEffect] = useState(false)
  const [currentAction, setCurrentAction] = useState<string>('')

  // Process battle log animation
  const processLogAnimation = useCallback((log: BattleLog) => {
    // Set action text
    setCurrentAction(log.message)
    
    // Trigger animation based on action type
    if (log.action === 'skill') {
      setShowSkillEffect(true)
    }
    
    // Apply effects based on actor
    if (log.actor === 'user') {
      if (log.damage) {
        setShakeOpponent(true)
        setTimeout(() => {
          setOpponentHp(prev => Math.max(0, prev - log.damage!))
        }, 300)
      }
      if (log.heal) {
        setHealUser(true)
        setTimeout(() => {
          setUserHp(prev => Math.min(userCard.hp, prev + log.heal!))
        }, 300)
      }
    } else {
      if (log.damage) {
        setShakeUser(true)
        setTimeout(() => {
          setUserHp(prev => Math.max(0, prev - log.damage!))
        }, 300)
      }
      if (log.heal) {
        setHealOpponent(true)
        setTimeout(() => {
          setOpponentHp(prev => Math.min(opponentCard.hp, prev + log.heal!))
        }, 300)
      }
    }
    
    // Reset animations
    setTimeout(() => {
      setShakeUser(false)
      setShakeOpponent(false)
      setHealUser(false)
      setHealOpponent(false)
      setShowSkillEffect(false)
      setCurrentAction('')
    }, 1500)
    
    // Move to next log
    setTimeout(() => {
      setCurrentLogIndex(prev => prev + 1)
    }, 2000)
  }, [userCard.hp, opponentCard.hp])

  // Animate battle logs
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentLogIndex < battleLogs.length) {
        const log = battleLogs[currentLogIndex]
        processLogAnimation(log)
      } else {
        // Battle complete
        onComplete()
      }
    }, 0) // Defer to next tick

    return () => clearTimeout(timer)
  }, [currentLogIndex, battleLogs, processLogAnimation, onComplete])

  const hpPercentage = (hp: number, maxHp: number) => (hp / maxHp) * 100

  return (
    <div key={battleKey} className="space-y-6">
      {/* Battle Animation */}
      <div className="grid md:grid-cols-2 gap-8">
        {/* User Card */}
        <div className={`relative ${shakeUser ? 'animate-pulse' : ''}`}>
           <div className={`absolute inset-0 rounded-xl ${healUser ? 'bg-green-400 opacity-30 animate-pulse' : ''}`} />
          <div className="rounded-xl bg-gray-800 p-6 relative">
            <h3 className="text-lg font-semibold text-white mb-4">{UI_STRINGS.BATTLE.USER_CARD}</h3>
            <div className="flex flex-col items-center">
              <div className={`h-32 w-32 bg-gray-700 rounded-lg flex items-center justify-center mb-4 relative ${
                shakeUser ? 'animate-bounce' : ''
              }`}>
                {userCard.image_url ? (
                  <Image
                    src={userCard.image_url}
                    alt={userCard.name}
                    width={128}
                    height={128}
                    className="h-full w-full object-cover rounded-lg"
                  />
                ) : (
                  <div className="text-4xl">🎴</div>
                )}
                {showSkillEffect && currentLogIndex < battleLogs.length && 
                 battleLogs[currentLogIndex].actor === 'user' && (
                  <div className="absolute -top-4 -right-4 text-2xl animate-spin">✨</div>
                )}
              </div>
              <div className="text-center mb-4">
                <div className="font-semibold text-white">{userCard.name}</div>
                <div className="text-xs text-gray-400 mb-2">
                  ATK: {userCard.atk} | DEF: {userCard.def} | SPD: {userCard.spd}
                </div>
                {/* HP Bar */}
                <div className="w-full bg-gray-700 rounded-full h-4 mb-1">
                  <div
                    className="bg-green-500 h-4 rounded-full transition-all duration-500"
                    style={{ width: `${hpPercentage(userHp, userCard.hp)}%` }}
                  />
                </div>
                <div className="text-sm text-white">
                  HP: {userHp}/{userCard.hp}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* VS */}
        <div className="flex items-center justify-center md:hidden">
          <div className="text-2xl font-bold text-yellow-400 animate-pulse">{UI_STRINGS.BATTLE.VERSUS}</div>
        </div>

        {/* Opponent Card */}
        <div className={`relative ${shakeOpponent ? 'animate-pulse' : ''}`}>
          <div className={`absolute inset-0 rounded-xl ${healOpponent ? 'bg-green-400 opacity-30 animate-pulse' : ''}`} />
          <div className="rounded-xl bg-gray-800 p-6 relative">
            <h3 className="text-lg font-semibold text-white mb-4">{UI_STRINGS.BATTLE.CPU_CARD}</h3>
            <div className="flex flex-col items-center">
              <div className={`h-32 w-32 bg-gray-700 rounded-lg flex items-center justify-center mb-4 relative ${
                shakeOpponent ? 'animate-bounce' : ''
              }`}>
                {opponentCard.image_url ? (
                  <Image
                    src={opponentCard.image_url}
                    alt={opponentCard.name}
                    width={128}
                    height={128}
                    className="h-full w-full object-cover rounded-lg"
                  />
                ) : (
                  <div className="text-4xl">🎴</div>
                )}
                {showSkillEffect && currentLogIndex < battleLogs.length && 
                 battleLogs[currentLogIndex].actor === 'opponent' && (
                  <div className="absolute -top-4 -left-4 text-2xl animate-spin">✨</div>
                )}
              </div>
              <div className="text-center mb-4">
                <div className="font-semibold text-white">{opponentCard.name}</div>
                <div className="text-xs text-gray-400 mb-2">
                  ATK: {opponentCard.atk} | DEF: {opponentCard.def} | SPD: {opponentCard.spd}
                </div>
                {/* HP Bar */}
                <div className="w-full bg-gray-700 rounded-full h-4 mb-1">
                  <div
                    className="bg-green-500 h-4 rounded-full transition-all duration-500"
                    style={{ width: `${hpPercentage(opponentHp, opponentCard.hp)}%` }}
                  />
                </div>
                <div className="text-sm text-white">
                  HP: {opponentHp}/{opponentCard.hp}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* VS (Desktop) */}
      <div className="hidden md:flex items-center justify-center">
        <div className="text-3xl font-bold text-yellow-400 animate-pulse">{UI_STRINGS.BATTLE.VERSUS}</div>
      </div>

      {/* Current Action */}
      {currentAction && (
        <div className="rounded-xl bg-gradient-to-r from-blue-800 to-purple-800 p-6 text-center">
          <div className="text-xl font-bold text-white animate-pulse">
            {currentAction}
          </div>
        </div>
      )}

      {/* Progress */}
      <div className="rounded-xl bg-gray-800 p-4">
        <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
          <span>{UI_STRINGS.BATTLE.BATTLE_PROGRESS}</span>
          <span>{currentLogIndex + 1} / {battleLogs.length}</span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-500"
            style={{ width: `${((currentLogIndex + 1) / battleLogs.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Battle Log */}
      <div className="rounded-xl bg-gray-800 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">{UI_STRINGS.BATTLE.BATTLE_LOG}</h3>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {battleLogs.slice(0, currentLogIndex + 1).map((log, index) => (
            <div
              key={index}
              className={`p-2 rounded text-sm transition-all duration-500 ${
                log.actor === 'user' ? 'bg-blue-900 text-blue-100' : 'bg-red-900 text-red-100'
              } ${index === currentLogIndex ? 'ring-2 ring-yellow-400' : ''}`}
            >
              <span className="font-semibold">
                {UI_STRINGS.BATTLE.TURN}{log.turn} {log.actor === 'user' ? UI_STRINGS.BATTLE.YOU : UI_STRINGS.BATTLE.CPU}:
              </span>
              {' '}{log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}