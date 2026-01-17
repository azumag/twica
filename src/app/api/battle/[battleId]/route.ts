import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'

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
      .select('*')
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get battle with details
    const { data: battleData, error: battleError } = await supabaseAdmin
      .from('battles')
      .select(`
        *,
        user_card:user_cards(
          *,
          card:cards(
            *,
            streamer:streamers(*)
          )
        )
      `)
      .eq('id', battleId)
      .eq('user_id', userData.id)
      .single()

    if (battleError || !battleData) {
      return handleDatabaseError(battleError ?? new Error('Battle not found'), "Failed to fetch battle data")
    }

    // Get opponent card details
    const { data: opponentCard, error: opponentError } = await supabaseAdmin
      .from('cards')
      .select('*')
      .eq('id', battleData.opponent_card_id)
      .single()

    if (opponentError) {
      // If opponent card not found (might be CPU), create a default
      const cpuCard = {
        id: 'cpu-unknown',
        name: 'CPUカード',
        hp: 100,
        atk: 30,
        def: 15,
        spd: 5,
        skill_type: 'attack' as const,
        skill_name: 'CPU攻撃',
        skill_power: 10,
        image_url: null,
        rarity: 'common' as const
      }
      
      return NextResponse.json({
        battleId: battleData.id,
        status: 'completed',
        result: battleData.result,
        turnCount: battleData.turn_count,
        userCard: {
          id: battleData.user_card.card.id,
          name: battleData.user_card.card.name,
          hp: battleData.user_card.card.hp,
          currentHp: 0, // Would need to calculate from battle log
          atk: battleData.user_card.card.atk,
          def: battleData.user_card.card.def,
          spd: battleData.user_card.card.spd,
          skill_type: battleData.user_card.card.skill_type,
          skill_name: battleData.user_card.card.skill_name,
          image_url: battleData.user_card.card.image_url,
          rarity: battleData.user_card.card.rarity
        },
        opponentCard: cpuCard,
        logs: battleData.battle_log || []
      })
    }

    // Calculate final HP from battle log
    const logs = (battleData.battle_log as Array<{
      turn: number
      actor: 'user' | 'opponent'
      action: 'attack' | 'skill'
      damage?: number
      heal?: number
      message: string
    }>) || []
    let userHp = battleData.user_card.card.hp
    let opponentHp = opponentCard.hp

    logs.forEach(log => {
      if (log.actor === 'user' && log.damage) {
        opponentHp -= log.damage
      } else if (log.actor === 'opponent' && log.damage) {
        userHp -= log.damage
      }
      if (log.actor === 'user' && log.heal) {
        userHp = Math.min(battleData.user_card.card.hp, userHp + log.heal)
      } else if (log.actor === 'opponent' && log.heal) {
        opponentHp = Math.min(opponentCard.hp, opponentHp + log.heal)
      }
    })

    return NextResponse.json({
      battleId: battleData.id,
      status: 'completed',
      result: battleData.result,
      turnCount: battleData.turn_count,
      userCard: {
        id: battleData.user_card.card.id,
        name: battleData.user_card.card.name,
        hp: battleData.user_card.card.hp,
        currentHp: Math.max(0, userHp),
        atk: battleData.user_card.card.atk,
        def: battleData.user_card.card.def,
        spd: battleData.user_card.card.spd,
        skill_type: battleData.user_card.card.skill_type,
        skill_name: battleData.user_card.card.skill_name,
        image_url: battleData.user_card.card.image_url,
        rarity: battleData.user_card.card.rarity
      },
      opponentCard: {
        id: opponentCard.id,
        name: opponentCard.name.startsWith('CPUの') ? opponentCard.name : `CPUの${opponentCard.name}`,
        hp: opponentCard.hp,
        currentHp: Math.max(0, opponentHp),
        atk: opponentCard.atk,
        def: opponentCard.def,
        spd: opponentCard.spd,
        skill_type: opponentCard.skill_type,
        skill_name: opponentCard.skill_name,
        image_url: opponentCard.image_url,
        rarity: opponentCard.rarity
      },
      logs: battleData.battle_log || []
    })

  } catch (error) {
    return handleApiError(error, "Battle Get API")
  }
}