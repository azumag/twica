import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/announcements/read
 * お知らせを既読にするAPI
 * CSRF検証・レートリミット・セッション認証必須。
 * announcement_reads テーブルに UPSERT する。
 */
export async function POST(request: NextRequest) {
  try {
    // CSRF検証（既存パターン踏襲）
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    const session = await getSession()

    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    // レートリミット（認証後にユーザーID単位で制限）
    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimit = await checkRateLimit(rateLimits.announcementRead, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
      )
    }

    const body = await request.json()
    const { announcementId } = body

    // UUID形式バリデーション（不正なIDでのエラーログ汚染を防止）
    if (!announcementId || typeof announcementId !== 'string' || !UUID_REGEX.test(announcementId)) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.INVALID_REQUEST },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()

    // UNIQUE制約により重複INSERTはエラーになるため、upsertで冪等性を確保
    const { error } = await supabase
      .from('announcement_reads')
      .upsert(
        {
          announcement_id: announcementId,
          twitch_user_id: session.twitchUserId,
        },
        { onConflict: 'announcement_id,twitch_user_id' }
      )

    if (error) {
      logger.error('Failed to mark announcement as read', {
        error: error.message,
        announcementId,
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: ERROR_MESSAGES.INTERNAL_ERROR },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('Error in announcement read API', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
