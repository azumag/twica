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
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() / isPgWriteEnabled() が false を返すため getDb() は一切
// 呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { supportInquiries as supportInquiriesTable } from '@/lib/db/schema'

const VALID_CATEGORIES = ['bug', 'feature', 'other'] as const

interface SupportInquiriesDriverError {
  message: string
}

/**
 * GET /api/support-inquiries の一覧取得の pg 直結実装 (#663)
 * PostgREST 実装との対応: twitch_user_id で絞り込み created_at 降順で取得する
 * だけの単純な読み取り。
 */
async function fetchSupportInquiriesPg(
  twitchUserId: string
): Promise<{ data: unknown[] | null; error: SupportInquiriesDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
            twitch_display_name: supportInquiriesTable.twitch_display_name,
            category: supportInquiriesTable.category,
            subject: supportInquiriesTable.subject,
            body: supportInquiriesTable.body,
            status: supportInquiriesTable.status,
            created_at: supportInquiriesTable.created_at,
            updated_at: supportInquiriesTable.updated_at,
          })
          .from(supportInquiriesTable)
          .where(eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          .orderBy(desc(supportInquiriesTable.created_at))
      },
      'GET /api/support-inquiries',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return { data: rows, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * POST /api/support-inquiries の新規作成の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: `.select('id').single()` は `.returning({ id })` の
 * rows[0] で同じ外部挙動。ON CONFLICT の無い一度きりの INSERT のため非冪等
 * （既定 = リトライなし。接続断で「実際は成功したか不明」な状態のまま再送すると
 * 問い合わせの二重作成の恐れがある）。
 */
async function insertSupportInquiryPg(payload: {
  twitchUserId: string
  twitchDisplayName: string
  category: string
  subject: string
  body: string
}): Promise<{ data: { id: string } | null; error: SupportInquiriesDriverError | null }> {
  try {
    const rows = await withDbRetry(async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db
        .insert(supportInquiriesTable)
        .values({
          twitch_user_id: payload.twitchUserId,
          twitch_display_name: payload.twitchDisplayName,
          category: payload.category,
          subject: payload.subject,
          body: payload.body,
        })
        .returning({ id: supportInquiriesTable.id })
    }, 'POST /api/support-inquiries')
    // 非冪等のため withDbRetry の第3引数（idempotent オプション）は渡さない
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

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

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const { data, error } = isPgReadEnabled()
      ? await fetchSupportInquiriesPg(session.twitchUserId)
      : await getSupabaseAdmin()
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

    // #663: 書き込みのため isPgWriteEnabled() で分岐。
    const { data, error } = isPgWriteEnabled()
      ? await insertSupportInquiryPg({
          twitchUserId: session.twitchUserId,
          twitchDisplayName: session.twitchDisplayName,
          category: category,
          subject: subject.trim(),
          body: inquiryBody.trim(),
        })
      : await getSupabaseAdmin()
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

    if (error || !data) {
      logger.error('Failed to create support inquiry', { error: error?.message })
      return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
    }

    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'POST /api/support-inquiries')
  }
}
