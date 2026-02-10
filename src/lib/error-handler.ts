import { NextResponse } from 'next/server'
import { logger } from './logger'
import { ERROR_MESSAGES } from './constants'

// logger.error() が Supabase errors テーブルに自動記録するため、
// 個別の reportApiError()/reportError() 呼び出しは不要。
// await logger.error() で Supabase 記録完了を待機し、
// Cloudflare Workers でレスポンス返却前に記録を確定させる。
// See: https://github.com/azumag/twica/issues/262

export async function handleApiError(error: unknown, context: string): Promise<NextResponse> {
  await logger.error(`${context}:`, error)
  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

export async function handleDatabaseError(error: unknown, context: string): Promise<NextResponse> {
  await logger.error(`${context}:`, error)
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}

export async function handleBlobError(error: unknown, context: string, additionalInfo?: Record<string, unknown>): Promise<NextResponse> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  await logger.error(`${context}: ${errorMessage}`, error, additionalInfo)

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
