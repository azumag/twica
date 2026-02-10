import { NextResponse } from 'next/server'
import { logErrorFromLogger } from './sentry/error-handler'
import { ERROR_MESSAGES } from './constants'

// Cloudflare Workers ではレスポンス返却後にバックグラウンド Promise が打ち切られるため、
// Supabase 記録完了を await で確保する。logger.error（fire-and-forget）ではなく
// logErrorFromLogger を直接使用することで、記録の確実性を担保する。
async function logAndRecordError(
  message: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>
): Promise<void> {
  const args: unknown[] = additionalInfo ? [error, additionalInfo] : [error]
  console.error(`[ERROR] ${message}`, ...args)
  await logErrorFromLogger(message, args)
}

export async function handleApiError(error: unknown, context: string): Promise<NextResponse> {
  await logAndRecordError(`${context}:`, error)
  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

export async function handleDatabaseError(error: unknown, context: string): Promise<NextResponse> {
  await logAndRecordError(`${context}:`, error)
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}

export async function handleBlobError(error: unknown, context: string, additionalInfo?: Record<string, unknown>): Promise<NextResponse> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  await logAndRecordError(`${context}: ${errorMessage}`, error, additionalInfo)

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
