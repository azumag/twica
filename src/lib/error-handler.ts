import { NextResponse } from 'next/server'
import { logger } from './logger'
import { reportApiError, reportError } from './sentry/error-handler'

export function handleApiError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportApiError(context, 'API', error)

  // エラーメッセージの決定
  let userMessage = 'Internal server error';

  if (error instanceof Error) {
    // Errorインスタンスの場合
    userMessage = error.message || 'Internal server error';
  } else if (typeof error === 'string') {
    // 文字列の場合
    userMessage = error;
  } else if (error && typeof error === 'object') {
    // オブジェクトの場合（例: { message: '...', code: '...' }）
    if ('message' in error && typeof error.message === 'string') {
      userMessage = error.message;
    }
  }

  return NextResponse.json({ error: userMessage }, { status: 500 })
}

export function handleDatabaseError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportError(error, { context, type: 'database' })
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}