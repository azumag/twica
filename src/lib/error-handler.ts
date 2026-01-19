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

export async function uploadWithRetry(
  fileName: string,
  buffer: Buffer,
  options: { access: 'public' },
  maxRetries: number = 3
): Promise<{ url: string } | { error: string }> {
  const { put } = await import('@vercel/blob')

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const blob = await put(fileName, buffer, options)
      return { url: blob.url }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'service unavailable', '503']
      const isTransient = transientErrors.some(err => errorMessage.toLowerCase().includes(err.toLowerCase()))

      if (!isTransient || attempt === maxRetries) {
        throw error
      }

      const delay = Math.pow(2, attempt) * 1000
      logger.warn(`Upload failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, errorMessage)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw new Error('Max retries exceeded')
}