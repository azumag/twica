/**
 * Support inquiry data access layer
 * 問い合わせデータのサーバー側取得ロジック
 *
 * Server Componentから直接呼び出して問い合わせデータを取得する。
 * getSupabaseAdmin() を使用し、service_role でアクセスする（既存パターン踏襲）。
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from './logger'

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
 * ユーザーの問い合わせ一覧を取得
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 問い合わせ一覧（作成日時の降順）
 */
export async function getUserInquiries(twitchUserId: string): Promise<SupportInquiry[]> {
  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('twitch_user_id', twitchUserId)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Failed to fetch user inquiries', { error: error.message })
      return []
    }

    return (data || []) as SupportInquiry[]
  } catch (error) {
    logger.error('Error in getUserInquiries', { error })
    return []
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
  try {
    const supabase = getSupabaseAdmin()

    // 問い合わせ本体を取得（ユーザーIDで所有権チェック）
    const { data: inquiry, error: inquiryError } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('id', inquiryId)
      .eq('twitch_user_id', twitchUserId)
      .single()

    if (inquiryError || !inquiry) {
      return null
    }

    // メッセージを時系列順で取得
    const { data: messages, error: messagesError } = await supabase
      .from('support_inquiry_messages')
      .select('id, inquiry_id, sender_type, sender_id, body, created_at')
      .eq('inquiry_id', inquiryId)
      .order('created_at', { ascending: true })

    if (messagesError) {
      logger.error('Failed to fetch inquiry messages', { error: messagesError.message })
      return { inquiry: inquiry as SupportInquiry, messages: [] }
    }

    return {
      inquiry: inquiry as SupportInquiry,
      messages: (messages || []) as SupportInquiryMessage[],
    }
  } catch (error) {
    logger.error('Error in getInquiryWithMessages', { error })
    return null
  }
}
