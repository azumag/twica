import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/support-inquiries/[id]
 * 問い合わせ詳細 + メッセージ一覧を取得（自分のもののみ）
 * 認証 + 支援者プランチェック必須
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // 支援者プランチェック
    const plan = await getUserPlan(session.twitchUserId)
    if (plan === 'basic') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_SUPPORTER_ONLY }, { status: 403 })
    }

    // UUID形式バリデーション
    if (!id || !UUID_REGEX.test(id)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 })
    }

    // レートリミット
    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimit = await checkRateLimit(rateLimits.supportInquiriesGet, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
      )
    }

    const supabase = getSupabaseAdmin()

    // 問い合わせ本体を取得（ユーザーIDで所有権チェック）
    const { data: inquiry, error: inquiryError } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('id', id)
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (inquiryError || !inquiry) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    // メッセージを時系列順で取得
    const { data: messages, error: messagesError } = await supabase
      .from('support_inquiry_messages')
      .select('id, inquiry_id, sender_type, sender_id, body, created_at')
      .eq('inquiry_id', id)
      .order('created_at', { ascending: true })

    if (messagesError) {
      logger.error('Failed to fetch inquiry messages', { error: messagesError.message })
    }

    return NextResponse.json({
      inquiry,
      messages: messages || [],
    })
  } catch (error) {
    return handleApiError(error, 'GET /api/support-inquiries/[id]')
  }
}
