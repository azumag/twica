import { NextResponse } from 'next/server'
import { logger } from './logger'
import { reportApiError, reportError } from './sentry/error-handler'
import { ERROR_MESSAGES } from './constants'

// report*Error() が async になったため、await してから NextResponse を返す
// 呼び出し元は `return handleApiError(error, ctx)` パターンで、
// async 関数内の return は Promise を自動的に await するため変更不要
// See: https://github.com/azumag/twica/issues/239

export async function handleApiError(error: unknown, context: string): Promise<NextResponse> {
  logger.error(`${context}:`, error)
  await reportApiError(context, 'API', error)

  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

export async function handleDatabaseError(error: unknown, context: string): Promise<NextResponse> {
  logger.error(`${context}:`, error)
  await reportError(error, { context, type: 'database' })
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}

export async function handleBlobError(error: unknown, context: string, additionalInfo?: Record<string, unknown>): Promise<NextResponse> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  logger.error(`${context}: ${errorMessage}`, additionalInfo)
  await reportError(error, { context, type: 'blob', ...additionalInfo })

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
