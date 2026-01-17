import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { type Card } from '@/types/database'
import { toBattleCard, playBattle, generateCPUOpponent } from '@/lib/battle'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import { reportBattleError } from '@/lib/sentry/error-handler'
import { setUserContext, setRequestContext, setGameContext } from '@/lib/sentry/user-context'

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  setRequestContext(requestId, '/api/battle/start')
  
  let session: { twitchUserId: string; twitchUsername: string; broadcasterType?: string } | null = null
  
  try {
    session = await getSession()
    
    if (session) {
      setUserContext({
        twitchUserId: session.twitchUserId,
        twitchUsername: session.twitchUsername,
        broadcasterType: session.broadcasterType,
      })
    }
    
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
      return handleDatabaseError(userError ?? new Error('User not found'), "Battle Start API: Failed to fetch user data")
    }

    const body = await request.json()
    const { userCardId } = body
    
    if (userCardId) {
      setGameContext({ cardId: userCardId })
    }

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
      return handleDatabaseError(userCardError ?? new Error('Card not found or not owned by user'), "Battle Start API: Failed to fetch user card")
    }

    // Get all active cards for CPU opponent
    const { data: allCards, error: allCardsError } = await supabaseAdmin
      .from('cards')
      .select('*')
      .eq('is_active', true)

    if (allCardsError) {
      return handleDatabaseError(allCardsError, "Battle Start API: Failed to fetch cards for CPU opponent")
    }

    // Convert to BattleCard format
    const userBattleCard = toBattleCard(userCardData.card)
    const opponentBattleCard = generateCPUOpponent(allCards as Card[])

    // Play the battle
    const battleResult = await playBattle(userBattleCard, opponentBattleCard)

    // Prepare opponent card data for storage
    const opponentCardData = opponentBattleCard.id.startsWith('cpu-') ? {
      id: opponentBattleCard.id,
      name: opponentBattleCard.name,
      hp: opponentBattleCard.hp,
      atk: opponentBattleCard.atk,
      def: opponentBattleCard.def,
      spd: opponentBattleCard.spd,
      skill_type: opponentBattleCard.skill_type,
      skill_name: opponentBattleCard.skill_name,
      image_url: opponentBattleCard.image_url,
      rarity: opponentBattleCard.rarity
    } : null

    // Store battle in database
    const { data: battleData, error: battleError } = await supabaseAdmin
      .from('battles')
      .insert({
        user_id: userData.id,
        user_card_id: userCardId,
        opponent_card_id: opponentBattleCard.id.startsWith('cpu-') ? null : opponentBattleCard.id,
        opponent_card_data: opponentCardData,
        result: battleResult.result,
        turn_count: battleResult.turnCount,
        battle_log: battleResult.logs
      })
      .select()
      .single()
      
    if (battleData) {
      setGameContext({ 
        battleId: battleData.id,
        outcome: battleResult.result 
      })
    }

    if (battleError) {
      return handleDatabaseError(battleError, "Battle Start API: Failed to save battle")
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
    if (session) {
      reportBattleError(error, {
        battleId: undefined, // Not created yet due to error
        userId: session.twitchUserId,
        round: undefined, // Battle hasn't started
      })
    } else {
      reportBattleError(error, {})
    }
    
    return handleApiError(error, "Battle Start API: General")
  }
}