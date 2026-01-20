'use client'

import { useState } from 'react'
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
  // Trust the server-side session data passed from RSC
  // Don't re-fetch on client side as API routes have different cookie handling
  const [session] = useState<SessionData | null>(initialSession)
  const isLoading = false

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
        {/* API エンドポイントには Link ではなく通常の a タグを使用 */}
        <a
          href="/api/auth/logout"
          className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10"
        >
          ログアウト
        </a>
      </div>
    )
  }

  return (
    <TwitchLoginButton
      className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
    />
  )
}
