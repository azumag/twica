import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session'

import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger.server'
import type { ApiRateLimitResponse } from '@/types/api'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() / isPgWriteEnabled() が false を返すため getDb() は一切
// 呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SupportInquiryDetailDriverError {
  message: string
}

/**
 * GET /api/support-inquiries/[id] の問い合わせ本体取得の pg 直結実装 (#663)
 * PostgREST 実装との対応: `.single()` は id が PK のため LIMIT 1 + rows[0] ?? null
 * で同じ外部挙動（0 行ならルート側で INQUIRY_NOT_FOUND の 404 を返す）。
 */
async function fetchInquiryByIdPg(
  id: string,
  twitchUserId: string
): Promise<{ data: unknown | null; error: SupportInquiryDetailDriverError | null }> {
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
          .where(
            and(eq(supportInquiriesTable.id, id), eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          )
          .limit(1)
      },
      'GET /api/support-inquiries/[id](inquiry)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * GET /api/support-inquiries/[id] のメッセージ一覧取得の pg 直結実装 (#663)
 * PostgREST 実装との対応: inquiry_id で絞り込み created_at 昇順で取得するだけの
 * 単純な読み取り。
 */
async function fetchInquiryMessagesPg(
  inquiryId: string
): Promise<{ data: unknown[] | null; error: SupportInquiryDetailDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiryMessagesTable.id,
            inquiry_id: supportInquiryMessagesTable.inquiry_id,
            sender_type: supportInquiryMessagesTable.sender_type,
            sender_id: supportInquiryMessagesTable.sender_id,
            body: supportInquiryMessagesTable.body,
            created_at: supportInquiryMessagesTable.created_at,
          })
          .from(supportInquiryMessagesTable)
          .where(eq(supportInquiryMessagesTable.inquiry_id, inquiryId))
          .orderBy(asc(supportInquiryMessagesTable.created_at))
      },
      'GET /api/support-inquiries/[id](messages)',
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
 * DELETE /api/support-inquiries/[id] の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: `.delete().eq(id).eq(twitch_user_id).select('id').single()`
 * は `.delete().where(and(eq(id), eq(twitch_user_id))).returning({ id })` の
 * rows[0] ?? null で同じ外部挙動（対象行なし・他ユーザー所有のいずれも 0 行削除
 * となり、ルート側で INQUIRY_NOT_FOUND の 404 を返す）。
 * id（PK）+ 所有権フィルタ指定の DELETE は再実行しても最終状態が同じ（2 回目は
 * 0 行削除）ため冪等（removeBlobFilePg と同じ判断。リトライ可）。
 */
async function deleteSupportInquiryPg(
  id: string,
  twitchUserId: string
): Promise<{ data: { id: string } | null; error: SupportInquiryDetailDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .delete(supportInquiriesTable)
          .where(
            and(eq(supportInquiriesTable.id, id), eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          )
          .returning({ id: supportInquiriesTable.id })
      },
      'DELETE /api/support-inquiries/[id]',
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

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

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const { data: inquiry, error: inquiryError } = await fetchInquiryByIdPg(id, session.twitchUserId)

    if (inquiryError || !inquiry) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    // メッセージを時系列順で取得
    const { data: messages, error: messagesError } = await fetchInquiryMessagesPg(id)

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

/**
 * DELETE /api/support-inquiries/[id]
 * 自分の問い合わせを削除する。
 *
 * REST の削除操作は対象リソース単位の認可が最重要なので、事前 GET に頼らず
 * DELETE クエリ自体へ twitch_user_id 条件を含める。これにより ID を推測されても
 * 他ユーザーの問い合わせを削除できず、関連メッセージは DB の ON DELETE CASCADE に任せる。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN, code: 'CSRF_VALIDATION_FAILED' },
        { status: 403 }
      )
    }

    const { id } = await params

    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    const plan = await getUserPlan(session.twitchUserId)
    if (plan === 'basic') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_SUPPORTER_ONLY }, { status: 403 })
    }

    if (!id || !UUID_REGEX.test(id)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 })
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimit = await checkRateLimit(rateLimits.supportInquiryReply, identifier)
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
        { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
      )
    }

    // #663: 書き込みのため isPgWriteEnabled() で分岐。
    const { data: deletedInquiry, error } = await deleteSupportInquiryPg(id, session.twitchUserId)

    if (error || !deletedInquiry) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return handleApiError(error, 'DELETE /api/support-inquiries/[id]')
  }
}
