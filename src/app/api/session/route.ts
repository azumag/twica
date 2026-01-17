import { getSession } from '@/lib/session'
import { NextResponse } from 'next/server'
import { handleApiError } from '@/lib/error-handler'

export async function GET() {
  try {
    const session = await getSession()
    
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    
    return NextResponse.json(session)
  } catch (error) {
    return handleApiError(error, "Session API: GET")
  }
}