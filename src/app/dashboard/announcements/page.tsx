import { getTranslations } from 'next-intl/server'
import { getSession } from '@/lib/session'
import { getAllAnnouncements } from '@/lib/announcements'
import AnnouncementBanner from '@/components/AnnouncementBanner'

/**
 * お知らせ履歴ページ
 * 全お知らせを一覧表示し、未読/既読バッジ付きで確認できる
 */
export default async function AnnouncementsPage() {
  const t = await getTranslations('announcementsPage')
  const session = await getSession()

  if (!session) {
    return null
  }

  const announcements = await getAllAnnouncements(session.twitchUserId)

  // 未読お知らせをバナー表示用に分離
  const unread = announcements.filter(a => !a.is_read)
  const read = announcements.filter(a => a.is_read)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-white">{t('title')}</h1>

      {/* 未読お知らせはバナー形式で表示 */}
      {unread.length > 0 && (
        <AnnouncementBanner announcements={unread} />
      )}

      {/* 既読お知らせ一覧 */}
      {read.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-300">{t('readAnnouncements')}</h2>
          {read.map(announcement => (
            <div
              key={announcement.id}
              className="rounded-xl bg-gray-800/50 border border-gray-700 p-4"
            >
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-medium text-gray-300">{announcement.title}</h3>
                <span className="rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-300">
                  {t('read')}
                </span>
              </div>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{announcement.body}</p>
              <p className="mt-2 text-xs text-gray-600">
                {new Date(announcement.created_at).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* お知らせが一件もない場合 */}
      {announcements.length === 0 && (
        <p className="text-gray-400">{t('empty')}</p>
      )}
    </div>
  )
}
