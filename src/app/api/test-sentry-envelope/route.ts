import { NextResponse } from 'next/server'

export async function GET() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

  if (!dsn) {
    return NextResponse.json({ error: 'DSN not configured' }, { status: 500 })
  }

  try {
    const dsnParts = dsn.split('@')
    const publicKey = dsnParts[0].split('://')[1]
    const host = dsnParts[1].split('/')[0]
    const projectId = dsnParts[1].split('/')[1]

    const sentryUrl = `https://${host}/api/${projectId}/envelope/`

    const testEvent = {
      dsn,
      sent_at: new Date().toISOString(),
      event_id: crypto.randomUUID(),
      sdk: {
        name: 'node',
        version: '1.0.0'
      }
    }

    const payload = JSON.stringify(testEvent)
    const envelope = `{"event_id":"${testEvent.event_id}","dsn":"${dsn}","metadata":{}}\n{"type":"event","sample_rates":{}}\n${payload}`

    const response = await fetch(sentryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'Content-Length': Buffer.byteLength(envelope).toString()
      },
      body: envelope
    })

    return NextResponse.json({
      success: true,
      status: response.status,
      statusText: response.statusText,
      eventId: testEvent.event_id,
      url: sentryUrl,
      dsnHost: host,
      projectId
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      dsn: dsn?.substring(0, 30) + '...'
    }, { status: 500 })
  }
}
