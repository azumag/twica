import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { ERROR_MESSAGES, CPU_CARD_STRINGS } from '@/lib/constants'
import type { 
  BattleLog, 
  BattleCard, 
  Card,
  UserCardWithDetails,
  CardWithStreamer
} from '@/types/database'

// Interface for the battle query result from Supabase
interface BattleQueryResult {
  id: string
  result: 'win' | 'lose' | 'draw'
  turn_count: number
  battle_log: unknown
  user_card: {
    user_id: string
    card_id: string
    obtained_at: string
    card: CardWithStreamer
  }[]
  opponent_card: CardWithStreamer[]
}

// Type guard for validating card data
function isValidCard(card: unknown): card is Card {
  if (!card || typeof card !== 'object') return false
  const c = card as Card
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.hp === 'number' &&
    typeof c.atk === 'number' &&
    typeof c.def === 'number' &&
    typeof c.spd === 'number' &&
    typeof c.skill_type === 'string' &&
    typeof c.skill_name === 'string' &&
    typeof c.skill_power === 'number' &&
    typeof c.rarity === 'string'
  )
}

// Type guard for validating battle log
function isValidBattleLog(log: unknown): log is BattleLog[] {
  if (!Array.isArray(log)) return false
  return log.every(item => {
    if (!item || typeof item !== 'object') return false
    const l = item as BattleLog
    return (
      typeof l.turn === 'number' &&
      (l.actor === 'user' || l.actor === 'opponent') &&
      (l.action === 'attack' || l.action === 'skill') &&
      typeof l.message === 'string'
    )
  })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ battleId: string }> }
) {
  try {
    const session = await getSession()
    
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleGet, identifier)

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      )
    }

    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    const supabaseAdmin = getSupabaseAdmin()
    const { battleId } = await context.params

    // Get user data
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, twitch_user_id')
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get battle with all card details (including opponent card)
    const { data: battleData, error: battleError } = await supabaseAdmin
      .from('battles')
      .select(`
        id,
        result,
        turn_count,
        battle_log,
        user_card:user_cards(
          user_id,
          card_id,
          obtained_at,
          card:cards(
            id,
            name,
            hp,
            atk,
            def,
            spd,
            skill_type,
            skill_name,
            skill_power,
            image_url,
            rarity,
            streamer:streamers(
              twitch_user_id
            )
          )
        ),
        opponent_card:cards(
          id,
          name,
          hp,
          atk,
          def,
          spd,
          skill_type,
          skill_name,
          skill_power,
          image_url,
          rarity
        )
      `)
      .eq('id', battleId)
      .eq('user_id', userData.id)
      .single()

    if (battleError || !battleData) {
      return handleDatabaseError(battleError ?? new Error('Battle not found'), "Failed to fetch battle data")
    }

    // Type the battle data using proper types
    const battle = battleData as unknown as BattleQueryResult
    const opponentCardRaw = battle.opponent_card

    // Validate opponent card
    const opponentCard = opponentCardRaw && opponentCardRaw.length > 0 && isValidCard(opponentCardRaw[0]) ? opponentCardRaw[0] : null

    // Validate and extract battle log early
    const battleLogRaw = battle.battle_log
    const logs = isValidBattleLog(battleLogRaw) ? battleLogRaw : []

    // Validate user card data with null safety
    const userCardDataRaw = battle.user_card
    if (!userCardDataRaw || typeof userCardDataRaw !== 'object') {
      return handleApiError(new Error('Invalid user card data'), "Battle Get API")
    }

    const userCardData = userCardDataRaw[0] as unknown as UserCardWithDetails
    const userCardRaw = userCardData.card
    if (!isValidCard(userCardRaw)) {
      return handleApiError(new Error('Invalid card data'), "Battle Get API")
    }

    const userCard = userCardRaw

    if (!opponentCard) {
      // If opponent card not found (might be CPU), create a default
      const cpuCard: BattleCard = {
        id: 'cpu-unknown',
        name: CPU_CARD_STRINGS.DEFAULT_NAME,
        hp: 100,
        currentHp: 0, // CPU card - no battle history
        atk: 30,
        def: 15,
        spd: 5,
        skill_type: 'attack',
        skill_name: CPU_CARD_STRINGS.DEFAULT_SKILL_NAME,
        skill_power: 10,
        image_url: null,
        rarity: 'common'
      }
      
      const userBattleCard: BattleCard = {
        id: userCard.id,
        name: userCard.name,
        hp: userCard.hp,
        currentHp: 0, // HP not tracked for CPU cards
        atk: userCard.atk,
        def: userCard.def,
        spd: userCard.spd,
        skill_type: userCard.skill_type,
        skill_name: userCard.skill_name,
        skill_power: userCard.skill_power,
        image_url: userCard.image_url,
        rarity: userCard.rarity
      }
      
      return NextResponse.json({
        battleId: battle.id,
        status: 'completed',
        result: battle.result,
        turnCount: battle.turn_count,
        userCard: userBattleCard,
        opponentCard: cpuCard,
        logs: logs
      })
    }

    // Calculate final HP from battle log (already validated above)
    let userHp = userCard.hp
    let opponentHp = opponentCard.hp

    logs.forEach(log => {
      if (log.actor === 'user' && log.damage) {
        opponentHp -= log.damage
      } else if (log.actor === 'opponent' && log.damage) {
        userHp -= log.damage
      }
      if (log.actor === 'user' && log.heal) {
        userHp = Math.min(userCard.hp, userHp + log.heal)
      } else if (log.actor === 'opponent' && log.heal) {
        opponentHp = Math.min(opponentCard.hp, opponentHp + log.heal)
      }
    })

    const userBattleCard: BattleCard = {
      id: userCard.id,
      name: userCard.name,
      hp: userCard.hp,
      currentHp: Math.max(0, userHp),
      atk: userCard.atk,
      def: userCard.def,
      spd: userCard.spd,
      skill_type: userCard.skill_type,
      skill_name: userCard.skill_name,
      skill_power: userCard.skill_power,
      image_url: userCard.image_url,
      rarity: userCard.rarity
    }

    const opponentBattleCard: BattleCard = {
      id: opponentCard.id,
      name: opponentCard.name.startsWith(CPU_CARD_STRINGS.NAME_PREFIX) ? opponentCard.name : `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}`,
      hp: opponentCard.hp,
      currentHp: Math.max(0, opponentHp),
      atk: opponentCard.atk,
      def: opponentCard.def,
      spd: opponentCard.spd,
      skill_type: opponentCard.skill_type,
      skill_name: opponentCard.skill_name,
      skill_power: opponentCard.skill_power,
      image_url: opponentCard.image_url,
      rarity: opponentCard.rarity
    }

    return NextResponse.json({
      battleId: battle.id,
      status: 'completed',
      result: battle.result,
      turnCount: battle.turn_count,
      userCard: userBattleCard,
      opponentCard: opponentBattleCard,
      logs: logs
    })

  } catch (error) {
    return handleApiError(error, "Battle Get API")
  }
}