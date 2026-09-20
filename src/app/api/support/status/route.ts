import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getUserPlan, PLAN_STORAGE_BONUS } from '@/lib/plan'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'

/**
 * GET /api/support/status
 * 認証済みユーザーの現在のプラン情報を返す
 *
 * レスポンス:
 * - planType: 'basic' | 'support' | 'patron'
 * - storageBonusBytes: プランによる追加ストレージ容量（バイト）
 */
export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.UNAUTHORIZED },
      { status: 401 }
    )
  }

  try {
    const planType = await getUserPlan(session.twitchUserId)

    return NextResponse.json({
      planType,
      storageBonusBytes: PLAN_STORAGE_BONUS[planType],
    })
  } catch (error) {
    return handleApiError(error, 'Support Status API')
  }
}
