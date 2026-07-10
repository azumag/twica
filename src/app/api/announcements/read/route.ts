import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// announcement_reads への UPSERT（書き込み）を含むため isPgWriteEnabled() で
// DB アクセス部分を分岐する。既存 supabase-js 実装は 1 文字も変えず、
// フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { announcementReads as announcementReadsTable } from '@/lib/db/schema'

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 既読 UPSERT の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - supabase-js の .upsert(..., { onConflict: 'announcement_id,twitch_user_id' })
 *   は ON CONFLICT (announcement_id, twitch_user_id) DO UPDATE を発行するが、
 *   ペイロードは衝突キーの 2 列のみ（read_at を含まない）ため DO UPDATE で
 *   書かれる値は既存値と同一 = 最終状態は ON CONFLICT DO NOTHING と完全に等価
 *   （初回既読時の read_at が保持される）。よって Drizzle では
 *   onConflictDoNothing を使う。conflict target は migration 00016 の
 *   UNIQUE (announcement_id, twitch_user_id) 制約。
 * - 失敗時は既存の error 分岐と同じログ（error はメッセージ文字列）+ 500、
 *   成功時は { success: true } を返す（HTTP レスポンスのパリティ）。
 *
 * ON CONFLICT DO NOTHING の INSERT は再実行しても最終状態が変わらないため
 * 冪等（idempotent: true）としてリトライを opt-in する。
 */
async function markAnnouncementReadPg(
  announcementId: string,
  twitchUserId: string
): Promise<NextResponse> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .insert(announcementReadsTable)
          .values({
            announcement_id: announcementId,
            twitch_user_id: twitchUserId,
          })
          .onConflictDoNothing({
            target: [
              announcementReadsTable.announcement_id,
              announcementReadsTable.twitch_user_id,
            ],
          })
      },
      'announcementRead(upsert)',
      { idempotent: true },
    )
  } catch (error) {
    logger.error('Failed to mark announcement as read', {
      error: error instanceof Error ? error.message : String(error),
      announcementId,
      twitchUserId,
    })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}

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

    // #663: 書き込み（UPSERT）を含むため isPgWriteEnabled() で分岐。
    // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
    if (isPgWriteEnabled()) {
      return markAnnouncementReadPg(announcementId, session.twitchUserId)
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
