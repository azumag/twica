import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger'
// #663 (#570 パイロット踏襲): pg 直結（postgres.js + Drizzle）経路。
// このハンドラは所有権チェックの読み取りとメッセージ INSERT が混在するため、
// isPgWriteEnabled()（'pg' モードのみ）で DB アクセス全体を分岐する（読み書きで
// 経路が混ざると障害切り分けが困難になるため。sub-check.ts 冒頭コメント参照）。
// フラグ未設定時（既定 'postgrest'）は誰も getDb() を呼ばず、既存の supabase-js
// 実装が 1 文字も変わらず従来どおり実行される（挙動不変が最重要安全要件）。
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'
import { normalizePgTimestamp } from '@/lib/support-inquiries'
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

    // #663: 読み書き混在ハンドラのため DB アクセス全体を isPgWriteEnabled() で分岐
    // （冒頭 import コメント参照）。フラグ未設定時は素通りし、下の既存 supabase-js
    // 実装が従来どおり実行される。
    if (isPgWriteEnabled()) {
      // 問い合わせの存在確認と所有権チェック。
      // 既存の .single() は id が PRIMARY KEY（migration 00019）で最大 1 行のため、
      // .limit(1) + rows[0] ?? null が同じ外部挙動（0 行 = null → 404）。
      // 取得エラーも既存実装が inquiryError || !inquiry → 404 に落とすのに合わせ、
      // catch して 404（失敗詳細は withDbRetry の [db:pg] warn ログに残る）。
      let inquiryRow: { id: string; status: string; twitch_user_id: string } | null
      try {
        const rows = await withDbRetry(
          async () => {
            // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
            // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
            const { db } = await getDb()
            return db
              .select({
                id: supportInquiriesTable.id,
                status: supportInquiriesTable.status,
                twitch_user_id: supportInquiriesTable.twitch_user_id,
              })
              .from(supportInquiriesTable)
              .where(
                and(
                  eq(supportInquiriesTable.id, id),
                  eq(supportInquiriesTable.twitch_user_id, session.twitchUserId)
                )
              )
              .limit(1)
          },
          'POST /api/support-inquiries/[id]/messages(inquiry)',
          // 読み取り専用クエリのため冪等（リトライ可）
          { idempotent: true },
        )
        inquiryRow = rows[0] ?? null
      } catch {
        inquiryRow = null
      }

      if (!inquiryRow) {
        return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
      }

      // closedステータスの問い合わせには返信不可
      if (inquiryRow.status === 'closed') {
        return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_CLOSED }, { status: 400 })
      }

      // メッセージ追加
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .insert(supportInquiryMessagesTable)
              .values({
                inquiry_id: id,
                sender_type: 'user',
                sender_id: session.twitchUserId,
                body: messageBody.trim(),
              })
              // 既存の .select('id, inquiry_id, sender_type, sender_id, body,
              // created_at').single() に対応（挿入行の同一列を返す）
              .returning({
                id: supportInquiryMessagesTable.id,
                inquiry_id: supportInquiryMessagesTable.inquiry_id,
                sender_type: supportInquiryMessagesTable.sender_type,
                sender_id: supportInquiryMessagesTable.sender_id,
                body: supportInquiryMessagesTable.body,
                created_at: supportInquiryMessagesTable.created_at,
              })
          },
          'POST /api/support-inquiries/[id]/messages(insert)',
          // ON CONFLICT の無い INSERT は再実行で二重投稿になりうるため非冪等
          // （既定 = リトライなし）
        )
        const message = rows[0]
        // created_at の正規化: PostgREST は ISO 8601、pg 直結は PG テキスト形式を
        // 返す。このレスポンスはブラウザクライアントへ直接返る API のため、
        // ISO 8601 に正規化して外部契約を PostgREST 経路と一致させる
        // （src/lib/support-inquiries.ts の normalizePgTimestamp コメント参照。
        // 現行の唯一の呼び出し元 InquiryThread.tsx はレスポンス body を読まずに
        // router.refresh() するが、API 契約として揃えておく）。
        return NextResponse.json(
          { message: { ...message, created_at: normalizePgTimestamp(message.created_at) } },
          { status: 201 }
        )
      } catch (error) {
        // 既存実装の messageError 分岐（log + 500）と同じ外部挙動
        logger.error('Failed to add inquiry message', { error })
        return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
      }
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
