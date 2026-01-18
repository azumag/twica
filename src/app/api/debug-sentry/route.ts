import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { checkDebugAccess } from '@/lib/debug-access'

export async function GET(request: Request) {
  const accessCheck = checkDebugAccess(request)
  if (accessCheck) return accessCheck

  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  const env = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV

  return NextResponse.json({
    sentryConfigured: !!dsn,
    dsn: dsn ? dsn.substring(0, 30) + '...' : 'not set',
    environment: env,
    nodeEnv: process.env.NODE_ENV,
  })
}

export async function POST(request: Request) {
  const accessCheck = checkDebugAccess(request)
  if (accessCheck) return accessCheck

  try {
    Sentry.captureMessage('Sentry test message from debug endpoint', 'info')

    try {
      throw new Error('Sentry test error from debug endpoint')
    } catch (error) {
      Sentry.captureException(error)
    }

    return NextResponse.json({
      success: true,
      message: 'Test errors sent to Sentry',
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.substring(0, 30) + '...',
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to send test errors',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
