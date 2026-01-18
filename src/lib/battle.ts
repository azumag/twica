import type { Card, BattleCard, BattleResultData, BattleLog, SkillResult, Rarity, SkillType } from '@/types/database'
import { CPU_CARD_STRINGS, BATTLE_SKILL_NAMES, BATTLE_LOG_MESSAGES, BATTLE_CONFIG, CARD_STAT_RANGES, CARD_STAT_DEFAULTS } from '@/lib/constants'

export interface BattleCardData {
  id: string
  name: string
  hp: number
  atk: number
  def: number
  spd: number
  skill_type: SkillType
  skill_name: string
  skill_power: number
  image_url: string | null
  rarity: Rarity
}

// Generate card stats based on rarity
export function generateCardStats(rarity: Rarity): {
  hp: number
  atk: number
  def: number
  spd: number
  skill_type: SkillType
  skill_name: string
  skill_power: number
} {
  const skillTypes: SkillType[] = ['attack', 'defense', 'heal', 'special']

  const statRanges = CARD_STAT_RANGES[rarity as keyof typeof CARD_STAT_RANGES]

  let hp: number, atk: number, def: number, spd: number, skill_power: number

  if (statRanges) {
    hp = Math.floor(Math.random() * (statRanges.hp.max - statRanges.hp.min + 1)) + statRanges.hp.min
    atk = Math.floor(Math.random() * (statRanges.atk.max - statRanges.atk.min + 1)) + statRanges.atk.min
    def = Math.floor(Math.random() * (statRanges.def.max - statRanges.def.min + 1)) + statRanges.def.min
    spd = Math.floor(Math.random() * (statRanges.spd.max - statRanges.spd.min + 1)) + statRanges.spd.min
    skill_power = Math.floor(Math.random() * (statRanges.skill_power.max - statRanges.skill_power.min + 1)) + statRanges.skill_power.min
  } else {
    hp = CARD_STAT_DEFAULTS.hp
    atk = CARD_STAT_DEFAULTS.atk
    def = CARD_STAT_DEFAULTS.def
    spd = CARD_STAT_DEFAULTS.spd
    skill_power = CARD_STAT_DEFAULTS.skill_power
  }

  const skill_type = skillTypes[Math.floor(Math.random() * skillTypes.length)]
  const skillNameList = BATTLE_SKILL_NAMES[skill_type.toUpperCase() as keyof typeof BATTLE_SKILL_NAMES]
  const skill_name = skillNameList[Math.floor(Math.random() * skillNameList.length)]

  return {
    hp,
    atk,
    def,
    spd,
    skill_type,
    skill_name,
    skill_power
  }
}

// Convert card to battle card
export function toBattleCard(card: Card | BattleCardData): BattleCard {
  return {
    id: card.id,
    name: card.name,
    hp: card.hp,
    currentHp: card.hp,
    atk: card.atk,
    def: card.def,
    spd: card.spd,
    skill_type: card.skill_type,
    skill_name: card.skill_name,
    skill_power: card.skill_power,
    image_url: card.image_url,
    rarity: card.rarity
  }
}

// Execute skill
export function executeSkill(attacker: BattleCard, defender: BattleCard): SkillResult {
  switch (attacker.skill_type) {
    case 'attack':
      const skillDamage = Math.max(1, attacker.atk + attacker.skill_power - defender.def)
      return {
        damage: skillDamage,
        message: BATTLE_LOG_MESSAGES.SKILL_ATTACK(attacker.name, attacker.skill_name, skillDamage)
      }
    
    case 'defense':
      return {
        defenseUp: attacker.skill_power,
        message: BATTLE_LOG_MESSAGES.SKILL_DEFENSE(attacker.name, attacker.skill_name, attacker.skill_power)
      }
    
    case 'heal':
      const healAmount = Math.min(attacker.hp - attacker.currentHp, attacker.skill_power)
      return {
        heal: healAmount,
        message: BATTLE_LOG_MESSAGES.SKILL_HEAL(attacker.name, attacker.skill_name, healAmount)
      }
    
    case 'special':
      const specialDamage = Math.max(1, Math.floor(attacker.atk * BATTLE_CONFIG.SPECIAL_SKILL_DAMAGE_MULTIPLIER) - defender.def)
      return {
        damage: specialDamage,
        message: BATTLE_LOG_MESSAGES.SKILL_SPECIAL(attacker.name, attacker.skill_name, specialDamage)
      }
    
    default:
      return { message: BATTLE_LOG_MESSAGES.SKILL_FAILED }
  }
}

// Play battle between two cards
export async function playBattle(userCard: BattleCard, opponentCard: BattleCard): Promise<BattleResultData> {
  const maxTurns = BATTLE_CONFIG.MAX_TURNS
  const logs: BattleLog[] = []
  let turn = 1
  
  // Determine action order (higher SPD goes first)
  const firstActor: 'user' | 'opponent' = userCard.spd >= opponentCard.spd ? 'user' : 'opponent'
  let currentActor: 'user' | 'opponent' = firstActor
  
  // Copy card stats to modify during battle
  const userStats = { ...userCard }
  const opponentStats = { ...opponentCard }
  
  while (turn <= maxTurns && userStats.currentHp > 0 && opponentStats.currentHp > 0) {
    const attacker = currentActor === 'user' ? userStats : opponentStats
    const defender = currentActor === 'user' ? opponentStats : userStats
    
    const skillTriggerChance = Math.min(
      attacker.spd * BATTLE_CONFIG.SKILL_SPEED_MULTIPLIER,
      BATTLE_CONFIG.SKILL_TRIGGER_MAX_PERCENT
    )
    const skillTrigger = Math.random() * BATTLE_CONFIG.RANDOM_RANGE < skillTriggerChance
    
    if (skillTrigger) {
      // Execute skill
      const result = executeSkill(attacker, defender)
      logs.push({
        turn,
        actor: currentActor,
        action: 'skill',
        damage: result.damage,
        heal: result.heal,
        message: result.message
      })
      
      // Update stats based on skill result
      if (result.damage) {
        defender.currentHp = Math.max(0, defender.currentHp - result.damage)
      }
      if (result.heal) {
        attacker.currentHp = Math.min(attacker.hp, attacker.currentHp + result.heal)
      }
      if (result.defenseUp) {
        defender.def += result.defenseUp
      }
} else {
       // Normal attack
       const damage = Math.max(1, attacker.atk - defender.def)
       defender.currentHp = Math.max(0, defender.currentHp - damage)
       
       logs.push({
         turn,
         actor: currentActor,
         action: 'attack',
         damage,
         message: BATTLE_LOG_MESSAGES.NORMAL_ATTACK(attacker.name, damage)
       })
     }
    
    // Switch actor
    currentActor = currentActor === 'user' ? 'opponent' : 'user'
    
    // When both actors have acted, increment turn
    if (currentActor === firstActor) {
      turn++
    }
  }
  
  // Determine winner
  let result: 'win' | 'lose' | 'draw'
  if (userStats.currentHp <= 0 && opponentStats.currentHp <= 0) {
    result = 'draw'
  } else if (userStats.currentHp <= 0) {
    result = 'lose'
  } else if (opponentStats.currentHp <= 0) {
    result = 'win'
  } else {
    // After 20 turns, winner is the one with more HP
    result = userStats.currentHp >= opponentStats.currentHp ? 'win' : 'lose'
  }
  
  return {
    result,
    turnCount: turn,
    userHp: userStats.currentHp,
    opponentHp: opponentStats.currentHp,
    logs
  }
}

// Generate a CPU opponent card (for now, return a random card)
export function generateCPUOpponent(cards: (Card | BattleCardData)[]): BattleCard {
  if (cards.length === 0) {
    // Fallback if no cards available
    return {
      id: 'cpu-default',
      name: CPU_CARD_STRINGS.DEFAULT_NAME,
      hp: 100,
      currentHp: 100,
      atk: 30,
      def: 15,
      spd: 5,
      skill_type: 'attack',
      skill_name: CPU_CARD_STRINGS.DEFAULT_SKILL_NAME,
      skill_power: 10,
      image_url: null,
      rarity: 'common'
    }
  }
  
  const randomCard = cards[Math.floor(Math.random() * cards.length)]
  const cpuCard = toBattleCard(randomCard)
  cpuCard.name = `${CPU_CARD_STRINGS.NAME_PREFIX}${cpuCard.name}`
  cpuCard.id = `cpu-${cpuCard.id}`
  
  return cpuCard
}