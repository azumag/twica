import { getSession } from '@/lib/session'
import { NextResponse } from 'next/server'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { setCSRFToken } from '@/lib/csrf'
import { logger } from '@/lib/logger'

/**
 * セッション取得 API。
 *
 * CSRF 設計（HttpOnly Cookie + Origin/Referer 方式、src/lib/csrf.ts 参照）に従い、
 * クライアントは CSRF トークンを直接受け取らない。本エンドポイントは副作用として
 * CSRF トークン Cookie を発行（または既存値を保持）するため、CSRF Cookie が欠落した
 * 状態で 403 を受け取ったクライアントが本エンドポイントを叩いてから再試行する流れに
 * 利用される（`LogoutButton.tsx` 等を参照）。レスポンスヘッダで token を返す
 * Synchronizer Token 方式は採用しない。
 */
export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 })
    }

    const response = NextResponse.json(session)

    try {
      // CSRF Cookie の遅延発行 / 維持を行う。トークン値はクライアントに返さない。
      await setCSRFToken()
    } catch (error) {
      logger.warn('Session API: failed to refresh CSRF token', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    return response
  } catch (error) {
    return handleApiError(error, "Session API: GET")
  }
}
