import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/support-inquiries/[id]/messages
 * 問い合わせへの返信を追加
 * 認証 + CSRF + 支援者プランチェック必須
 * closedステータスの問い合わせには返信不可
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // CSRF検証
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
    }

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
    const rateLimit = await checkRateLimit(rateLimits.supportInquiryReply, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
      )
    }

    const reqBody = await request.json()
    const { body: messageBody } = reqBody

    // バリデーション
    if (!messageBody || typeof messageBody !== 'string' || messageBody.trim().length === 0) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_BODY_REQUIRED }, { status: 400 })
    }
    if (messageBody.length > 2000) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_BODY_TOO_LONG }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // 問い合わせの存在確認と所有権チェック
    const { data: inquiry, error: inquiryError } = await supabase
      .from('support_inquiries')
      .select('id, status, twitch_user_id')
      .eq('id', id)
      .eq('twitch_user_id', session.twitchUserId)
      .single()

    if (inquiryError || !inquiry) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    // closedステータスの問い合わせには返信不可
    if (inquiry.status === 'closed') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_CLOSED }, { status: 400 })
    }

    // メッセージ追加
    const { data: message, error: messageError } = await supabase
      .from('support_inquiry_messages')
      .insert({
        inquiry_id: id,
        sender_type: 'user',
        sender_id: session.twitchUserId,
        body: messageBody.trim(),
      })
      .select('id, inquiry_id, sender_type, sender_id, body, created_at')
      .single()

    if (messageError) {
      logger.error('Failed to add inquiry message', { error: messageError.message })
      return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
    }

    return NextResponse.json({ message }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'POST /api/support-inquiries/[id]/messages')
  }
}
