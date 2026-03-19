/**
 * Support Plan Module
 * 支援プラン判定モジュール
 *
 * user_licenses + support_codes をJOINして、ユーザーの有効なプランを判定する。
 * 上位プラン優先（patron > support > basic）。
 * cache() でリクエスト単位のキャッシュを適用し、同一リクエスト内での重複DB呼び出しを防止。
 *
 * 注意: 定数・型は plan-constants.ts に定義。
 * クライアントコンポーネントからは plan-constants.ts を直接 import すること。
 * plan.ts はサーバー専用モジュール（Supabase, Twitch API）に依存するため、
 * クライアントバンドルに含めると env-validation のモジュール評価時バリデーションでクラッシュする。
 */

import { cache } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { withRetry } from '@/lib/supabase/retry'
import { logger } from '@/lib/logger'
import { hasTwitchSub } from '@/lib/twitch/sub-check'
import { PLAN_PRIORITY, PLAN_STORAGE_BONUS } from '@/lib/plan-constants'
import type { PlanType } from '@/lib/plan-constants'

// サーバー側コードからの既存 import を壊さないよう re-export
export type { PlanType } from '@/lib/plan-constants'
export { PLAN_STORAGE_BONUS, PLAN_MAX_IMAGE_WIDTH, PLAN_MAX_UPLOAD_SIZE, PLAN_AVAILABLE_WIDTHS } from '@/lib/plan-constants'

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

    // 502 一時障害に対するリトライ (Issue #339)
    const { data, error } = await withRetry(
      () => supabaseAdmin
        .from('user_licenses')
        .select('plan_type, support_codes!inner(status)')
        .eq('twitch_user_id', twitchUserId)
        .in('support_codes.status', ['active', 'rotating']),
      'getLicensePlan',
    )

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
