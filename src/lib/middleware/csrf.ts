import { NextRequest, NextResponse } from 'next/server'
import { validateCSRFToken } from '@/lib/csrf'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'

/**
 * CSRF検証ミドルウェア - 高階関数
 * POST/PUT/DELETEリクエストに対してCSRFトークンを検証
 */
export function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Safe methods don't need CSRF protection
    const safeMethods = ['GET', 'HEAD', 'OPTIONS']
    if (safeMethods.includes(request.method.toUpperCase())) {
      return handler(request)
    }

    try {
      // POST/PUT/DELETE/PATCHリクエストはCSRFトークンを検証
      const validation = await validateCSRFToken(request)
      if (!validation.valid) {
        logger.error('CSRF validation failed in middleware', {
          url: request.url,
          method: request.method,
          error: validation.error,
        })
        return NextResponse.json(
          { error: ERROR_MESSAGES.FORBIDDEN },
          { status: 403 }
        )
      }

      return await handler(request)
    } catch (error) {
      // Log all errors with context
      logger.error('CSRF middleware error', {
        url: request.url,
        method: request.method,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
      
      // ハンドラーからの例外をキャッチして適切に処理
      return NextResponse.json(
        { error: ERROR_MESSAGES.INTERNAL_ERROR },
        { status: 500 }
      )
    }
  }
}