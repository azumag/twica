'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { LanguageSwitcherDark } from '@/components/LanguageSwitcher'
import { LogoutButton } from '@/components/LogoutButton'

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

/**
 * ダッシュボードアイコン（グリッド形式）
 * スマホ表示時にテキストの代わりに表示される
 */
function DashboardIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="h-5 w-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
      />
    </svg>
  )
}

/**
 * ログアウトアイコン（右矢印のドアアイコン）
 * スマホ表示時にテキストの代わりに表示される
 */
function LogoutIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="h-5 w-5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3H15"
      />
    </svg>
  )
}

function LiveDirectoryLink({ label }: { label: string }) {
  return (
    <Link
      href="/live"
      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-gray-200 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 sm:px-3"
      title={label}
    >
      <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </Link>
  )
}

export default function TopPageHeader({ initialSession }: TopPageHeaderProps) {
  // Trust the server-side session data passed from RSC
  // Don't re-fetch on client side as API routes have different cookie handling
  const [session] = useState<SessionData | null>(initialSession)
  const isLoading = false
  const t = useTranslations('header')
  const tAuth = useTranslations('auth')

  if (isLoading && !initialSession) {
    return (
      <div className="h-10 w-32 animate-pulse rounded-lg bg-purple-600/50" />
    )
  }

  // ログインユーザーの場合のみヘッダーに表示
  // Only show header content for logged-in users
  if (session) {
    return (
      <div className="flex items-center gap-2 sm:gap-4">
        <LiveDirectoryLink label={t('live')} />

        {/* ユーザー名：スマホでは非表示、sm以上で表示 */}
        <span className="hidden text-white sm:block">{session.twitchDisplayName}</span>

        {/* 言語切り替え / Language switcher */}
        <LanguageSwitcherDark />

        {/* ダッシュボードリンク：スマホではアイコンのみ、sm以上でテキスト表示 */}
        <Link
          href="/dashboard"
          className="rounded-lg bg-purple-600 p-2 text-white hover:bg-purple-700 sm:px-4 sm:py-2"
          title={t("dashboard")}
        >
          {/* スマホ：アイコン表示 */}
          <span className="sm:hidden">
            <DashboardIcon />
          </span>
          {/* sm以上：テキスト表示 */}
          <span className="hidden sm:inline">{t("dashboard")}</span>
        </Link>

        {/* ログアウトボタン：状態変更を POST に統一するため LogoutButton を使用 */}
        <LogoutButton
          className="rounded-lg border border-white/30 p-2 text-white hover:bg-white/10 disabled:opacity-50 sm:px-4 sm:py-2"
          label={tAuth("logout")}
        >
          {/* スマホ：アイコン表示 */}
          <span className="sm:hidden">
            <LogoutIcon />
          </span>
          {/* sm以上：テキスト表示 */}
          <span className="hidden sm:inline">{tAuth("logout")}</span>
        </LogoutButton>
      </div>
    )
  }

  // 未ログインでも公開ディレクトリへ移動できる。言語切り替えと同じ共通導線として表示。
  return (
    <div className="flex items-center gap-2 sm:gap-4">
      <LiveDirectoryLink label={t('live')} />
      <LanguageSwitcherDark />
    </div>
  )
}
