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
 * plan.tsはサーバー専用モジュール（PlanetScale、Twitch API）に依存するため、
 * クライアントバンドルに含めると env-validation のモジュール評価時バリデーションでクラッシュする。
 */

import { cache } from 'react'


import { logger } from '@/lib/logger.server'
import { hasTwitchSub } from '@/lib/twitch/sub-check'
import { PLAN_PRIORITY, PLAN_STORAGE_BONUS } from '@/lib/plan-constants'
import { logPerf, perfStart } from '@/lib/perf'
import type { PlanType } from '@/lib/plan-constants'
// PlanetScale-only: プラン判定はすべて同じ接続先から読み取り、DB 経路の切替は行わない。
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import {
  supportCodes as supportCodesTable,
  userLicenses as userLicensesTable,
  users as usersTable,
} from '@/lib/db/schema'

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
  const startedAt = perfStart()
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
  } finally {
    logPerf('plan', 'getUserPlan', startedAt)
  }
})

/**
 * Dashboard navigation用の軽量プラン判定。
 * 外部Twitch APIへ再検証に行かず、DBに保存済みのライセンス/サブスク状態だけを見る。
 */
export const getUserPlanSnapshot = cache(async function getUserPlanSnapshot(twitchUserId: string): Promise<PlanType> {
  const startedAt = perfStart()
  try {
    const [licensePlan, cachedSubPlan] = await Promise.all([
      getLicensePlan(twitchUserId),
      getCachedTwitchSubPlan(twitchUserId),
    ])

    if (PLAN_PRIORITY[cachedSubPlan] > PLAN_PRIORITY[licensePlan]) {
      return cachedSubPlan
    }
    return licensePlan
  } catch (error) {
    logger.error('[Plan] Error getting user plan snapshot:', error)
    return 'basic'
  } finally {
    logPerf('plan', 'getUserPlanSnapshot', startedAt)
  }
})

/**
 * getLicensePlan の pg 直結実装 (#663)
 *
 * 旧 PostgREST 実装との対応:
 * - `.select('plan_type, support_codes!inner(status)')` の埋め込み + `.in('support_codes.status', ...)`
 *   は user_licenses INNER JOIN support_codes（FK: user_licenses.code_id →
 *   support_codes.id、migration 00017）+ status の inArray() が等価。
 *   戻り値の消費側は plan_type しか読まないため、support_codes.status は
 *   JOIN 条件にのみ使い、select 列には含めない。
 * - エラー/例外時は 'basic' を返す既存の安全側デグレードと同じ外部挙動。
 */
async function getLicensePlanPg(twitchUserId: string): Promise<PlanType> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ plan_type: userLicensesTable.plan_type })
          .from(userLicensesTable)
          .innerJoin(supportCodesTable, eq(userLicensesTable.code_id, supportCodesTable.id))
          .where(
            and(
              eq(userLicensesTable.twitch_user_id, twitchUserId),
              inArray(supportCodesTable.status, ['active', 'rotating'])
            )
          )
      },
      'getLicensePlan',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    if (rows.length === 0) {
      return 'basic'
    }

    // 最上位プランを判定（patron > support > basic）
    let highestPlan: PlanType = 'basic'
    for (const license of rows) {
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
 * DBライセンスベースのプラン判定（従来のロジック）
 * user_licenses と support_codes(status) をJOINし、有効なコードに紐づくライセンスのみ有効とする。
 */
async function getLicensePlan(twitchUserId: string): Promise<PlanType> {
  // PlanetScale の読み取りをこの関数に閉じ込め、呼び出し側に接続方式を露出しない。
  return getLicensePlanPg(twitchUserId)
}

/**
 * getCachedTwitchSubPlan の pg 直結実装 (#663)
 *
 * 旧 PostgREST 実装との対応:
 * - `.maybeSingle()` は twitch_user_id が UNIQUE ではない前提（database.ts に制約
 *   記載なし）だが、既存実装が maybeSingle（0〜1行）を仮定しているため、
 *   LIMIT 1 + rows[0] ?? null で同じ外部挙動にする。
 * - エラー/該当なしは 'basic' を返す既存の安全側デグレードと同じ。
 */
async function getCachedTwitchSubPlanPg(twitchUserId: string): Promise<PlanType> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ twitch_has_sub: usersTable.twitch_has_sub })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'getCachedTwitchSubPlan',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    const user = rows[0] ?? null

    if (!user) {
      return 'basic'
    }

    return user.twitch_has_sub === true ? 'twitch_sub' : 'basic'
  } catch (error) {
    logger.error('[Plan] Error getting cached Twitch sub plan:', error)
    return 'basic'
  }
}

async function getCachedTwitchSubPlan(twitchUserId: string): Promise<PlanType> {
  // PlanetScale の読み取りをこの関数に閉じ込める。
  return getCachedTwitchSubPlanPg(twitchUserId)
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
