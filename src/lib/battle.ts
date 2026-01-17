import type { Card, BattleCard, BattleResultData, BattleLog, SkillResult, Rarity, SkillType } from '@/types/database'

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
  const skillNames = {
    attack: ['強撃', '猛攻', '破壊光線', '必殺拳'],
    defense: ['鉄壁', '硬化', '防御態勢', '守りの陣'],
    heal: ['回復', '治癒', '生命の雨', '再生光'],
    special: ['混乱攻撃', '急速', '幸運', '奇襲']
  }

  let hp, atk, def, spd, skill_power

  switch (rarity) {
    case 'common':
      hp = Math.floor(Math.random() * 21) + 100 // 100-120
      atk = Math.floor(Math.random() * 11) + 20 // 20-30
      def = Math.floor(Math.random() * 6) + 10 // 10-15
      spd = Math.floor(Math.random() * 3) + 1 // 1-3
      skill_power = Math.floor(Math.random() * 6) + 5 // 5-10
      break
    case 'rare':
      hp = Math.floor(Math.random() * 21) + 120 // 120-140
      atk = Math.floor(Math.random() * 11) + 30 // 30-40
      def = Math.floor(Math.random() * 6) + 15 // 15-20
      spd = Math.floor(Math.random() * 3) + 3 // 3-5
      skill_power = Math.floor(Math.random() * 6) + 10 // 10-15
      break
    case 'epic':
      hp = Math.floor(Math.random() * 21) + 140 // 140-160
      atk = Math.floor(Math.random() * 6) + 40 // 40-45
      def = Math.floor(Math.random() * 6) + 20 // 20-25
      spd = Math.floor(Math.random() * 3) + 5 // 5-7
      skill_power = Math.floor(Math.random() * 6) + 15 // 15-20
      break
    case 'legendary':
      hp = Math.floor(Math.random() * 41) + 160 // 160-200
      atk = Math.floor(Math.random() * 6) + 45 // 45-50
      def = Math.floor(Math.random() * 6) + 25 // 25-30
      spd = Math.floor(Math.random() * 4) + 7 // 7-10
      skill_power = Math.floor(Math.random() * 6) + 20 // 20-25
      break
    default:
      hp = 100
      atk = 30
      def = 15
      spd = 5
      skill_power = 10
  }

  const skill_type = skillTypes[Math.floor(Math.random() * skillTypes.length)]
  const skillNameList = skillNames[skill_type]
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
export function toBattleCard(card: Card): BattleCard {
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
        message: `${attacker.name}が${attacker.skill_name}！${skillDamage}ダメージを与えた！`
      }
    
    case 'defense':
      return {
        defenseUp: attacker.skill_power,
        message: `${attacker.name}が${attacker.skill_name}！防御力が${attacker.skill_power}上がった！`
      }
    
    case 'heal':
      const healAmount = Math.min(attacker.hp - attacker.currentHp, attacker.skill_power)
      return {
        heal: healAmount,
        message: `${attacker.name}が${attacker.skill_name}！${healAmount}回復した！`
      }
    
    case 'special':
      // Special effects can be implemented later
      const specialDamage = Math.max(1, Math.floor(attacker.atk * 1.5) - defender.def)
      return {
        damage: specialDamage,
        message: `${attacker.name}が${attacker.skill_name}！特殊効果で${specialDamage}ダメージ！`
      }
    
    default:
      return { message: 'スキル発動失敗' }
  }
}

// Play battle between two cards
export async function playBattle(userCard: BattleCard, opponentCard: BattleCard): Promise<BattleResultData> {
  const maxTurns = 20
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
    
    // Skill trigger chance (SPD * 10%, max 70%)
    const skillTriggerChance = Math.min(attacker.spd * 10, 70)
    const skillTrigger = Math.random() * 100 < skillTriggerChance
    
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
        message: `${attacker.name}が攻撃！${damage}ダメージを与えた！`
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
export function generateCPUOpponent(cards: Card[]): BattleCard {
  if (cards.length === 0) {
    // Fallback if no cards available
    return {
      id: 'cpu-default',
      name: 'CPUカード',
      hp: 100,
      currentHp: 100,
      atk: 30,
      def: 15,
      spd: 5,
      skill_type: 'attack',
      skill_name: 'CPU攻撃',
      skill_power: 10,
      image_url: null,
      rarity: 'common'
    }
  }
  
  const randomCard = cards[Math.floor(Math.random() * cards.length)]
  const cpuCard = toBattleCard(randomCard)
  cpuCard.name = `CPUの${cpuCard.name}`
  cpuCard.id = `cpu-${cpuCard.id}`
  
  return cpuCard
}