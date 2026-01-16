import { NextResponse } from 'next/server'
import { logger } from './logger'

export function handleApiError(error: unknown, context: string): Response {
  logger.error(`${context}:`, error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export function handleDatabaseError(error: unknown, context: string): Response {
  logger.error(`${context}:`, error)
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}