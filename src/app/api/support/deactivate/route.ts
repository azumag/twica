import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

/**
 * POST /api/support/deactivate
 * 全ライセンスを削除し、Basicプランに復帰する
 *
 * activate/route.ts と同一パターン（CSRF/セッション/レート制限）
 * deactivate_all_licenses RPC は冪等なので、Basic時に実行してもエラーにならない
 * リクエストボディは不要（ユーザーIDはセッションから取得）のためContent-Type検証は省略
 */
export async function POST(request: NextRequest) {
  // CSRF検証
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  // セッション取得
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.UNAUTHORIZED },
      { status: 401 }
    )
  }

  // レート制限チェック（activateとは独立した制限枠を使用）
  const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
  const rateLimit = await checkRateLimit(rateLimits.deactivatePlan, identifier)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 3600000) - Date.now()) / 1000))
        }
      }
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()
    const { data, error } = await supabaseAdmin.rpc('deactivate_all_licenses', {
      p_twitch_user_id: session.twitchUserId,
    })

    if (error) {
      return handleApiError(error, 'Support Deactivate API (RPC)')
    }

    const result = data as { success?: boolean; deleted_count?: number }

    logger.info(`[SupportDeactivate] Licenses deactivated: twitchUserId=***${session.twitchUserId.slice(-4)}, deletedCount=${result.deleted_count}`)

    return NextResponse.json({
      success: true,
      planType: 'basic',
    })
  } catch (error) {
    return handleApiError(error, 'Support Deactivate API')
  }
}
