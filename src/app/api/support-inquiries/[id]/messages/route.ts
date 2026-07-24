import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session'

import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger.server'
import type { ApiRateLimitResponse } from '@/types/api'
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface AddInquiryMessagePgMessage {
  id: string
  inquiry_id: string
  sender_type: string
  sender_id: string
  body: string
  created_at: string | null
}

type AddInquiryMessagePgResult =
  | { outcome: 'not_found' }
  | { outcome: 'closed' }
  | { outcome: 'error' }
  | { outcome: 'success'; message: AddInquiryMessagePgMessage }

/**
 * POST /api/support-inquiries/[id]/messages の pg 直結実装 (#663)
 *
 * 読み取り（所有権 + status チェック）と書き込み（メッセージ INSERT）が混在する
 * ハンドラのため、token-manager.ts の getBotAccountForChatPg と同じ流儀で
 * この関数の中だけで完結する結果を受け取り、そのままレスポンスを組み立てる）。
 *
 * - 問い合わせの存在確認 + 所有権チェックは `.single()` 相当（id が PK のため
 *   LIMIT 1 + rows[0] ?? null）。0 行なら 'not_found'。
 * - status が 'closed' なら 'closed'。
 * - メッセージ INSERT は ON CONFLICT の無い一度きりの INSERT のため非冪等
 *   （既定 = リトライなし。接続断で「実際は成功したか不明」な状態のまま再送すると
 *   メッセージの二重作成の恐れがある）。
 */
async function addInquiryMessagePg(
  id: string,
  twitchUserId: string,
  messageBody: string
): Promise<AddInquiryMessagePgResult> {
  try {
    // 問い合わせの存在確認と所有権チェック
    const inquiryRows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            status: supportInquiriesTable.status,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
          })
          .from(supportInquiriesTable)
          .where(
            and(eq(supportInquiriesTable.id, id), eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          )
          .limit(1)
      },
      'support-inquiries/[id]/messages(fetch inquiry)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    const inquiry = inquiryRows[0] ?? null
    if (!inquiry) {
      return { outcome: 'not_found' }
    }

    // closedステータスの問い合わせには返信不可
    if (inquiry.status === 'closed') {
      return { outcome: 'closed' }
    }

    // メッセージ追加
    const messageRows = await withDbRetry(async () => {
      const { db } = await getDb()
      return db
        .insert(supportInquiryMessagesTable)
        .values({
          inquiry_id: id,
          sender_type: 'user',
          sender_id: twitchUserId,
          body: messageBody,
        })
        .returning({
          id: supportInquiryMessagesTable.id,
          inquiry_id: supportInquiryMessagesTable.inquiry_id,
          sender_type: supportInquiryMessagesTable.sender_type,
          sender_id: supportInquiryMessagesTable.sender_id,
          body: supportInquiryMessagesTable.body,
          created_at: supportInquiryMessagesTable.created_at,
        })
      // 非冪等のため withDbRetry の第3引数（idempotent オプション）は渡さない
    }, 'support-inquiries/[id]/messages(insert)')

    const message = messageRows[0]
    if (!message) {
      return { outcome: 'error' }
    }

    return { outcome: 'success', message }
  } catch (error) {
    logger.error('Failed to add inquiry message', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'error' }
  }
}

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

    // #663: 読み取り（所有権/status チェック）と書き込み（メッセージ INSERT）が
    // （token-manager.ts の getBotAccountForChat と同じ方針）。
    const result = await addInquiryMessagePg(id, session.twitchUserId, messageBody.trim())

    if (result.outcome === 'not_found') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }
    if (result.outcome === 'closed') {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_CLOSED }, { status: 400 })
    }
    if (result.outcome === 'error') {
      return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
    }

    return NextResponse.json({ message: result.message }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'POST /api/support-inquiries/[id]/messages')
  }
}
