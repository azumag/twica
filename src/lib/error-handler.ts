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