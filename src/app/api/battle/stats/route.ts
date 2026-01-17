import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import type { UserCardWithDetails } from '@/types/database'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.battleStats, identifier)

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

    // Get user's battle stats
    const { data: battleStats, error: statsError } = await supabaseAdmin
      .from('battle_stats')
      .select('*')
      .eq('user_id', userData.id)
      .single()

    if (statsError && statsError.code !== 'PGRST116') { // PGRST116 is "not found"
      logger.error('Error fetching battle stats:', statsError)
      return NextResponse.json(
        { error: 'Failed to fetch battle stats' },
        { status: 500 }
      )
    }

    // Get recent battles with card details
    const { data: recentBattles, error: battlesError } = await supabaseAdmin
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
      .eq('user_id', userData.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (battlesError) {
      logger.error('Error fetching recent battles:', battlesError)
      return NextResponse.json(
        { error: 'Failed to fetch recent battles' },
        { status: 500 }
      )
    }

    // Get opponent card names for recent battles
    const battleHistory = []
    for (const battle of recentBattles || []) {
      const { data: opponentCard, error: opponentError } = await supabaseAdmin
        .from('cards')
        .select('name')
        .eq('id', battle.opponent_card_id)
        .single()

      battleHistory.push({
        battleId: battle.id,
        result: battle.result,
        opponentCardName: opponentError ? 'CPUカード' : `CPUの${opponentCard.name}`,
        turnCount: battle.turn_count,
        createdAt: battle.created_at,
        userCardName: battle.user_card.card.name
      })
    }

    // Get card-specific statistics
    const { data: cardStats, error: cardStatsError } = await supabaseAdmin
      .from('battles')
      .select(`
        result,
        user_card:user_cards(
          *,
          card:cards(
            *,
            streamer:streamers(*)
          )
        )
      `)
      .eq('user_id', userData.id)

    if (cardStatsError) {
      logger.error('Error fetching card stats:', cardStatsError)
      return NextResponse.json(
        { error: 'Failed to fetch card stats' },
        { status: 500 }
      )
    }

    // Aggregate card statistics
    const cardPerformanceMap = new Map()
    for (const battle of cardStats || []) {
      const userCard = battle.user_card as unknown as UserCardWithDetails
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
      
      if (battle.result === 'win') stats.wins++
      else if (battle.result === 'lose') stats.losses++
      else if (battle.result === 'draw') stats.draws++
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
      totalBattles: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winRate: 0
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
    logger.error('Battle stats error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}