/**
 * Announcement data access layer
 * お知らせデータのサーバー側取得ロジック
 *
 * Server Componentから直接呼び出してお知らせデータを取得する。
 * getSupabaseAdmin() を使用し、service_role でアクセスする（既存パターン踏襲）。
 */

import { cache } from 'react'
import { desc, eq } from 'drizzle-orm'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { withRetry } from '@/lib/supabase/retry'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
// schema のテーブル名（announcements）はこのモジュールのローカル変数名と紛らわしい
// ため、Table サフィックスを付けて import する
import {
  announcementReads as announcementReadsTable,
  announcements as announcementsTable,
} from '@/lib/db/schema'
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
 * getUnreadAnnouncements の Drizzle（pg 直結）実装 (#570 パイロット)
 *
 * DB_DRIVER=pg-read/pg のときのみ使われる、PostgREST 実装と同一のクエリ意味論を
 * 持つ読み取り経路。戻り値の形状（snake_case キー、日付は文字列）を既存実装と
 * 完全に一致させることが要件（呼び出し側は経路を意識しない）。
 *
 * PostgREST 実装との対応:
 * - announcements: is_published = true を created_at 降順で取得
 *   （表示期限の判定は既存実装と同じく isAnnouncementVisibleAt でサーバー側 JS 処理）
 * - announcement_reads: twitch_user_id 一致の既読 ID を取得
 * - いずれかが失敗したら空配列（バナー非表示の安全側）を返し、logger.error に記録
 *   （既存実装の annError / readError / catch と同じ外部挙動）
 *
 * 読み取り専用クエリのため冪等（idempotent: true）としてリトライを opt-in する。
 * timestamptz 列は Drizzle スキーマの mode: 'string' により文字列のまま返る
 * （Date オブジェクトへの変換はしない。既存実装のパリティ要件）。
 * 表現形式（#688 で更新）: pg 直結・PostgREST いずれも ISO 8601
 * （'2026-03-10T12:00:00.123456+00:00'）を返す。pg 直結は元々 PG テキスト形式
 * （'2026-03-10 12:00:00.123456+00'）で timestamptz を返していたが、Safari(JSC) の
 * new Date() ではその形式のパースが保証されないため、src/lib/db/client.ts の
 * installIsoTimestampParsers() が接続確立時に ISO 8601 へ正規化するパーサへ
 * 差し替えている（#688）。本モジュールの消費側（isAnnouncementVisibleAt と
 * AnnouncementBanner）は Date.parse 経由でしか日付を扱わないため、正規化前の
 * PG テキスト形式でも実害はなかったが、正規化後は PostgREST 経路と文字列表現も
 * 完全一致する。
 */
async function getUnreadAnnouncementsPg(twitchUserId: string): Promise<UnreadAnnouncement[]> {
  // どちらのクエリで失敗したかを catch 節のログで判別するためのフェーズタグ。
  // PostgREST 経路が annError / readError を別メッセージでログしているのに合わせ、
  // preview 切替検証（wrangler tail での原因切り分け）を容易にする。
  let phase: 'announcements' | 'reads' = 'announcements'
  try {
    const now = new Date()

    const announcements = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: announcementsTable.id,
            title: announcementsTable.title,
            body: announcementsTable.body,
            severity: announcementsTable.severity,
            published_at: announcementsTable.published_at,
            expires_at: announcementsTable.expires_at,
            created_at: announcementsTable.created_at,
          })
          .from(announcementsTable)
          .where(eq(announcementsTable.is_published, true))
          .orderBy(desc(announcementsTable.created_at))
      },
      'getUnreadAnnouncements(announcements)',
      { idempotent: true },
    )

    if (announcements.length === 0) {
      return []
    }

    const visibleAnnouncements = announcements.filter((announcement) =>
      isAnnouncementVisibleAt(announcement, now)
    )

    if (visibleAnnouncements.length === 0) {
      return []
    }

    phase = 'reads'
    const reads = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({ announcement_id: announcementReadsTable.announcement_id })
          .from(announcementReadsTable)
          .where(eq(announcementReadsTable.twitch_user_id, twitchUserId))
      },
      'getUnreadAnnouncements(reads)',
      { idempotent: true },
    )

    const readIds = new Set(reads.map(r => r.announcement_id))

    return visibleAnnouncements
      .filter(a => !readIds.has(a.id))
      .map(a => ({
        id: a.id,
        title: a.title,
        body: a.body,
        // severity は DB の CHECK 制約で 'info' | 'warning' | 'critical' が保証
        // されている。PostgREST 経路も型検証なしで同じ生値を返しており、既存の
        // 戻り値型に合わせるキャスト（値の変換はしない）。
        severity: a.severity as UnreadAnnouncement['severity'],
        published_at: a.published_at,
        // created_at の DDL は DEFAULT now()（NOT NULL なし）のため Drizzle 型は
        // string | null だが、実運用で NULL にはならない。PostgREST 経路の
        // 戻り値型（string）に合わせるキャスト（値の変換はしない）。
        created_at: a.created_at as string,
      }))
  } catch (error) {
    // 既存実装と同じく「取得失敗時は未読バナーを出さない」安全側の挙動。
    // phase により announcements / reads どちらの取得で失敗したかを判別できる
    // （PostgREST 経路の annError / readError 別ログと同等の粒度）。
    logger.error(`Error in getUnreadAnnouncements (pg:${phase})`, { error })
    return []
  }
}

/**
 * 未読のお知らせを取得（ダッシュボードバナー表示用）
 * 公開中 かつ 期限内 かつ 未読 のお知らせを取得する
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 未読お知らせ一覧（公開日時の降順）
 */
export const getUnreadAnnouncements = cache(async (twitchUserId: string): Promise<UnreadAnnouncement[]> => {
  // #570 パイロット: DB_DRIVER=pg-read/pg のときのみ Drizzle 直結経路へ切り替える。
  // フラグ未設定時（既定 'postgrest'）はこの分岐を素通りし、以下の既存 supabase-js
  // 実装が従来と完全に同一に実行される（挙動不変が Phase 1 の最重要安全要件）。
  if (isPgReadEnabled()) {
    return getUnreadAnnouncementsPg(twitchUserId)
  }

  try {
    const supabase = getSupabaseAdmin()
    const now = new Date()

    // 公開済みのお知らせを取得し、トップ表示向けの期限判定はサーバー側で厳密に行う
    // 502 一時障害に対するリトライ (Issue #326)
    const { data: announcements, error: annError } = await withRetry(
      () => supabase
        .from('announcements')
        .select('id, title, body, severity, published_at, expires_at, created_at')
        .eq('is_published', true)
        .order('created_at', { ascending: false }),
      'getUnreadAnnouncements',
    )

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
 * getAllAnnouncements の Drizzle（pg 直結）実装 (#663 Category A, 2026-07-11)
 *
 * 姉妹関数 getUnreadAnnouncementsPg と同じ基盤（withDbRetry / idempotent:true /
 * announcements → reads の2段クエリ）を使うが、エラー時のフォールバックは
 * postgrest 実装の非対称な挙動をそのまま再現する必要がある:
 * - announcements 取得失敗 → [] を返す（履歴自体を表示しない安全側）
 * - reads 取得失敗          → 全件を既読扱いで返す（未読バナーと違い、履歴ページで
 *   全件「未読」に見えるより「既読」扱いのほうが無害という既存実装の判断）
 * このため reads クエリだけ内側の try/catch で個別にフォールバックし、外側の
 * catch は announcements 取得失敗（またはその他の予期しないエラー）専用として [] を返す。
 */
async function getAllAnnouncementsPg(twitchUserId: string): Promise<AnnouncementWithReadStatus[]> {
  try {
    const now = new Date()

    const announcements = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: announcementsTable.id,
            title: announcementsTable.title,
            body: announcementsTable.body,
            severity: announcementsTable.severity,
            is_published: announcementsTable.is_published,
            published_at: announcementsTable.published_at,
            expires_at: announcementsTable.expires_at,
            created_at: announcementsTable.created_at,
          })
          .from(announcementsTable)
          .where(eq(announcementsTable.is_published, true))
          .orderBy(desc(announcementsTable.created_at))
      },
      'getAllAnnouncements(announcements)',
      { idempotent: true },
    )

    if (announcements.length === 0) {
      return []
    }

    const publishedAnnouncements = announcements.filter((announcement) =>
      hasAnnouncementBeenPublishedAt(announcement, now)
    )

    if (publishedAnnouncements.length === 0) {
      return []
    }

    let reads: { announcement_id: string; read_at: string | null }[]
    try {
      reads = await withDbRetry(
        async () => {
          const { db } = await getDb()
          return db
            .select({
              announcement_id: announcementReadsTable.announcement_id,
              read_at: announcementReadsTable.read_at,
            })
            .from(announcementReadsTable)
            .where(eq(announcementReadsTable.twitch_user_id, twitchUserId))
        },
        'getAllAnnouncements(reads)',
        { idempotent: true },
      )
    } catch (readsError) {
      // 既読情報の取得に失敗した場合、全お知らせを既読扱いにする
      // （postgrest 経路の readError 分岐と同じ安全側フォールバック）
      logger.error('Error in getAllAnnouncements (pg:reads)', { error: readsError })
      return publishedAnnouncements.map(a => ({
        id: a.id,
        title: a.title,
        body: a.body,
        severity: a.severity as AnnouncementWithReadStatus['severity'],
        is_published: a.is_published,
        published_at: a.published_at,
        expires_at: a.expires_at,
        created_at: a.created_at as string,
        is_read: true,
        read_at: null,
      }))
    }

    const readMap = new Map(reads.map(r => [r.announcement_id, r.read_at]))

    return publishedAnnouncements.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity as AnnouncementWithReadStatus['severity'],
      is_published: a.is_published,
      published_at: a.published_at,
      expires_at: a.expires_at,
      created_at: a.created_at as string,
      is_read: readMap.has(a.id),
      read_at: readMap.get(a.id) ?? null,
    }))
  } catch (error) {
    // announcements 取得失敗、またはその他の予期しないエラー。
    // reads 取得失敗は上の内側 try/catch で個別に処理済みのためここには来ない。
    logger.error('Error in getAllAnnouncements (pg:announcements)', { error })
    return []
  }
}

/**
 * 全お知らせを取得（履歴ページ用、既読フラグ付き）
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 全お知らせ一覧（既読フラグ付き、作成日時の降順）
 */
export async function getAllAnnouncements(twitchUserId: string): Promise<AnnouncementWithReadStatus[]> {
  // #570 パイロット踏襲: DB_DRIVER=pg-read/pg のときのみ Drizzle 直結経路へ切り替える。
  // フラグ未設定時（既定 'postgrest'）はこの分岐を素通りし、以下の既存 supabase-js
  // 実装が従来と完全に同一に実行される（挙動不変が Phase 1 の最重要安全要件）。
  if (isPgReadEnabled()) {
    return getAllAnnouncementsPg(twitchUserId)
  }

  try {
    const supabase = getSupabaseAdmin()
    const now = new Date()

    // 履歴ページ向けに公開済みのお知らせを取得
    // 502 一時障害に対するリトライ (Issue #326)
    const { data: announcements, error: annError } = await withRetry(
      () => supabase
        .from('announcements')
        .select('id, title, body, severity, is_published, published_at, expires_at, created_at')
        .eq('is_published', true)
        .order('created_at', { ascending: false }),
      'getAllAnnouncements',
    )

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
