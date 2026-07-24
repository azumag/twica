/**
 * Support inquiry data access layer
 * 問い合わせデータのサーバー側取得ロジック
 *
 * Server Componentから直接呼び出し、Hyperdrive経由のPlanetScale/Drizzleで
 * 問い合わせデータを取得する。
 */

import 'server-only'

import { and, asc, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'
import { logger } from './logger.server'

export type InquiryCategory = 'bug' | 'feature' | 'other'
export type InquiryStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface SupportInquiry {
  id: string
  twitch_user_id: string
  twitch_display_name: string
  category: InquiryCategory
  subject: string
  body: string
  status: InquiryStatus
  created_at: string
  updated_at: string
}

export interface SupportInquiryMessage {
  id: string
  inquiry_id: string
  sender_type: 'user' | 'admin'
  sender_id: string
  body: string
  created_at: string
}

/**
 * getUserInquiries の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: 対象列を twitch_user_id で絞り込み created_at 降順で
 * 取得するだけの単純な読み取り。取得失敗時は空配列を返す既存の安全側デグレードと
 * 同じ外部挙動（両方の catch ブロックを 1 つに集約するが、呼び出し元から見た
 * 結果は変わらない）。
 */
async function getUserInquiriesPg(twitchUserId: string): Promise<SupportInquiry[]> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
            twitch_display_name: supportInquiriesTable.twitch_display_name,
            category: supportInquiriesTable.category,
            subject: supportInquiriesTable.subject,
            body: supportInquiriesTable.body,
            status: supportInquiriesTable.status,
            created_at: supportInquiriesTable.created_at,
            updated_at: supportInquiriesTable.updated_at,
          })
          .from(supportInquiriesTable)
          .where(eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          .orderBy(desc(supportInquiriesTable.created_at))
      },
      'getUserInquiries',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    return rows as SupportInquiry[]
  } catch (error) {
    logger.error('Error in getUserInquiries', { error })
    return []
  }
}

/**
 * ユーザーの問い合わせ一覧を取得
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 問い合わせ一覧（作成日時の降順）
 */
export async function getUserInquiries(twitchUserId: string): Promise<SupportInquiry[]> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  return getUserInquiriesPg(twitchUserId)
}

/**
 * getInquiryWithMessages の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - 問い合わせ本体は id + twitch_user_id（所有権チェック）で絞り込む。
 *   `.single()` は id が PK のため LIMIT 1 + rows[0] ?? null で同じ外部挙動
 *   （0 行なら null、呼び出し元は関数全体で null を返す）。
 * - メッセージ取得は既存実装と同じく「独立した try/catch」でラップし、
 *   本体取得は成功したがメッセージ取得だけ失敗した場合は関数全体を null にせず
 *   `{ inquiry, messages: [] }` にフォールバックする（既存の部分失敗時の挙動を再現）。
 */
async function getInquiryWithMessagesPg(
  inquiryId: string,
  twitchUserId: string
): Promise<{ inquiry: SupportInquiry; messages: SupportInquiryMessage[] } | null> {
  try {
    // 問い合わせ本体を取得（ユーザーIDで所有権チェック）
    const inquiryRows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
            twitch_display_name: supportInquiriesTable.twitch_display_name,
            category: supportInquiriesTable.category,
            subject: supportInquiriesTable.subject,
            body: supportInquiriesTable.body,
            status: supportInquiriesTable.status,
            created_at: supportInquiriesTable.created_at,
            updated_at: supportInquiriesTable.updated_at,
          })
          .from(supportInquiriesTable)
          .where(
            and(
              eq(supportInquiriesTable.id, inquiryId),
              eq(supportInquiriesTable.twitch_user_id, twitchUserId)
            )
          )
          .limit(1)
      },
      'getInquiryWithMessages(inquiry)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    const inquiry = (inquiryRows[0] ?? null) as SupportInquiry | null
    if (!inquiry) {
      return null
    }

    // メッセージを時系列順で取得。この取得だけが失敗しても関数全体は失敗させず
    // messages: [] にフォールバックする（既存実装と同じ部分失敗時の挙動）。
    try {
      const messages = await withDbRetry(
        async () => {
          const { db } = await getDb()
          return db
            .select({
              id: supportInquiryMessagesTable.id,
              inquiry_id: supportInquiryMessagesTable.inquiry_id,
              sender_type: supportInquiryMessagesTable.sender_type,
              sender_id: supportInquiryMessagesTable.sender_id,
              body: supportInquiryMessagesTable.body,
              created_at: supportInquiryMessagesTable.created_at,
            })
            .from(supportInquiryMessagesTable)
            .where(eq(supportInquiryMessagesTable.inquiry_id, inquiryId))
            .orderBy(asc(supportInquiryMessagesTable.created_at))
        },
        'getInquiryWithMessages(messages)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      )

      return {
        inquiry,
        messages: messages as SupportInquiryMessage[],
      }
    } catch (messagesError) {
      logger.error('Failed to fetch inquiry messages', { error: messagesError })
      return { inquiry, messages: [] }
    }
  } catch (error) {
    logger.error('Error in getInquiryWithMessages', { error })
    return null
  }
}

/**
 * 問い合わせ詳細とメッセージを取得（所有権チェック付き）
 *
 * @param inquiryId - 問い合わせID
 * @param twitchUserId - TwitchユーザーID（所有権チェック用）
 * @returns 問い合わせ詳細とメッセージ、見つからない場合はnull
 */
export async function getInquiryWithMessages(
  inquiryId: string,
  twitchUserId: string
): Promise<{ inquiry: SupportInquiry; messages: SupportInquiryMessage[] } | null> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  return getInquiryWithMessagesPg(inquiryId, twitchUserId)
}
