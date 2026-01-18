import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not allowed in production' }, { status: 403 })
  }

  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return NextResponse.json({ 
      error: 'Sentry DSN not configured' 
    }, { status: 500 })
  }

  try {
    throw new Error('Test server error from API')
  } catch (error) {
    Sentry.captureException(error)
    await Sentry.flush(2000)
    return NextResponse.json({ 
      success: true,
      message: 'Error captured in Sentry' 
    })
  }
}
