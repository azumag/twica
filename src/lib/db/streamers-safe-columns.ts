// -----------------------------------------------------------------------------
// streamers テーブルの「デプロイ窓で欠落しうる列」フォールバック用ヘルパー (#738, #722)
//
// 背景: #738 で schema.ts の streamers 定義に publish_live_status / publish_stats を、
// #722 で trade_enabled / cross_channel_trade_enabled を追加した。Drizzle の無指定
// `.select()` / `.select({ streamer: streamersTable })` は schema.ts の静的列リストから
// SELECT 列を生成するため、migration 未適用の環境（preview マージ後にアプリデプロイと
// planetscale-migrate が並行実行される窓）では、新列が未作成だと streamers の全列 SELECT が
// 失敗する。cards の本番未デプロイ8列（issue #625/#685。該当フォールバックは本番実測を
// 経て #834 で撤去済み）と同種のリスクであり、同じ「まず全列で試行 → 列欠落エラー検知 →
// 明示列リストで再試行」パターンを適用する。
//
// 各 migration で同時に追加される列はデプロイ窓ではまとめて欠落するため、対象列の 42703
// エラーを検知できれば STREAMERS_SAFE_COLUMNS への再試行で回避できる。migration 適用後は
// 全列 SELECT が成功し、このフォールバックへは到達しない（同じ「デプロイ窓が閉じれば
// 死に分岐になる」設計は src/app/api/cards/route.ts 等の image_padding_color
// フォールバックにも見られる）。
// -----------------------------------------------------------------------------

import { streamers as streamersTable } from "@/lib/db/schema";
import { isPgMissingNamedColumnError } from "@/lib/db/errors";

/**
 * デプロイ窓で欠落しうる streamers の新列（#738 の migration で追加）。
 */
export const LIVE_DIRECTORY_SETTINGS_COLUMNS = [
  "publish_live_status",
  "publish_stats",
] as const;

/**
 * デプロイ窓対象列を除いた streamers テーブルの明示的な列オブジェクト。
 * Drizzle の `.select({ ... })` にそのまま渡せる。
 *
 * trade_enabled / cross_channel_trade_enabled も意図的に含めないため、この安全列で再試行した
 * 行では両設定値が undefined になりうる。消費側はデプロイ窓中の未定義値を有効扱いせず、
 * `?? false` などで必ず fail-closed に扱うこと。
 */
export const STREAMERS_SAFE_COLUMNS = {
  id: streamersTable.id,
  twitch_user_id: streamersTable.twitch_user_id,
  twitch_username: streamersTable.twitch_username,
  twitch_display_name: streamersTable.twitch_display_name,
  twitch_profile_image_url: streamersTable.twitch_profile_image_url,
  channel_point_reward_id: streamersTable.channel_point_reward_id,
  channel_point_reward_name: streamersTable.channel_point_reward_name,
  channel_point_collection_name: streamersTable.channel_point_collection_name,
  is_active: streamersTable.is_active,
  gacha_sound_url: streamersTable.gacha_sound_url,
  gacha_sound_enabled: streamersTable.gacha_sound_enabled,
  gacha_sound_rules: streamersTable.gacha_sound_rules,
  chat_announcement_enabled: streamersTable.chat_announcement_enabled,
  chat_announcement_template: streamersTable.chat_announcement_template,
  chat_announcement_multi_template: streamersTable.chat_announcement_multi_template,
  chat_announcement_multi_show_cards: streamersTable.chat_announcement_multi_show_cards,
  rarity_weights: streamersTable.rarity_weights,
  rarity_weights_scope: streamersTable.rarity_weights_scope,
  pack_rarity_weights: streamersTable.pack_rarity_weights,
  custom_rarities: streamersTable.custom_rarities,
  card_pack_names: streamersTable.card_pack_names,
  default_card_pack_name: streamersTable.default_card_pack_name,
  show_unowned_cards: streamersTable.show_unowned_cards,
  show_unowned_card_details: streamersTable.show_unowned_card_details,
  raid_gacha_active_until: streamersTable.raid_gacha_active_until,
  raid_gacha_draw_count: streamersTable.raid_gacha_draw_count,
  created_at: streamersTable.created_at,
  updated_at: streamersTable.updated_at,
} as const;

/**
 * streamers の新2列（publish_live_status / publish_stats）の欠落を検知する。
 * SQLSTATE 42703 と対象列名を同じエラー階層で確認する（src/lib/db/errors.ts の
 * isPgMissingNamedColumnError に委譲。Drizzle は postgres.js の PostgresError を
 * DrizzleQueryError でラップするため、同関数内部で cause チェーンも辿る）。
 */
export function isMissingLiveDirectorySettingsColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, LIVE_DIRECTORY_SETTINGS_COLUMNS);
}

/**
 * 「まず全列で試行 → デプロイ窓対象列の欠落エラー検知 → STREAMERS_SAFE_COLUMNS で再試行」
 * の共通化。attempt(useSafeColumns) は useSafeColumns に応じて全列 / 明示列を切り替える。
 * 対象列以外のエラーはそのまま再送出し、呼び出し側の既存 catch に委ねる。
 *
 * 関数名は #738 で live directory 設定列用として導入した時の名前を維持しているが、現在は
 * #722 の trade_enabled / cross_channel_trade_enabled も同じ安全列集合へフォールバックする。
 * 対象列の定義は LIVE_DIRECTORY_SETTINGS_COLUMNS / TRADE_SETTINGS_COLUMNS に分け、検知条件だけを
 * 共有する。
 *
 * 元々は cards テーブルの「本番未デプロイ8列」フォールバック
 * （旧 cards-safe-columns.ts の withCardsBattleColumnFallback）と同型の設計だったが、そちらは
 * 本番実測で対象8列とも実在することを確認したため #834 で撤去された（撤去後のファイルは
 * card-padding-color-errors.ts に改名・縮小）。
 */
export async function withLiveDirectorySettingsColumnFallback<T>(
  attempt: (useSafeColumns: boolean) => Promise<T>
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isMissingLiveDirectorySettingsColumnError(error) && !isMissingTradeSettingsColumnError(error)) throw error;
    return attempt(true);
  }
}

/**
 * デプロイ窓で欠落しうる streamers の新列(20260817100000 の migration で追加。
 * Issue #722, #715 子2)。publish_live_status / publish_stats (#738) と同じ
 * 「アプリデプロイとmigration適用が独立したタイミングで完了する」リスクを
 * 持つため、同型のフォールバックを追加する。
 *
 * STREAMERS_SAFE_COLUMNS は #738 より前の列だけの固定リストであり、
 * この2列も元々含まれていない。そのため再投影先(STREAMERS_SAFE_COLUMNS)は
 * 変更不要で、検知条件だけをこの2列にも広げればよい。
 */
export const TRADE_SETTINGS_COLUMNS = [
  "trade_enabled",
  "cross_channel_trade_enabled",
] as const;

/**
 * streamers の trade_enabled / cross_channel_trade_enabled 列の欠落
 * (20260817100000 の migration 未適用の環境)を検知する。
 */
export function isMissingTradeSettingsColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, TRADE_SETTINGS_COLUMNS);
}
