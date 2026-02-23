import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { validateContentType } from '@/lib/request-validation'
import { handleApiError } from '@/lib/error-handler'
import { sha256 } from '@/lib/crypto-utils'
import { ERROR_MESSAGES, PLAN_CONFIG } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

/**
 * POST /api/support/activate
 * 支援コードをアクティベートし、ユーザーにライセンスを付与する
 *
 * フロー:
 * 1. CSRF検証
 * 2. セッション取得
 * 3. レート制限（5回/時間 - 総当り攻撃対策）
 * 4. Content-Type検証 + 入力バリデーション
 * 5. コードをSHA-256ハッシュ化
 * 6. activate_support_code RPC呼び出し（DB側で排他ロック）
 * 7. 結果に応じたレスポンス
 */
export async function POST(request: NextRequest) {
  // Content-Type検証
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

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

  // レート制限チェック（1時間5回、認証後にユーザーID単位で制限）
  const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
  const rateLimit = await checkRateLimit(rateLimits.activateCode, identifier)
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
    const body = await request.json()
    const { code, fanboxId } = body

    // 入力バリデーション
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.SUPPORT_CODE_REQUIRED },
        { status: 400 }
      )
    }

    if (code.length > PLAN_CONFIG.CODE_MAX_LENGTH) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.SUPPORT_CODE_TOO_LONG },
        { status: 400 }
      )
    }

    if (fanboxId && typeof fanboxId === 'string' && fanboxId.length > PLAN_CONFIG.FANBOX_ID_MAX_LENGTH) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FANBOX_ID_TOO_LONG },
        { status: 400 }
      )
    }

    // コードをSHA-256ハッシュ化（平文をDBに送信しない）
    const codeHash = await sha256(code.trim())

    const supabaseAdmin = getSupabaseAdmin()
    const { data, error } = await supabaseAdmin.rpc('activate_support_code', {
      p_code_hash: codeHash,
      p_twitch_user_id: session.twitchUserId,
      p_fanbox_id: fanboxId?.trim() || null,
    })

    if (error) {
      return handleApiError(error, 'Support Activate API (RPC)')
    }

    // RPCの結果をチェック
    const result = data as { error?: string; success?: boolean; plan_type?: string }

    if (result.error) {
      // RPCからのエラーを適切なHTTPレスポンスにマッピング
      const errorMap: Record<string, { message: string; status: number }> = {
        INVALID_CODE: { message: ERROR_MESSAGES.INVALID_SUPPORT_CODE, status: 404 },
        CODE_REVOKED: { message: ERROR_MESSAGES.SUPPORT_CODE_REVOKED, status: 410 },
        CODE_ROTATING: { message: ERROR_MESSAGES.SUPPORT_CODE_ROTATING, status: 410 },
        ALREADY_ACTIVATED: { message: ERROR_MESSAGES.SUPPORT_CODE_ALREADY_ACTIVATED, status: 409 },
      }

      const mapped = errorMap[result.error]
      if (mapped) {
        return NextResponse.json(
          { error: mapped.message },
          { status: mapped.status }
        )
      }

      // 未知のエラー
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNEXPECTED_ERROR },
        { status: 500 }
      )
    }

    logger.info(`[SupportActivate] Code activated: twitchUserId=***${session.twitchUserId.slice(-4)}, planType=${result.plan_type}`)

    return NextResponse.json({
      success: true,
      planType: result.plan_type,
    })
  } catch (error) {
    return handleApiError(error, 'Support Activate API')
  }
}
