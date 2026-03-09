/**
 * Announcement data access layer
 * お知らせデータのサーバー側取得ロジック
 *
 * Server Componentから直接呼び出してお知らせデータを取得する。
 * getSupabaseAdmin() を使用し、service_role でアクセスする（既存パターン踏襲）。
 */

import { cache } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from './logger'

export interface UnreadAnnouncement {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  published_at: string | null
  created_at: string
}

export interface AnnouncementWithReadStatus {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  is_published: boolean
  published_at: string | null
  expires_at: string | null
  created_at: string
  is_read: boolean
  read_at: string | null
}

interface AnnouncementVisibilityWindow {
  published_at: string | null
  expires_at: string | null
}

function parseAnnouncementTime(value: string | null): number | null {
  if (!value) {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

export function isAnnouncementVisibleAt(
  announcement: AnnouncementVisibilityWindow,
  now: Date = new Date()
): boolean {
  const nowMs = now.getTime()
  const publishedAtMs = parseAnnouncementTime(announcement.published_at)
  const expiresAtMs = parseAnnouncementTime(announcement.expires_at)

  if (announcement.published_at && publishedAtMs === null) {
    return false
  }

  if (announcement.expires_at && expiresAtMs === null) {
    return false
  }

  if (publishedAtMs !== null && publishedAtMs > nowMs) {
    return false
  }

  if (expiresAtMs !== null && expiresAtMs < nowMs) {
    return false
  }

  return true
}

export function hasAnnouncementBeenPublishedAt(
  announcement: Pick<AnnouncementVisibilityWindow, 'published_at'>,
  now: Date = new Date()
): boolean {
  const publishedAtMs = parseAnnouncementTime(announcement.published_at)

  if (announcement.published_at && publishedAtMs === null) {
    return false
  }

  if (publishedAtMs !== null && publishedAtMs > now.getTime()) {
    return false
  }

  return true
}

/**
 * 未読のお知らせを取得（ダッシュボードバナー表示用）
 * 公開中 かつ 期限内 かつ 未読 のお知らせを取得する
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 未読お知らせ一覧（公開日時の降順）
 */
export const getUnreadAnnouncements = cache(async (twitchUserId: string): Promise<UnreadAnnouncement[]> => {
  try {
    const supabase = getSupabaseAdmin()
    const now = new Date()

    // 公開済みのお知らせを取得し、トップ表示向けの期限判定はサーバー側で厳密に行う
    const { data: announcements, error: annError } = await supabase
      .from('announcements')
      .select('id, title, body, severity, published_at, expires_at, created_at')
      .eq('is_published', true)
      .order('created_at', { ascending: false })

    if (annError) {
      logger.error('Failed to fetch announcements', { error: annError.message })
      return []
    }

    if (!announcements || announcements.length === 0) {
      return []
    }

    const visibleAnnouncements = announcements.filter((announcement) =>
      isAnnouncementVisibleAt(announcement, now)
    )

    if (visibleAnnouncements.length === 0) {
      return []
    }

    // このユーザーの既読お知らせIDを取得
    const { data: reads, error: readError } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .eq('twitch_user_id', twitchUserId)

    if (readError) {
      // 既読情報の取得に失敗した場合、全お知らせを既読扱いにして不要なバナー表示を防ぐ
      // （既読情報が取れないのに未読バナーを表示するとユーザー体験が悪い）
      logger.error('Failed to fetch announcement reads', { error: readError.message })
      return []
    }

    const readIds = new Set((reads || []).map(r => r.announcement_id))

    // 未読のお知らせのみ返す
    return visibleAnnouncements
      .filter(a => !readIds.has(a.id))
      .map(a => ({
        id: a.id,
        title: a.title,
        body: a.body,
        severity: a.severity,
        published_at: a.published_at,
        created_at: a.created_at,
      }))
  } catch (error) {
    logger.error('Error in getUnreadAnnouncements', { error })
    return []
  }
})

/**
 * 全お知らせを取得（履歴ページ用、既読フラグ付き）
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 全お知らせ一覧（既読フラグ付き、作成日時の降順）
 */
export async function getAllAnnouncements(twitchUserId: string): Promise<AnnouncementWithReadStatus[]> {
  try {
    const supabase = getSupabaseAdmin()
    const now = new Date()

    // 履歴ページ向けに公開済みのお知らせを取得
    const { data: announcements, error: annError } = await supabase
      .from('announcements')
      .select('id, title, body, severity, is_published, published_at, expires_at, created_at')
      .eq('is_published', true)
      .order('created_at', { ascending: false })

    if (annError) {
      logger.error('Failed to fetch all announcements', { error: annError.message })
      return []
    }

    if (!announcements || announcements.length === 0) {
      return []
    }

    const publishedAnnouncements = announcements.filter((announcement) =>
      hasAnnouncementBeenPublishedAt(announcement, now)
    )

    if (publishedAnnouncements.length === 0) {
      return []
    }

    // このユーザーの既読情報を取得
    const { data: reads, error: readError } = await supabase
      .from('announcement_reads')
      .select('announcement_id, read_at')
      .eq('twitch_user_id', twitchUserId)

    if (readError) {
      // 既読情報の取得に失敗した場合は全お知らせを既読扱いで返す
      logger.error('Failed to fetch announcement reads for history', { error: readError.message })
      return publishedAnnouncements.map(a => ({
        id: a.id,
        title: a.title,
        body: a.body,
        severity: a.severity,
        is_published: a.is_published,
        published_at: a.published_at,
        expires_at: a.expires_at,
        created_at: a.created_at,
        is_read: true,
        read_at: null,
      }))
    }

    const readMap = new Map((reads || []).map(r => [r.announcement_id, r.read_at]))

    return publishedAnnouncements.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity,
      is_published: a.is_published,
      published_at: a.published_at,
      expires_at: a.expires_at,
      created_at: a.created_at,
      is_read: readMap.has(a.id),
      read_at: readMap.get(a.id) ?? null,
    }))
  } catch (error) {
    logger.error('Error in getAllAnnouncements', { error })
    return []
  }
}
