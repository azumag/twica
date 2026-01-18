import { NextResponse } from 'next/server'

export async function GET() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

  if (!dsn) {
    return NextResponse.json({ error: 'DSN not configured' }, { status: 500 })
  }

  try {
    const dsnUrl = new URL(dsn)
    const sentryUrl = `https://${dsnUrl.host}/api/envelope/`

    const testPayload = JSON.stringify({
      dsn,
      sent_at: new Date().toISOString(),
      sdk: {
        name: 'test',
        version: '1.0.0'
      }
    })

    const response = await fetch(sentryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'Content-Length': Buffer.byteLength(testPayload).toString()
      },
      body: testPayload
    })

    return NextResponse.json({
      dsnHost: dsnUrl.host,
      sentryUrl,
      testUrl: `https://${dsnUrl.host}/api/0/`,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      success: response.ok
    })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to connect to Sentry',
      details: error instanceof Error ? error.message : 'Unknown error',
      dsn: dsn?.substring(0, 30) + '...'
    }, { status: 500 })
  }
}
