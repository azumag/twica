import { NextResponse } from 'next/server'
import { checkDebugAccess } from '@/lib/debug-access'

export async function GET(request: Request) {
  const accessCheck = checkDebugAccess(request)
  if (accessCheck) return accessCheck

  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

  try {
    if (!dsn) {
      throw new Error('DSN is not configured')
    }

    const url = new URL(dsn.replace('://', '://test@'))
    const host = url.host
    const pathParts = url.pathname.split('/').filter(Boolean)
    const projectId = pathParts[0]

    if (!host || !projectId) {
      throw new Error('Invalid DSN format')
    }

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
      eventId: testEvent.event_id
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
