import { NextRequest, NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'

/**
 * CSRF検証ミドルウェア - 高階関数
 * POST/PUT/DELETEリクエストに対してCSRFトークンを検証
 */
export function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    // GETリクエストは検証なしで通す
    if (request.method.toUpperCase() === 'GET') {
      return handler(request)
    }

    // POST/PUT/DELETEリクエストはCSRFトークンを検証
    const validation = await validateCSRFToken(request)
    if (!validation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    return handler(request)
  }
}