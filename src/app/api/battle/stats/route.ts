import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import type { UserCardWithDetails, BattleResult } from '@/types/database'
import { ERROR_MESSAGES, CPU_CARD_STRINGS } from '@/lib/constants'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    
    // Common select pattern for user_card with card details
    const USER_CARD_SELECT = `
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
    `
    
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleStats, identifier)

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
    
    // Get user data
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, twitch_user_id')
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get user's battle stats
    const { data: battleStats, error: statsError } = await supabaseAdmin
      .from('battle_stats')
      .select('id, total_battles, wins, losses, draws, win_rate, updated_at')
      .eq('user_id', userData.id)
      .single()

    if (statsError && statsError.code !== 'PGRST116') { // PGRST116 is "not found"
      return handleDatabaseError(statsError, "Failed to fetch battle stats")
    }

    // Get recent battles with all card details (including opponent card)
    const { data: recentBattles, error: battlesError } = await supabaseAdmin
      .from('battles')
      .select(`
        id,
        result,
        turn_count,
        battle_log,
        created_at,
        user_card:user_cards(
          ${USER_CARD_SELECT}
        ),
        opponent_card:cards(
          id,
          name
        )
      `)
      .eq('user_id', userData.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (battlesError) {
      return handleDatabaseError(battlesError, "Failed to fetch recent battles")
    }

    // Process battles without additional queries
    const battleHistory = (recentBattles || []).map((battle: Record<string, unknown>) => {
      const battleId = battle.id as string
      const result = battle.result as BattleResult
      const turnCount = battle.turn_count as number
      const createdAt = battle.created_at as string
      const userCard = battle.user_card
      const opponentCard = battle.opponent_card as { name: string } | null
      
      if (!userCard || typeof userCard !== 'object') {
        return {
          battleId,
          result,
          opponentCardName: opponentCard ? `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}` : CPU_CARD_STRINGS.DEFAULT_NAME,
          turnCount,
          createdAt,
          userCardName: 'Unknown Card'
        }
      }
      
      const userCardRecord = userCard as Record<string, unknown>
      const userCardData = userCardRecord?.card as { name: string } | null | undefined
      
      return {
        battleId,
        result,
        opponentCardName: opponentCard ? `${CPU_CARD_STRINGS.NAME_PREFIX}${opponentCard.name}` : CPU_CARD_STRINGS.DEFAULT_NAME,
        turnCount,
        createdAt,
        userCardName: userCardData?.name || 'Unknown Card'
      }
    })

    // Get card-specific statistics
    const { data: cardStats, error: cardStatsError } = await supabaseAdmin
      .from('battles')
      .select(`
        result,
        user_card:user_cards(
          ${USER_CARD_SELECT}
        )
      `)
      .eq('user_id', userData.id)

    if (cardStatsError) {
      return handleDatabaseError(cardStatsError, "Failed to fetch card stats")
    }

    // Aggregate card statistics
    const cardPerformanceMap = new Map()
    for (const battle of cardStats || []) {
      const battleData = battle as Record<string, unknown>
      const userCard = battleData.user_card
      
      if (!userCard || typeof userCard !== 'object') continue
      
      const userCardRecord = userCard as Record<string, unknown>
      const userCardData = userCardRecord.card as UserCardWithDetails['card'] | null
      
      if (!userCardData) continue
      
      const cardId = userCardData.id
      const cardName = userCardData.name
      const cardImage = userCardData.image_url
      const cardRarity = userCardData.rarity
      
      if (!cardPerformanceMap.has(cardId)) {
        cardPerformanceMap.set(cardId, {
          cardId,
          cardName,
          cardImage,
          cardRarity,
          totalBattles: 0,
          wins: 0,
          losses: 0,
          draws: 0
        })
      }
      
      const stats = cardPerformanceMap.get(cardId)
      stats.totalBattles++
      
      if (battleData.result === 'win') stats.wins++
      else if (battleData.result === 'lose') stats.losses++
      else if (battleData.result === 'draw') stats.draws++
    }

    // Convert to array and calculate win rates
    const cardStatsArray = Array.from(cardPerformanceMap.values())
      .map(card => ({
        ...card,
        winRate: card.totalBattles > 0 ? (card.wins / card.totalBattles) * 100 : 0
      }))
      .sort((a, b) => b.winRate - a.winRate) // Sort by win rate descending

    // Return default stats if none exist
    const defaultStats = {
      total_battles: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      win_rate: 0
    }

    const stats = battleStats || defaultStats

    return NextResponse.json({
      totalBattles: stats.total_battles,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      winRate: stats.win_rate,
      recentBattles: battleHistory,
      cardStats: cardStatsArray
    })

  } catch (error) {
    return handleApiError(error, "Battle Stats API")
  }
}