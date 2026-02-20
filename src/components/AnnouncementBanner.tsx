'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AutoLinkText from '@/components/AutoLinkText'

interface AnnouncementItem {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
}

interface AnnouncementBannerProps {
  announcements: AnnouncementItem[]
}

// severity別グラデーション（VoteCampaignButtonのスタイルに準拠）
const severityStyles = {
  info: 'bg-gradient-to-r from-blue-900/50 to-indigo-900/50 border-blue-600/50',
  warning: 'bg-gradient-to-r from-yellow-900/50 to-amber-900/50 border-yellow-600/50',
  critical: 'bg-gradient-to-r from-pink-900/50 to-red-900/50 border-pink-600/50',
} as const

const severityTextColors = {
  info: 'text-blue-300',
  warning: 'text-yellow-300',
  critical: 'text-pink-300',
} as const

const severityButtonStyles = {
  info: 'bg-blue-600 hover:bg-blue-700',
  warning: 'bg-yellow-600 hover:bg-yellow-700',
  critical: 'bg-pink-600 hover:bg-pink-700',
} as const

/**
 * お知らせバナーコンポーネント
 * 未読のお知らせをバナー形式で表示し、既読ボタンで非表示にする
 * VoteCampaignButtonと同じバナー型UIを採用
 */
export default function AnnouncementBanner({ announcements }: AnnouncementBannerProps) {
  const router = useRouter()
  const t = useTranslations('announcementBanner')
  // 既読処理中のお知らせID（ローディング表示用）
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  // 既読済みとしてUI上非表示にするお知らせID
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  // エラーが発生したお知らせID
  const [errorIds, setErrorIds] = useState<Set<string>>(new Set())

  const handleMarkAsRead = async (announcementId: string) => {
    setLoadingIds(prev => new Set(prev).add(announcementId))
    // 前回のエラー状態をクリア
    setErrorIds(prev => {
      const next = new Set(prev)
      next.delete(announcementId)
      return next
    })

    try {
      const response = await fetch('/api/announcements/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ announcementId }),
      })

      if (response.ok) {
        setDismissedIds(prev => new Set(prev).add(announcementId))
        router.refresh()
      } else {
        setErrorIds(prev => new Set(prev).add(announcementId))
      }
    } catch {
      setErrorIds(prev => new Set(prev).add(announcementId))
    } finally {
      setLoadingIds(prev => {
        const next = new Set(prev)
        next.delete(announcementId)
        return next
      })
    }
  }

  // 表示対象のお知らせ（既読済みを除外）
  const visibleAnnouncements = announcements.filter(a => !dismissedIds.has(a.id))

  if (visibleAnnouncements.length === 0) return null

  return (
    <>
      {visibleAnnouncements.map(announcement => (
        <div
          key={announcement.id}
          role={announcement.severity === 'critical' ? 'alert' : 'status'}
          aria-live={announcement.severity === 'critical' ? 'assertive' : 'polite'}
          className={`mb-4 rounded-xl border p-6 ${severityStyles[announcement.severity]}`}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex-1">
              <h3 className="mb-2 text-lg font-semibold text-white">
                {announcement.title}
              </h3>
              <AutoLinkText
                text={announcement.body}
                className={`text-sm whitespace-pre-wrap ${severityTextColors[announcement.severity]}`}
              />
            </div>
            <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
              <button
                onClick={() => handleMarkAsRead(announcement.id)}
                disabled={loadingIds.has(announcement.id)}
                aria-label={`${announcement.title} - ${t('markAsRead')}`}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50 disabled:cursor-not-allowed ${severityButtonStyles[announcement.severity]}`}
              >
                {loadingIds.has(announcement.id) ? t('marking') : t('markAsRead')}
              </button>
              {errorIds.has(announcement.id) && (
                <span className="text-xs text-red-400">{t('error')}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
