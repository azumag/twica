import { getSession } from '@/lib/session'
import { NextResponse } from 'next/server'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'

export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 })
    }

    return NextResponse.json(session)
  } catch (error) {
    return handleApiError(error, "Session API: GET")
  }
}