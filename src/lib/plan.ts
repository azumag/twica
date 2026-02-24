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
import { hasTwitchSub } from '@/lib/twitch/sub-check'

export type PlanType = 'basic' | 'support' | 'patron' | 'twitch_sub'

// プランごとの追加ストレージ容量（バイト）
// basic: 追加なし, support: 250MB, patron/twitch_sub: 500MB
export const PLAN_STORAGE_BONUS: Record<PlanType, number> = {
  basic: 0,
  support: 250 * 1024 * 1024,       // 250MB
  patron: 500 * 1024 * 1024,        // 500MB
  twitch_sub: 500 * 1024 * 1024,    // 500MB（patron同等）
}

// プランごとのカード画像最大幅（ピクセル）
// basic: 800px（標準）, support: 1920px（Full HD）, patron/twitch_sub: 3840px（4K）
export const PLAN_MAX_IMAGE_WIDTH: Record<PlanType, number> = {
  basic: 800,
  support: 1920,
  patron: 3840,
  twitch_sub: 3840,    // patron同等
}

// プランごとのアップロードファイルサイズ上限（バイト）
// 高解像度画像はファイルサイズが大きくなるため、上位プランでは上限を引き上げ
// patron/twitch_sub(4K)はcanvas.toBlob(85%)で5MB超になりうるため10MBに設定
export const PLAN_MAX_UPLOAD_SIZE: Record<PlanType, number> = {
  basic: 1 * 1024 * 1024,     // 1MB
  support: 5 * 1024 * 1024,   // 5MB（Full HD JPEG対応）
  patron: 10 * 1024 * 1024,   // 10MB（4K JPEG対応）
  twitch_sub: 10 * 1024 * 1024, // 10MB（patron同等）
}

// プランの優先度（高い値が優先）
// twitch_sub は patron と同等（priority: 2）
const PLAN_PRIORITY: Record<PlanType, number> = {
  basic: 0,
  support: 1,
  patron: 2,
  twitch_sub: 2,
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
    // DBライセンス判定・Twitchサブスク判定を並列実行
    // hasTwitchSub は環境変数未設定時に即座に false を返すため、未設定環境でも安全
    const [licensePlan, hasTwitchSubResult] = await Promise.all([
      getLicensePlan(twitchUserId),
      hasTwitchSub(twitchUserId),
    ])

    // Twitch サブスクがあれば twitch_sub プラン
    const subPlan: PlanType = hasTwitchSubResult ? 'twitch_sub' : 'basic'

    // 最高優先度のプランを返す
    if (PLAN_PRIORITY[subPlan] > PLAN_PRIORITY[licensePlan]) {
      return subPlan
    }
    return licensePlan
  } catch (error) {
    // プラン判定失敗時はbasicとする（ユーザーに不利にしない方が安全）
    logger.error('[Plan] Error getting user plan:', error)
    return 'basic'
  }
})

/**
 * DBライセンスベースのプラン判定（従来のロジック）
 * user_licenses と support_codes(status) をJOINし、有効なコードに紐づくライセンスのみ有効とする。
 */
async function getLicensePlan(twitchUserId: string): Promise<PlanType> {
  try {
    const supabaseAdmin = getSupabaseAdmin()

    const { data, error } = await supabaseAdmin
      .from('user_licenses')
      .select('plan_type, support_codes!inner(status)')
      .eq('twitch_user_id', twitchUserId)
      .in('support_codes.status', ['active', 'rotating'])

    if (error) {
      logger.error('[Plan] Failed to get license plan:', error)
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
    logger.error('[Plan] Error getting license plan:', error)
    return 'basic'
  }
}

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
