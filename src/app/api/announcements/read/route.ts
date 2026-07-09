import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgWriteEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { announcementReads as announcementReadsTable } from '@/lib/db/schema'

/**
 * announcement_reads への UPSERT の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: onConflict('announcement_id,twitch_user_id') は
 * この複合カラムに対する UNIQUE 制約を conflict target とした
 * INSERT ... ON CONFLICT DO UPDATE と等価。payload に含まれる列は conflict
 * target 自身（announcement_id / twitch_user_id）のみで、それ以外の列
 * （read_at 等）を更新しないため、DO UPDATE で書き戻しても値は変化しない
 * ＝ DO NOTHING と実質的に同じ最終状態になる。ここでは意図をそのまま表せる
 * onConflictDoNothing を使う。read_at の DB 側 DEFAULT now() は INSERT 時のみ
 * 適用されるため、重複呼び出しで既読日時が上書きされることもない（既存の
 * postgrest 経路と同じ挙動）。
 *
 * 書き込む値は固定（announcementId / twitchUserId）のため、接続断リトライしても
 * 同じ内容を書く UPSERT ＝冪等。
 */
async function upsertAnnouncementReadPg(
  announcementId: string,
  twitchUserId: string
): Promise<{ error: { message: string } | null }> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .insert(announcementReadsTable)
          .values({ announcement_id: announcementId, twitch_user_id: twitchUserId })
          .onConflictDoNothing({
            target: [announcementReadsTable.announcement_id, announcementReadsTable.twitch_user_id],
          })
      },
      'announcements/read(upsert)',
      { idempotent: true },
    )
    return { error: null }
  } catch (error) {
    return {
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

// UUID v4形式のバリデーション
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    // UNIQUE制約により重複INSERTはエラーになるため、upsertで冪等性を確保
    // #663: 書き込みのため isPgWriteEnabled() で分岐。
    const { error } = isPgWriteEnabled()
      ? await upsertAnnouncementReadPg(announcementId, session.twitchUserId)
      : await getSupabaseAdmin()
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
