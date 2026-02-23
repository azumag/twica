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

const VALID_CATEGORIES = ['bug', 'feature', 'other'] as const

/**
 * GET /api/support-inquiries
 * 自分の問い合わせ一覧を取得
 * 認証 + 支援者プランチェック必須
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // 支援者プランチェック（basicは403）
    const plan = await getUserPlan(session.twitchUserId)
    if (plan === 'basic') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_SUPPORTER_ONLY }, { status: 403 })
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
    const { data, error } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('twitch_user_id', session.twitchUserId)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Failed to fetch support inquiries', { error: error.message })
      return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
    }

    return NextResponse.json({ inquiries: data || [] })
  } catch (error) {
    return handleApiError(error, 'GET /api/support-inquiries')
  }
}

/**
 * POST /api/support-inquiries
 * 新規問い合わせ作成
 * 認証 + CSRF + 支援者プランチェック必須
 */
export async function POST(request: NextRequest) {
  try {
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

    // レートリミット（投稿はスパム防止のため厳しめ）
    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimit = await checkRateLimit(rateLimits.supportInquiriesPost, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
      )
    }

    const body = await request.json()
    const { category, subject, body: inquiryBody } = body

    // バリデーション
    if (!VALID_CATEGORIES.includes(category)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_INVALID_CATEGORY }, { status: 400 })
    }
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_SUBJECT_REQUIRED }, { status: 400 })
    }
    if (subject.length > 200) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_SUBJECT_TOO_LONG }, { status: 400 })
    }
    if (!inquiryBody || typeof inquiryBody !== 'string' || inquiryBody.trim().length === 0) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_BODY_REQUIRED }, { status: 400 })
    }
    if (inquiryBody.length > 2000) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_BODY_TOO_LONG }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('support_inquiries')
      .insert({
        twitch_user_id: session.twitchUserId,
        twitch_display_name: session.twitchDisplayName,
        category: category,
        subject: subject.trim(),
        body: inquiryBody.trim(),
      })
      .select('id')
      .single()

    if (error) {
      logger.error('Failed to create support inquiry', { error: error.message })
      return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
    }

    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'POST /api/support-inquiries')
  }
}
