// Issue #269 (redesigned): gate NEW card-pack-name REGISTRATIONS (additions to
// the streamer's pre-defined `card_pack_names` list) behind a premium plan
// (support / patron / twitch_sub). Assigning an EXISTING pre-defined pack to a
// card or channel-point reward is never gated — only adding a brand new pack
// name to the management list is. Removing a name from the list, or leaving
// existing card/reward pack assignments untouched, is always allowed even
// after a user's support code or Twitch sub lapses.
//
// 課題 #269(再設計): 「新しい登録」は、事前登録パック一覧(card_pack_names)
// への新規追加そのものを指す。既存パックをカード/報酬に紐付ける操作(選択)は
// もうゲート対象外。一覧からの削除・既存紐付けの維持は常に許可する。

import { getUserPlan } from "@/lib/plan";

/**
 * Determine whether adding `addedNames` to the streamer's card-pack list must
 * be rejected because the user is on the basic plan.
 *
 * `addedNames` is the set of names present in the new list but absent from
 * the current one (i.e. genuinely new registrations — removals and
 * unchanged entries never appear here). If empty, this is a no-op or
 * removal-only save: never gated, and `getUserPlan` (which calls out to the
 * Twitch API) is skipped entirely.
 */
export async function isNewCardPackNameAdditionGated(
  twitchUserId: string,
  addedNames: string[]
): Promise<boolean> {
  if (addedNames.length === 0) {
    return false;
  }

  const plan = await getUserPlan(twitchUserId);
  return plan === "basic";
}
