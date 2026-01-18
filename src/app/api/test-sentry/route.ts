import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

export async function GET() {
  return NextResponse.json({
    dsnConfigured: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    dsnPreview: process.env.NEXT_PUBLIC_SENTRY_DSN?.substring(0, 30) + '...',
    env: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    nodeEnv: process.env.NODE_ENV,
  })
}

export async function POST() {
  Sentry.captureMessage('Debug: Manual test message from /api/test-sentry', 'info')

  try {
    throw new Error('Debug: Manual test error from /api/test-sentry')
  } catch (error) {
    Sentry.captureException(error)
  }

  return NextResponse.json({
    message: 'Sentry debug test completed',
    timestamp: new Date().toISOString(),
  })
}
