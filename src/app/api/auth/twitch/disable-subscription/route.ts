import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgWriteEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

const DISABLED_SUB_VERIFIED_AT = '9999-12-31T00:00:00.000Z'

/**
 * サブスク状態の手動無効化 UPDATE の pg 直結実装 (#663)
 * PostgREST 実装との対応: .select('twitch_user_id').maybeSingle() は
 * .returning({twitch_user_id}) の rows[0] ?? null と同じ外部挙動。書き込む値は
 * 固定値（DISABLED_SUB_VERIFIED_AT）のため、接続断リトライしても同じ内容を
 * 書く UPDATE ＝冪等。
 */
async function disableSubscriptionPg(
  twitchUserId: string
): Promise<{ data: { twitch_user_id: string } | null; error: { message: string } | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .update(usersTable)
          .set({
            twitch_has_sub: false,
            twitch_sub_verified_at: DISABLED_SUB_VERIFIED_AT,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .returning({ twitch_user_id: usersTable.twitch_user_id })
      },
      'disable-subscription',
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
 * Twitch サブスク状態を手動で無効化する POST API
 * 自動再チェックが走らないように far-future の verified_at を保存する。
 */
export async function POST(request: Request) {
  try {
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
        { error: ERROR_MESSAGES.NOT_AUTHENTICATED },
        { status: 401 }
      )
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.twitchDisableSubscription, identifier)
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      )
    }

    // #663: 書き込みのみのため isPgWriteEnabled() で分岐。
    const { data: updatedUser, error: updateError } = isPgWriteEnabled()
      ? await disableSubscriptionPg(session.twitchUserId)
      : await getSupabaseAdmin()
          .from('users')
          .update({
            twitch_has_sub: false,
            twitch_sub_verified_at: DISABLED_SUB_VERIFIED_AT,
          })
          .eq('twitch_user_id', session.twitchUserId)
          .select('twitch_user_id')
          .maybeSingle()

    if (updateError || !updatedUser) {
      logger.error('[TwitchSub] Failed to disable subscription status:', {
        twitchUserId: session.twitchUserId,
        error: updateError,
        updatedUser,
      })
      return NextResponse.json(
        { error: 'Failed to disable subscription status' },
        { status: 500 }
      )
    }

    logger.info('[TwitchSub] Subscription status disabled manually', {
      twitchUserId: session.twitchUserId,
    })

    return NextResponse.json({
      success: true,
      hasSub: false,
      twitchSubVerifiedAt: DISABLED_SUB_VERIFIED_AT,
    })
  } catch (error) {
    logger.error('[TwitchSub] disable-subscription error:', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
