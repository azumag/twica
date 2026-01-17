import { NextResponse } from 'next/server'
import { logger } from './logger'
import { reportApiError, reportError } from './sentry/error-handler'

export function handleApiError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportApiError(context, 'API', error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export function handleDatabaseError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportError(error, { context, type: 'database' })
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}