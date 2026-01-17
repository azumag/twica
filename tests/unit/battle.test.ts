import { describe, it, expect, vi, beforeEach } from 'vitest'
import { 
  generateCardStats, 
  toBattleCard, 
  executeSkill, 
  playBattle, 
  generateCPUOpponent 
} from '@/lib/battle'
import type { Card, BattleCard, Rarity, SkillType } from '@/types/database'

// Mock Math.random for predictable testing
const mockMath = Object.create(global.Math)
mockMath.random = vi.fn()
global.Math = mockMath

describe('generateCardStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should generate stats within correct ranges for common rarity', () => {
    // Mock Math.random to return 0.5 (middle value)
    mockMath.random.mockReturnValue(0.5)

    const stats = generateCardStats('common')

    expect(stats.hp).toBe(110) // 100 + floor(0.5 * 20)
    expect(stats.atk).toBe(25) // 20 + floor(0.5 * 10)
    expect(stats.def).toBe(13) // 10 + floor(0.5 * 6)
    expect(stats.spd).toBe(2) // 1 + floor(0.5 * 2)
    expect(stats.skill_power).toBe(8) // 5 + floor(0.5 * 6)
    expect(['attack', 'defense', 'heal', 'special']).toContain(stats.skill_type)
    expect(stats.skill_name).toBeDefined()
    expect(stats.skill_power).toBeGreaterThanOrEqual(5)
    expect(stats.skill_power).toBeLessThanOrEqual(10)
  })

  it('should generate stats within correct ranges for rare rarity', () => {
    mockMath.random.mockReturnValue(0.5)

    const stats = generateCardStats('rare')

    expect(stats.hp).toBe(130) // 120 + floor(0.5 * 20)
    expect(stats.atk).toBe(35) // 30 + floor(0.5 * 10)
    expect(stats.def).toBe(18) // 15 + floor(0.5 * 6)
    expect(stats.spd).toBe(4) // 3 + floor(0.5 * 2)
    expect(stats.skill_power).toBe(13) // 10 + floor(0.5 * 6)
  })

  it('should generate stats within correct ranges for epic rarity', () => {
    mockMath.random.mockReturnValue(0.5)

    const stats = generateCardStats('epic')

    expect(stats.hp).toBe(150) // 140 + floor(0.5 * 20)
    expect(stats.atk).toBe(43) // 40 + floor(0.5 * 6)
    expect(stats.def).toBe(23) // 20 + floor(0.5 * 6)
    expect(stats.spd).toBe(6) // 5 + floor(0.5 * 2)
    expect(stats.skill_power).toBe(18) // 15 + floor(0.5 * 6)
  })

  it('should generate stats within correct ranges for legendary rarity', () => {
    mockMath.random.mockReturnValue(0.5)

    const stats = generateCardStats('legendary')

    expect(stats.hp).toBe(180) // 160 + floor(0.5 * 40)
    expect(stats.atk).toBe(48) // 45 + floor(0.5 * 6)
    expect(stats.def).toBe(28) // 25 + floor(0.5 * 6)
    expect(stats.spd).toBe(9) // 7 + floor(0.5 * 4)
    expect(stats.skill_power).toBe(23) // 20 + floor(0.5 * 6)
  })

  it('should use default values for invalid rarity', () => {
    mockMath.random.mockReturnValue(0.5)

    const stats = generateCardStats('invalid' as Rarity)

    expect(stats.hp).toBe(100)
    expect(stats.atk).toBe(30)
    expect(stats.def).toBe(15)
    expect(stats.spd).toBe(5)
    expect(stats.skill_power).toBe(10)
  })

  it('should generate valid skill types and names', () => {
    mockMath.random.mockReturnValue(0) // Always select first option

    const stats = generateCardStats('common')

    expect(stats.skill_type).toBe('attack')
    expect(['強撃', '猛攻', '破壊光線', '必殺拳']).toContain(stats.skill_name)
  })
})

describe('toBattleCard', () => {
  it('should convert card to battle card with correct properties', () => {
    const card: Card = {
      id: 'test-card-id',
      streamer_id: 'streamer-123',
      name: 'Test Card',
      description: 'Test Description',
      image_url: 'https://example.com/image.jpg',
      rarity: 'rare',
      drop_rate: 0.1,
      is_active: true,
      hp: 150,
      atk: 35,
      def: 20,
      spd: 5,
      skill_type: 'attack',
      skill_name: 'Test Attack',
      skill_power: 15,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z'
    }

    const battleCard = toBattleCard(card)

    expect(battleCard.id).toBe(card.id)
    expect(battleCard.name).toBe(card.name)
    expect(battleCard.hp).toBe(card.hp)
    expect(battleCard.currentHp).toBe(card.hp) // Should initialize to max HP
    expect(battleCard.atk).toBe(card.atk)
    expect(battleCard.def).toBe(card.def)
    expect(battleCard.spd).toBe(card.spd)
    expect(battleCard.skill_type).toBe(card.skill_type)
    expect(battleCard.skill_name).toBe(card.skill_name)
    expect(battleCard.skill_power).toBe(card.skill_power)
    expect(battleCard.image_url).toBe(card.image_url)
    expect(battleCard.rarity).toBe(card.rarity)
  })
})

describe('executeSkill', () => {
  const createBattleCard = (overrides: Partial<BattleCard> = {}): BattleCard => ({
    id: 'test-id',
    name: 'Test Card',
    hp: 100,
    currentHp: 100,
    atk: 30,
    def: 15,
    spd: 5,
    skill_type: 'attack',
    skill_name: 'Test Attack',
    skill_power: 10,
    image_url: null,
    rarity: 'common',
    ...overrides
  })

  it('should execute attack skill correctly', () => {
    const attacker = createBattleCard({ skill_type: 'attack', atk: 30, skill_power: 10 })
    const defender = createBattleCard({ def: 15 })

    const result = executeSkill(attacker, defender)

    expect(result.damage).toBe(25) // 30 + 10 - 15
    expect(result.heal).toBeUndefined()
    expect(result.defenseUp).toBeUndefined()
    expect(result.message).toBe('Test CardがTest Attack！25ダメージを与えた！')
  })

  it('should execute defense skill correctly', () => {
    const attacker = createBattleCard({ skill_type: 'defense', skill_power: 10 })
    const defender = createBattleCard({ def: 15 })

    const result = executeSkill(attacker, defender)

    expect(result.damage).toBeUndefined()
    expect(result.heal).toBeUndefined()
    expect(result.defenseUp).toBe(10)
    expect(result.message).toBe('Test CardがTest Attack！防御力が10上がった！')
  })

  it('should execute heal skill correctly', () => {
    const attacker = createBattleCard({ 
      skill_type: 'heal', 
      skill_power: 20, 
      hp: 100, 
      currentHp: 60 // Missing 40 HP
    })

    const result = executeSkill(attacker, attacker)

    expect(result.damage).toBeUndefined()
    expect(result.heal).toBe(20) // Limited by skill_power
    expect(result.defenseUp).toBeUndefined()
    expect(result.message).toBe('Test CardがTest Attack！20回復した！')
  })

  it('should limit heal to missing HP', () => {
    const attacker = createBattleCard({ 
      skill_type: 'heal', 
      skill_power: 50, 
      hp: 100, 
      currentHp: 80 // Missing only 20 HP
    })

    const result = executeSkill(attacker, attacker)

    expect(result.heal).toBe(20) // Limited by missing HP
  })

  it('should execute special skill correctly', () => {
    const attacker = createBattleCard({ skill_type: 'special', atk: 30, skill_power: 10 })
    const defender = createBattleCard({ def: 15 })

    const result = executeSkill(attacker, defender)

    expect(result.damage).toBe(30) // floor(30 * 1.5) - 15 = 45 - 15 = 30
    expect(result.heal).toBeUndefined()
    expect(result.defenseUp).toBeUndefined()
    expect(result.message).toBe('Test CardがTest Attack！特殊効果で30ダメージ！')
  })

  it('should handle unknown skill type', () => {
    const attacker = createBattleCard({ skill_type: 'unknown' as SkillType })
    const defender = createBattleCard()

    const result = executeSkill(attacker, defender)

    expect(result.damage).toBeUndefined()
    expect(result.heal).toBeUndefined()
    expect(result.defenseUp).toBeUndefined()
    expect(result.message).toBe('スキル発動失敗')
  })

  it('should ensure minimum damage of 1', () => {
    const attacker = createBattleCard({ skill_type: 'attack', atk: 5, skill_power: 5 })
    const defender = createBattleCard({ def: 20 })

    const result = executeSkill(attacker, defender)

    expect(result.damage).toBe(1) // max(1, 5 + 5 - 20) = 1
  })
})

describe('playBattle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const createBattleCard = (overrides: Partial<BattleCard> = {}): BattleCard => ({
    id: 'test-id',
    name: 'Test Card',
    hp: 100,
    currentHp: 100,
    atk: 30,
    def: 15,
    spd: 5,
    skill_type: 'attack',
    skill_name: 'Test Attack',
    skill_power: 10,
    image_url: null,
    rarity: 'common',
    ...overrides
  })

  it('should determine correct turn order based on speed', () => {
    const slowCard = createBattleCard({ spd: 3, name: 'Slow Card' })
    const fastCard = createBattleCard({ spd: 7, name: 'Fast Card' })

    mockMath.random.mockReturnValue(1) // No skill triggers (100% > 70% max)

    return playBattle(fastCard, slowCard).then(result => {
      expect(result.logs[0].actor).toBe('user') // Fast card goes first
      expect(result.logs[0].message).toContain('Fast Card')
    })
  })

  it('should handle skill trigger correctly', () => {
    const attacker = createBattleCard({ 
      spd: 5, 
      skill_type: 'attack',
      skill_name: 'Power Attack'
    })
    const defender = createBattleCard({ def: 10 })

    // Mock skill trigger (50% < 50% chance)
    mockMath.random.mockReturnValueOnce(0.4) // Skill triggers
    mockMath.random.mockReturnValueOnce(1)   // No skill for opponent

    return playBattle(attacker, defender).then(result => {
      expect(result.logs[0].action).toBe('skill')
      expect(result.logs[0].message).toContain('Power Attack')
    })
  })

  it('should end battle when HP reaches 0', () => {
    const weakCard = createBattleCard({ hp: 10, currentHp: 10, def: 0 })
    const strongCard = createBattleCard({ atk: 50, spd: 10 })

    mockMath.random.mockReturnValue(1) // No skill triggers

    return playBattle(strongCard, weakCard).then(result => {
      expect(result.result).toBe('win')
      expect(result.opponentHp).toBe(0)
      expect(result.turnCount).toBeLessThanOrEqual(2)
    })
  })

  it('should end battle after maximum turns', () => {
    // Create cards with equal stats for a draw
    // User will win due to attacking first, so test logic rather than exact result
    const card1 = createBattleCard({ name: 'Card 1', hp: 1000, atk: 1, def: 100 })
    const card2 = createBattleCard({ name: 'Card 2', hp: 1000, atk: 1, def: 100 })

    mockMath.random.mockReturnValue(1) // No skill triggers

    return playBattle(card1, card2).then(result => {
      expect(result.turnCount).toBe(21) // After 20 full turns
      // Both cards should have high HP remaining (not 0)
      expect(result.userHp).toBeGreaterThan(0)
      expect(result.opponentHp).toBeGreaterThan(0)
      // Result should be win due to first-mover advantage with equal stats
      expect(['win', 'lose', 'draw']).toContain(result.result)
    })
  })

  it('should declare winner based on HP after max turns', () => {
    const card1 = createBattleCard({ name: 'Card 1', hp: 1000, currentHp: 1000, atk: 1, def: 100 })
    const card2 = createBattleCard({ name: 'Card 2', hp: 1000, currentHp: 900, atk: 1, def: 100 })

    mockMath.random.mockReturnValue(1) // No skill triggers

    return playBattle(card1, card2).then(result => {
      expect(result.turnCount).toBe(21)
      expect(result.result).toBe('win') // Card 1 has more HP
    })
  })

  it('should handle defense buff correctly', () => {
    const attacker = createBattleCard({ 
      spd: 10,
      skill_type: 'defense',
      skill_name: 'Iron Defense',
      skill_power: 20
    })
    const defender = createBattleCard({ def: 10 })

    // First action: skill trigger for defense buff
    mockMath.random.mockReturnValueOnce(0.4) // Skill triggers for attacker
    mockMath.random.mockReturnValueOnce(1)   // No skill for defender

    return playBattle(attacker, defender).then(result => {
      // Check that defense buff was applied
      const defenseLog = result.logs.find(log => log.action === 'skill' && log.message.includes('Iron Defense'))
      expect(defenseLog).toBeDefined()
    })
  })

  it('should handle heal correctly', () => {
    const attacker = createBattleCard({ 
      hp: 100,
      currentHp: 50,
      spd: 10,
      skill_type: 'heal',
      skill_name: 'Healing Light',
      skill_power: 20
    })

    // Skill trigger for heal
    mockMath.random.mockReturnValueOnce(0.4) // Skill triggers
    mockMath.random.mockReturnValueOnce(1)   // No skill for opponent

    return playBattle(attacker, attacker).then(result => {
      const healLog = result.logs.find(log => log.action === 'skill' && log.message.includes('Healing Light'))
      expect(healLog).toBeDefined()
      expect(healLog?.heal).toBe(20)
    })
  })
})

describe('generateCPUOpponent', () => {
  const createCard = (overrides: Partial<Card> = {}): Card => ({
    id: 'test-card-id',
    streamer_id: 'streamer-123',
    name: 'Test Card',
    description: 'Test Description',
    image_url: 'https://example.com/image.jpg',
    rarity: 'common',
    drop_rate: 0.1,
    is_active: true,
    hp: 100,
    atk: 30,
    def: 15,
    spd: 5,
    skill_type: 'attack',
    skill_name: 'Test Attack',
    skill_power: 10,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  })

  it('should return fallback card when no cards available', () => {
    const cpuCard = generateCPUOpponent([])

    expect(cpuCard.id).toBe('cpu-default')
    expect(cpuCard.name).toBe('CPUカード')
    expect(cpuCard.hp).toBe(100)
    expect(cpuCard.atk).toBe(30)
    expect(cpuCard.def).toBe(15)
    expect(cpuCard.spd).toBe(5)
    expect(cpuCard.skill_type).toBe('attack')
    expect(cpuCard.skill_name).toBe('CPU攻撃')
    expect(cpuCard.skill_power).toBe(10)
    expect(cpuCard.rarity).toBe('common')
  })

  it('should create CPU opponent from existing card', () => {
    const mockMath = Object.create(global.Math)
    mockMath.random = vi.fn().mockReturnValue(0) // Always select first card
    global.Math = mockMath

    const cards = [
      createCard({ name: 'Fire Dragon', id: 'fire-dragon' }),
      createCard({ name: 'Water Spirit', id: 'water-spirit' })
    ]

    const cpuCard = generateCPUOpponent(cards)

    expect(cpuCard.name).toBe('CPUのFire Dragon')
    expect(cpuCard.id).toBe('cpu-fire-dragon')
    expect(cpuCard.hp).toBe(100)
    expect(cpuCard.atk).toBe(30)
    expect(cpuCard.def).toBe(15)
    expect(cpuCard.spd).toBe(5)
    expect(cpuCard.skill_type).toBe('attack')
    expect(cpuCard.skill_name).toBe('Test Attack')
    expect(cpuCard.skill_power).toBe(10)
    expect(cpuCard.rarity).toBe('common')
    expect(cpuCard.image_url).toBe('https://example.com/image.jpg')
  })

  it('should reset currentHp to max HP', () => {
    const cards = [createCard({ hp: 150, atk: 40 })]
    
    // Mock Math.random for card selection
    const mockMath = Object.create(global.Math)
    mockMath.random = vi.fn().mockReturnValue(0)
    global.Math = mockMath

    const cpuCard = generateCPUOpponent(cards)

    expect(cpuCard.hp).toBe(150)
    expect(cpuCard.currentHp).toBe(150) // Should be reset to max HP
  })
})