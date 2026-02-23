/**
 * Support Plan Module
 * 支援プラン判定モジュール
 *
 * user_licenses + support_codes をJOINして、ユーザーの有効なプランを判定する。
 * 上位プラン優先（patron > support > basic）。
 * cache() でリクエスト単位のキャッシュを適用し、同一リクエスト内での重複DB呼び出しを防止。
 */

import { cache } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export type PlanType = 'basic' | 'support' | 'patron'

// プランごとの追加ストレージ容量（バイト）
// basic: 追加なし, support: 500MB, patron: 1GB
export const PLAN_STORAGE_BONUS: Record<PlanType, number> = {
  basic: 0,
  support: 500 * 1024 * 1024,   // 500MB
  patron: 1024 * 1024 * 1024,   // 1GB
}

// プランの優先度（高い値が優先）
const PLAN_PRIORITY: Record<PlanType, number> = {
  basic: 0,
  support: 1,
  patron: 2,
}

/**
 * ユーザーの有効な最上位プランを判定
 * user_licenses と support_codes(status) をJOINし、
 * active または rotating のコードに紐づくライセンスのみ有効とする。
 * 複数ライセンスがある場合は上位プランを優先。
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns 現在の有効プラン（ライセンスなしの場合は 'basic'）
 */
export const getUserPlan = cache(async function getUserPlan(twitchUserId: string): Promise<PlanType> {
  try {
    const supabaseAdmin = getSupabaseAdmin()

    // user_licenses から support_codes を内部結合し、有効なコードのライセンスのみ取得
    const { data, error } = await supabaseAdmin
      .from('user_licenses')
      .select('plan_type, support_codes!inner(status)')
      .eq('twitch_user_id', twitchUserId)
      .in('support_codes.status', ['active', 'rotating'])

    if (error) {
      logger.error('[Plan] Failed to get user plan:', error)
      return 'basic'
    }

    if (!data || data.length === 0) {
      return 'basic'
    }

    // 最上位プランを判定（patron > support > basic）
    let highestPlan: PlanType = 'basic'
    for (const license of data) {
      const planType = license.plan_type as PlanType
      if (PLAN_PRIORITY[planType] > PLAN_PRIORITY[highestPlan]) {
        highestPlan = planType
      }
    }

    return highestPlan
  } catch (error) {
    // プラン判定失敗時はbasicとする（ユーザーに不利にしない方が安全）
    logger.error('[Plan] Error getting user plan:', error)
    return 'basic'
  }
})

/**
 * プランに基づく追加ストレージバイト数を取得
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns プランによる追加ストレージ容量（バイト）
 */
export async function getPlanStorageBytes(twitchUserId: string): Promise<number> {
  const plan = await getUserPlan(twitchUserId)
  return PLAN_STORAGE_BONUS[plan]
}
