import { NextResponse } from 'next/server'
import { logger } from './logger'
import { reportApiError, reportError } from './sentry/error-handler'
import { ERROR_MESSAGES } from './constants'

export function handleApiError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportApiError(context, 'API', error)

  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

export function handleDatabaseError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportError(error, { context, type: 'database' })
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}

export function handleBlobError(error: unknown, context: string, additionalInfo?: Record<string, unknown>): NextResponse {
  const errorMessage = error instanceof Error ? error.message : String(error)
  logger.error(`${context}: ${errorMessage}`, additionalInfo)
  reportError(error, { context, type: 'blob', ...additionalInfo })

  if (errorMessage.includes('quota') || errorMessage.includes('limit') || errorMessage.includes('507')) {
    return NextResponse.json({ error: 'Storage quota exceeded' }, { status: 507 })
  }

  if (errorMessage.includes('authentication') || errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
    return NextResponse.json({ error: 'Storage authentication failed' }, { status: 503 })
  }

  if (errorMessage.includes('service unavailable') || errorMessage.includes('503')) {
    return NextResponse.json({ error: 'Storage service temporarily unavailable' }, { status: 503 })
  }

  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

// Note: uploadWithRetry function was removed - R2 upload with retry is now in r2-client.ts
// 注意: uploadWithRetry関数は削除されました - R2アップロード（リトライ付き）はr2-client.tsにあります