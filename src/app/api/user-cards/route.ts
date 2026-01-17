import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getSession } from '@/lib/session'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError, handleDatabaseError } from '@/lib/error-handler'

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
      .select('id, twitch_user_id')
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (userError || !userData) {
      return handleDatabaseError(userError ?? new Error('User not found'), "Failed to fetch user data")
    }

    // Get user's cards with details
    const { data: userCards, error: cardsError } = await supabaseAdmin
      .from('user_cards')
      .select('id, user_id, card_id, obtained_at')
      .eq('user_id', userData.id)

    if (cardsError) {
      return handleDatabaseError(cardsError, "Failed to fetch user cards")
    }

    return NextResponse.json(userCards || [])

  } catch (error) {
    return handleApiError(error, "User Cards API")
  }
}