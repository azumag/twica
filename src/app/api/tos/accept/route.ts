import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { ERROR_MESSAGES } from '@/lib/constants'

/**
 * POST /api/tos/accept
 * 利用規約への同意を記録するAPI
 * Records user's acceptance of Terms of Service
 */
export async function POST(request: NextRequest) {
  try {
    // セッションからユーザー情報を取得
    // Get user info from session
    const session = await getSession()

    if (!session) {
      // 未認証の場合は401エラーを返す
      // Return 401 if user is not authenticated
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    const supabaseAdmin = getSupabaseAdmin()

    // 利用規約同意日時を更新
    // Update TOS acceptance timestamp
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        tos_accepted_at: new Date().toISOString(),
      })
      .eq('twitch_user_id', session.twitchUserId)

    if (error) {
      logger.error('Failed to update TOS acceptance', {
        error: error.message,
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: 'Failed to record TOS acceptance' },
        { status: 500 }
      )
    }

    logger.info('TOS accepted', {
      twitchUserId: session.twitchUserId,
      acceptedAt: new Date().toISOString(),
    })

    // 成功した場合はダッシュボードへリダイレクトするURLを返す
    // Return success with redirect URL to dashboard
    return NextResponse.json({
      success: true,
      redirectUrl: '/dashboard',
    })
  } catch (error) {
    logger.error('Error in TOS accept API', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}

/**
 * GET /api/tos/accept
 * 現在のユーザーのTOS同意状態を確認するAPI
 * Check current user's TOS acceptance status
 */
export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    const supabaseAdmin = getSupabaseAdmin()

    // ユーザーのTOS同意状態を取得
    // Get user's TOS acceptance status
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('tos_accepted_at')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    if (error) {
      logger.error('Failed to check TOS acceptance', {
        error: error.message,
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: 'Failed to check TOS acceptance' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      accepted: user?.tos_accepted_at !== null,
      acceptedAt: user?.tos_accepted_at,
    })
  } catch (error) {
    logger.error('Error in TOS check API', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
