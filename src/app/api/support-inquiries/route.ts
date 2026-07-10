import { NextRequest, NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { getUserPlan } from '@/lib/plan'
import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'
import { logger } from '@/lib/logger'
// #663 (#570 パイロット踏襲): pg 直結（postgres.js + Drizzle）経路。
// フラグ未設定時（既定 'postgrest'）は誰も getDb() を呼ばず、既存の supabase-js
// 実装が 1 文字も変わらず従来どおり実行される（挙動不変が最重要安全要件）。
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { supportInquiries as supportInquiriesTable } from '@/lib/db/schema'
import { normalizePgTimestamp } from '@/lib/support-inquiries'
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

    // #663 レビュー対応での検討結果: src/lib/support-inquiries.ts の
    // getUserInquiries は「あえて」再利用していない（コードレビューで重複を
    // 指摘されたが、意図的に統合を見送った）。理由は戻り値の外部契約が
    // 2点で本ハンドラの要件と一致しないため:
    //   1. エラー時の挙動: getUserInquiries は DB エラーを握り潰して空配列 []
    //      を返す（消費側が dashboard/inquiries/page.tsx の Server Component
    //      のみで、「取得失敗時は空一覧」の方が UX として自然なため）。
    //      一方この API ルートは DB エラーを 500 として呼び出し元に伝える
    //      契約（下の catch 節、既存テストにも規定あり）。空配列を返す関数を
    //      呼ぶと 500 と空一覧を区別できず、テストに失敗する。
    //   2. 日付表現: getUserInquiries は pg 直結時に日付を正規化しない
    //      （サーバー側 new Date() のみの消費を前提とした意図的な仕様。同ファイルの
    //      getUserInquiriesPg のコメント参照）。本ハンドラはブラウザへ直接
    //      レスポンスを返すため ISO 8601 への正規化が必須で契約が異なる。
    // 無理に統合すると外部挙動が変わる（または getUserInquiries 側の契約を破り
    // dashboard 側に影響しうる）ため、このハンドラは pg / postgrest 分岐込みの
    // 実装を維持する。読み取り専用ハンドラのため isPgReadEnabled() で分岐
    // （pg-read / pg の両モードで pg 直結）。フラグ未設定時は素通りし、下の
    // 既存 supabase-js 実装が従来どおり実行される。
    if (isPgReadEnabled()) {
      try {
        const rows = await withDbRetry(
          async () => {
            // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
            // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
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
              .where(eq(supportInquiriesTable.twitch_user_id, session.twitchUserId))
              .orderBy(desc(supportInquiriesTable.created_at))
          },
          'GET /api/support-inquiries',
          // 読み取り専用クエリのため冪等（リトライ可）
          { idempotent: true },
        )

        // 日付の正規化: PostgREST は ISO 8601、pg 直結は PG テキスト形式
        // （'2026-03-10 12:00:00.123456+00'）を返す。このレスポンスはブラウザ
        // クライアントへ直接返る API であり、消費側の Date パース実装（Safari 等）は
        // ISO 8601 以外を保証しないため、サーバー側で ISO 8601 に正規化して
        // 「ISO 8601 文字列」という外部契約を PostgREST 経路と一致させる
        // （詳細は normalizePgTimestamp のコメント参照）。
        const inquiries = rows.map((row) => ({
          ...row,
          created_at: normalizePgTimestamp(row.created_at),
          updated_at: normalizePgTimestamp(row.updated_at),
        }))
        return NextResponse.json({ inquiries })
      } catch (error) {
        // 既存実装の error 分岐（log + 500）と同じ外部挙動に揃える（外側の
        // handleApiError へ落とすとレスポンス生成経路が変わるため、ここで返す）
        logger.error('Failed to fetch support inquiries', { error })
        return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
      }
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

    // #663: 書き込み（INSERT）を含むハンドラのため isPgWriteEnabled() で分岐
    // （'pg' モードのみ。'pg-read' では従来の PostgREST 経路のまま。読み書きで
    // 経路が混ざると障害切り分けが困難になるため。sub-check.ts 冒頭コメント参照）。
    if (isPgWriteEnabled()) {
      try {
        const rows = await withDbRetry(
          async () => {
            // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
            const { db } = await getDb()
            // id / status / created_at / updated_at / github_issue_created は
            // 既存 PostgREST 経路の INSERT と同じく指定しない（DB DEFAULT に任せる）。
            // 特に github_issue_created は DEFAULT FALSE のまま挿入されることが重要:
            // 新規問い合わせの GitHub Issue 自動通知 (#643) は Cron Worker
            // (workers/error-reporter) が github_issue_created = false を
            // ポーリングする Transactional Outbox 方式で、ルート内に INSERT 後の
            // 後続処理は存在しない。両経路とも「DEFAULT FALSE で挿入 → Worker が
            // 検知」という同一のトリガ挙動になる。
            return db
              .insert(supportInquiriesTable)
              .values({
                twitch_user_id: session.twitchUserId,
                twitch_display_name: session.twitchDisplayName,
                category: category,
                subject: subject.trim(),
                body: inquiryBody.trim(),
              })
              // 既存の .select('id').single() に対応（挿入行の id 取得）
              .returning({ id: supportInquiriesTable.id })
          },
          'POST /api/support-inquiries',
          // ON CONFLICT の無い INSERT は再実行で二重作成（= Issue 二重通知）に
          // なりうるため非冪等（既定 = リトライなし）
        )
        return NextResponse.json({ id: rows[0].id }, { status: 201 })
      } catch (error) {
        // 既存実装の error 分岐（log + 500）と同じ外部挙動
        logger.error('Failed to create support inquiry', { error })
        return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
      }
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
