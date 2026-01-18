import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

export async function GET() {
  console.log('[Debug Sentry] Environment check:', {
    dsnSet: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    dsnPreview: process.env.NEXT_PUBLIC_SENTRY_DSN?.substring(0, 20) + '...',
    env: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  })

  return NextResponse.json({
    message: 'Debug info logged to console',
    timestamp: new Date().toISOString(),
  })
}

export async function POST() {
  console.log('[Debug Sentry] Attempting to capture message...')
  Sentry.captureMessage('Direct test message - no filters', 'info')
  console.log('[Debug Sentry] Message captured')

  console.log('[Debug Sentry] Attempting to capture exception...')
  try {
    throw new Error('Direct test exception - no filters')
  } catch (error) {
    Sentry.captureException(error)
    console.log('[Debug Sentry] Exception captured', error)
  }

  return NextResponse.json({
    message: 'Direct Sentry test completed',
    timestamp: new Date().toISOString(),
  })
}
