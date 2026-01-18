import * as Sentry from '@sentry/nextjs'
import { reportError, reportAuthError, reportApiError } from '@/lib/sentry/error-handler'
import { NextResponse } from 'next/server'

const TEST_USER_ID = 'test-user-id-12345'

const errorTests = [
  () => reportError(new Error('Test error from reportError function'), { 
    testType: 'generic',
    timestamp: new Date().toISOString() 
  }),
  () => reportAuthError(new Error('Test auth error'), { 
    provider: 'twitch', 
    action: 'login',
    userId: TEST_USER_ID 
  }),
  () => reportApiError('/test-sentry-handler', 'GET', new Error('Test API error'), {
    statusCode: 500,
    requestTime: Date.now()
  })
]

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not allowed in production' }, { status: 403 })
  }

  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return NextResponse.json({ 
      error: 'Sentry DSN not configured' 
    }, { status: 500 })
  }

  errorTests.forEach(test => test())
  
  await Sentry.flush(2000)
  
  return NextResponse.json({ 
    success: true,
    message: 'All errors captured in Sentry',
    errors: [
      'Generic error via reportError',
      'Auth error via reportAuthError',
      'API error via reportApiError'
    ]
  })
}
