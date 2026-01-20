'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { TwitchLoginButton } from '@/components/TwitchLoginButton'

interface SessionData {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string
  broadcasterType: string
}

interface TopPageHeaderProps {
  initialSession: SessionData | null
}

export default function TopPageHeader({ initialSession }: TopPageHeaderProps) {
  const [session, setSession] = useState<SessionData | null>(initialSession)
  const [isLoading, setIsLoading] = useState(!initialSession)

  useEffect(() => {
    // Always check session on client side to ensure it's up-to-date
    // This handles the case where RSC prefetch returns stale data
    const checkSession = async () => {
      try {
        const response = await fetch('/api/auth/session', {
          credentials: 'include',
        })
        const data = await response.json()
        setSession(data.session)
      } catch (error) {
        console.error('Failed to check session:', error)
      } finally {
        setIsLoading(false)
      }
    }

    checkSession()
  }, [])

  if (isLoading && !initialSession) {
    return (
      <div className="h-10 w-32 animate-pulse rounded-lg bg-purple-600/50" />
    )
  }

  if (session) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-white">{session.twitchDisplayName}</span>
        <Link
          href="/dashboard"
          className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
        >
          ダッシュボード
        </Link>
        <Link
          href="/api/auth/logout"
          className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10"
        >
          ログアウト
        </Link>
      </div>
    )
  }

  return (
    <TwitchLoginButton
      className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
    />
  )
}
