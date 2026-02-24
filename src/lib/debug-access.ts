import { NextResponse } from 'next/server'
import { DEBUG_CONFIG, ERROR_MESSAGES } from '@/lib/constants'

export function checkDebugAccess(request: Request): NextResponse | null {
  if (process.env.NODE_ENV === DEBUG_CONFIG.PRODUCTION_ENV) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.DEBUG_ENDPOINT_NOT_AVAILABLE },
      { status: 404 }
    )
  }

  const url = new URL(request.url)
  const host = url.hostname

  if (!DEBUG_CONFIG.ALLOWED_HOSTS.some(allowedHost => allowedHost === host)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.DEBUG_ENDPOINT_NOT_AUTHORIZED },
      { status: 403 }
    )
  }

  return null
}
