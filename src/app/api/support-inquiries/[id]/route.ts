import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
// #663 (#570 パイロット踏襲): pg 直結（postgres.js + Drizzle）経路。
// フラグ未設定時（既定 'postgrest'）は誰も getDb() を呼ばず、既存の supabase-js
// 実装が 1 文字も変わらず従来どおり実行される（挙動不変が最重要安全要件）。
// DELETE ハンドラの書き込み経路でのみ使用（GET の読み取りは getInquiryWithMessages に一本化）。
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { supportInquiries as supportInquiriesTable } from '@/lib/db/schema'
import { getInquiryWithMessages } from '@/lib/support-inquiries'
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

    // #663 レビュー対応: DBアクセス（postgrest / pg 直結の分岐、所有権チェック、
    // 日付正規化、エラー時の外部挙動を含む）は src/lib/support-inquiries.ts の
    // getInquiryWithMessages に一本化。ここに存在していた ~90 行のインライン
    // 再実装は同関数と完全に同一の外部挙動だったため削除（レビュー指摘対応）。
    // - 0 件 / 所有権不一致 / DB エラー → null（→ 404 に変換）
    // - メッセージ取得のみ失敗 → { inquiry, messages: [] } で 200 継続
    // - pg 直結時の日付は ISO 8601 に正規化済み（normalizePgTimestamp 適用済み）
    const result = await getInquiryWithMessages(id, session.twitchUserId)

    if (!result) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    return NextResponse.json({ inquiry: result.inquiry, messages: result.messages })
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

    // #663: 書き込み（DELETE）を含むハンドラのため isPgWriteEnabled() で分岐
    // （'pg' モードのみ。'pg-read' では従来の PostgREST 経路のまま）。
    if (isPgWriteEnabled()) {
      // 既存 PostgREST 実装と同じく、DELETE クエリ自体に twitch_user_id 条件を
      // 含める（事前 GET に頼らないリソース単位の認可。関数冒頭コメント参照）。
      // 外部挙動パリティ:
      // - 存在しない id / 他ユーザーの問い合わせ → 0 行削除 → .single() のエラーと
      //   同じく 404（.returning() の rows[0] ?? null で 0 行を検出）
      // - DB エラー → 既存実装が error → 404 に落とすのに合わせ catch → 404
      //   （失敗詳細は withDbRetry の [db:pg] warn ログに残る）
      // - 関連メッセージの削除は両経路とも DB の ON DELETE CASCADE（migration 00019）
      //   に任せるため、アプリ層での差は生じない
      let deletedRow: { id: string } | null
      try {
        const rows = await withDbRetry(
          async () => {
            // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
            const { db } = await getDb()
            return db
              .delete(supportInquiriesTable)
              .where(
                and(
                  eq(supportInquiriesTable.id, id),
                  eq(supportInquiriesTable.twitch_user_id, session.twitchUserId)
                )
              )
              // 既存の .select('id').single() に対応（0 行削除の検出）
              .returning({ id: supportInquiriesTable.id })
          },
          'DELETE /api/support-inquiries/[id]',
          // DELETE は非冪等扱い（既定 = リトライなし）: 接続断（結果不明）後の
          // 再実行は「1 回目で削除済み → 2 回目は 0 行 → 404」となり、削除成功を
          // 404 と誤報告してしまうため自動リトライしない
        )
        deletedRow = rows[0] ?? null
      } catch {
        deletedRow = null
      }

      if (!deletedRow) {
        return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
      }

      return NextResponse.json({ success: true })
    }

    const supabase = getSupabaseAdmin()
    const { data: deletedInquiry, error } = await supabase
      .from('support_inquiries')
      .delete()
      .eq('id', id)
      .eq('twitch_user_id', session.twitchUserId)
      .select('id')
      .single()

    if (error || !deletedInquiry) {
      return NextResponse.json({ error: ERROR_MESSAGES.INQUIRY_NOT_FOUND }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return handleApiError(error, 'DELETE /api/support-inquiries/[id]')
  }
}
