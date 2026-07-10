import { NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { getSession } from '@/lib/session'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
// -----------------------------------------------------------------------------
// #663 (#570/#572 パターン踏襲): pg 直結経路。
// このルートの DB アクセスは users への UPDATE（書き込み）のみのため
// isPgWriteEnabled() で分岐する（pg-read では従来の PostgREST 経路のまま動く）。
// 既存 supabase-js 実装は無変更で残し（else 節への再インデントのみ）、
// フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

const DISABLED_SUB_VERIFIED_AT = '9999-12-31T00:00:00.000Z'

/**
 * サブスク状態の手動無効化 UPDATE の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - 既存の .update().eq().select('twitch_user_id').maybeSingle() は「マッチ 0 行」
 *   検出のための returning パターン。Drizzle の .returning() + rows[0] ?? null で
 *   同じ形状（users.twitch_user_id は UNIQUE（migration 00001）のため最大 1 行）。
 * - エラーは throw のまま伝播させ、ハンドラ側で既存経路の updateError と同じ
 *   「log + 500」に落とす。
 *
 * 冪等性: 固定値（false / far-future 定数）を書く UPDATE のため、リトライしても
 * 同じ最終状態になり冪等（idempotent: true）。
 */
async function disableSubscriptionPg(
  twitchUserId: string
): Promise<{ twitch_user_id: string } | null> {
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
    'disableSubscription(update)',
    { idempotent: true },
  )
  return rows[0] ?? null
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

    // #663: 書き込みのみのルートのため isPgWriteEnabled() で分岐。エラー時は
    // どちらの経路も updateError に集約し、後段の共有ロジック（既存の
    // 「updateError || !updatedUser → log + 500」）で同じ外部挙動に落とす。
    let updatedUser: { twitch_user_id: string } | null
    let updateError: unknown = null
    if (isPgWriteEnabled()) {
      try {
        updatedUser = await disableSubscriptionPg(session.twitchUserId)
      } catch (error) {
        updatedUser = null
        updateError = error
      }
    } else {
      const supabaseAdmin = getSupabaseAdmin()
      const { data, error } = await supabaseAdmin
        .from('users')
        .update({
          twitch_has_sub: false,
          twitch_sub_verified_at: DISABLED_SUB_VERIFIED_AT,
        })
        .eq('twitch_user_id', session.twitchUserId)
        .select('twitch_user_id')
        .maybeSingle()
      updatedUser = data
      updateError = error
    }

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
