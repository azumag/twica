import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'
import type { UserCardWithDetails } from '@/types/database'
import { ERROR_MESSAGES } from '@/lib/constants'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    
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

    // Get recent battles with card details
    const { data: recentBattles, error: battlesError } = await supabaseAdmin
      .from('battles')
      .select(`
        id,
        result,
        turn_count,
        battle_log,
        created_at,
        opponent_card_id,
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
        )
      `)
      .eq('user_id', userData.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (battlesError) {
      return handleDatabaseError(battlesError, "Failed to fetch recent battles")
    }

    // Get opponent card names for recent battles
    const battleHistory = []
    for (const battle of recentBattles || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const battleData = battle as any
      const { data: opponentCard, error: opponentError } = await supabaseAdmin
        .from('cards')
        .select('name')
        .eq('id', battleData.opponent_card_id)
        .single()

      battleHistory.push({
        battleId: battleData.id,
        result: battleData.result,
        opponentCardName: opponentError ? 'CPUカード' : `CPUの${opponentCard.name}`,
        turnCount: battleData.turn_count,
        createdAt: battleData.created_at,
        userCardName: battleData.user_card.card.name
      })
    }

    // Get card-specific statistics
    const { data: cardStats, error: cardStatsError } = await supabaseAdmin
      .from('battles')
      .select(`
        result,
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
        )
      `)
      .eq('user_id', userData.id)

    if (cardStatsError) {
      return handleDatabaseError(cardStatsError, "Failed to fetch card stats")
    }

    // Aggregate card statistics
    const cardPerformanceMap = new Map()
    for (const battle of cardStats || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const battleData = battle as any
      const userCard = battleData.user_card as unknown as UserCardWithDetails
      if (!userCard?.card) continue
      
      const cardId = userCard.card.id
      const cardName = userCard.card.name
      const cardImage = userCard.card.image_url
      const cardRarity = userCard.card.rarity
      
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