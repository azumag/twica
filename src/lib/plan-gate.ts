// Issue #269: gate NEW card-pack (collection_name) registrations behind a
// premium plan (support / patron / twitch_sub), while leaving existing
// pack-scoped gacha redemptions and unrelated settings saves unaffected even
// after a user's support code or Twitch sub lapses.
//
// 課題 #269: カードパック(collection_name)の「新規登録・変更」のみを支援
// プラン/Twitchサブスクで制限する。既存の引き換え・無関係な設定保存は、
// 支援/サブスクが失効しても影響を受けない。

import { getUserPlan } from "@/lib/plan";

/**
 * Determine whether a collection_name write must be dropped because the user
 * is on the basic plan.
 *
 * Only a genuine new assignment is gated: `newValue` must be a non-null
 * string AND differ from `currentValue`. Clearing to null, leaving the field
 * unspecified (`undefined`), or resubmitting the current value are never
 * gated — and `getUserPlan` (which calls out to the Twitch API) is skipped
 * entirely in those cases.
 *
 * 「新しい登録」= 非null かつ現在値と異なる値への変更のみをゲートする。
 * null化・未指定・現在値の再送信は常に許可し、getUserPlan(Twitch API呼び出し
 * を含む)も呼ばない。
 */
export async function isCollectionChangeGated(
  twitchUserId: string,
  newValue: string | null | undefined,
  currentValue: string | null
): Promise<boolean> {
  if (typeof newValue !== "string" || newValue === currentValue) {
    return false;
  }

  const plan = await getUserPlan(twitchUserId);
  return plan === "basic";
}
