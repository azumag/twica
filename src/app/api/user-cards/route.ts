import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier)

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

    // Get user's cards with details
    const { data: userCards, error: cardsError } = await supabaseAdmin
      .from('user_cards')
      .select(`
        *,
        card:cards(
          *,
          streamer:streamers(*)
        )
      `)
      .eq('user_id', userData.id)

    if (cardsError) {
      logger.error('Error fetching user cards:', cardsError)
      return NextResponse.json(
        { error: 'Failed to fetch user cards' },
        { status: 500 }
      )
    }

    return NextResponse.json(userCards || [])

  } catch (error) {
    logger.error('User cards get error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}