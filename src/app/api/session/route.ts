import { getSession } from '@/lib/session'
import { NextResponse } from 'next/server'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { setCSRFToken } from '@/lib/csrf'
import { logger } from '@/lib/logger'

export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 })
    }

    const response = NextResponse.json(session)

    try {
      const csrfToken = await setCSRFToken()
      response.headers.set('x-csrf-token', csrfToken)
    } catch (error) {
      logger.warn('Session API: failed to refresh CSRF token', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    return response
  } catch (error) {
    return handleApiError(error, "Session API: GET")
  }
}
