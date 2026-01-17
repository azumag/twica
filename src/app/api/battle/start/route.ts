import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { type Card } from '@/types/database'
import { toBattleCard, playBattle, generateCPUOpponent } from '@/lib/battle'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleStart, identifier)

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
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
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const supabaseAdmin = getSupabaseAdmin()
    
    // Get user data
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (userError || !userData) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { userCardId } = body

    if (!userCardId) {
      return NextResponse.json(
        { error: 'userCardId is required' },
        { status: 400 }
      )
    }

    // Get user's card with details
    const { data: userCardData, error: userCardError } = await supabaseAdmin
      .from('user_cards')
      .select(`
        *,
        card:cards(
          *,
          streamer:streamers(*)
        )
      `)
      .eq('id', userCardId)
      .eq('user_id', userData.id)
      .single()

    if (userCardError || !userCardData) {
      return NextResponse.json(
        { error: 'Card not found or not owned by user' },
        { status: 404 }
      )
    }

    // Get all active cards for CPU opponent
    const { data: allCards, error: allCardsError } = await supabaseAdmin
      .from('cards')
      .select('*')
      .eq('is_active', true)

    if (allCardsError) {
      return NextResponse.json(
        { error: 'Failed to fetch cards for CPU opponent' },
        { status: 500 }
      )
    }

    // Convert to BattleCard format
    const userBattleCard = toBattleCard(userCardData.card)
    const opponentBattleCard = generateCPUOpponent(allCards as Card[])

    // Play the battle
    const battleResult = await playBattle(userBattleCard, opponentBattleCard)

    // Store battle in database
    const { data: battleData, error: battleError } = await supabaseAdmin
      .from('battles')
      .insert({
        user_id: userData.id,
        user_card_id: userCardId,
        opponent_card_id: opponentBattleCard.id.startsWith('cpu-') 
          ? allCards[0]?.id // Use first card as placeholder for CPU
          : opponentBattleCard.id,
        result: battleResult.result,
        turn_count: battleResult.turnCount,
        battle_log: battleResult.logs
      })
      .select()
      .single()

    if (battleError) {
      logger.error('Failed to save battle:', battleError)
      return NextResponse.json(
        { error: 'Failed to save battle' },
        { status: 500 }
      )
    }

    // Return battle result with card details
    return NextResponse.json({
      battleId: battleData.id,
      result: battleResult.result,
      turnCount: battleResult.turnCount,
      userCard: {
        id: userBattleCard.id,
        name: userBattleCard.name,
        hp: userBattleCard.hp,
        currentHp: battleResult.userHp,
        atk: userBattleCard.atk,
        def: userBattleCard.def,
        spd: userBattleCard.spd,
        skill_type: userBattleCard.skill_type,
        skill_name: userBattleCard.skill_name,
        image_url: userBattleCard.image_url,
        rarity: userBattleCard.rarity
      },
      opponentCard: {
        id: opponentBattleCard.id,
        name: opponentBattleCard.name,
        hp: opponentBattleCard.hp,
        currentHp: battleResult.opponentHp,
        atk: opponentBattleCard.atk,
        def: opponentBattleCard.def,
        spd: opponentBattleCard.spd,
        skill_type: opponentBattleCard.skill_type,
        skill_name: opponentBattleCard.skill_name,
        image_url: opponentBattleCard.image_url,
        rarity: opponentBattleCard.rarity
      },
      logs: battleResult.logs
    })

  } catch (error) {
    logger.error('Battle start error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}