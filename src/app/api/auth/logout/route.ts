import { NextResponse } from 'next/server'
import { clearSession } from '@/lib/session'

export async function POST() {
  await clearSession()
  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/`)
}

export async function GET() {
  await clearSession()
  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/`)
}
