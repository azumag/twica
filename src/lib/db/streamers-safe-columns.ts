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
 * trade_enabled / cross_channel_trade_enabled (#722) と pack_album_grid_sizes /
 * collection_default_view (#1765 フォローアップ) も意図的に含めないため、この安全列で
 * 再試行した行ではこれらの設定値が undefined になりうる。消費側はデプロイ窓中の
 * 未定義値を有効扱いせず、`?? false` / 既定（3×3・'grid'）などで必ず fail-closed に
 * 扱うこと。
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
 * #722 の trade_enabled / cross_channel_trade_enabled、#2070 の
 * trade_unowned_card_names_visible、#934 の publish_card_ranking も同じ安全列集合へ
 * フォールバックする。
 * 対象列の定義は用途別のグループ定数（LIVE_DIRECTORY_SETTINGS_COLUMNS /
 * TRADE_SETTINGS_COLUMNS / ALBUM_SETTINGS_COLUMNS / CARD_RANKING_SETTINGS_COLUMNS /
 * DUPLICATE_DISPLAY_TIER_COLUMNS / RARITY_STYLES_COLUMNS /
 * UNOWNED_CARD_ITEM_COLUMNS）に分け、検知条件だけを共有する。
 *
 * 元々は cards テーブルの「本番未デプロイ8列」フォールバック
 * （旧 cards-safe-columns.ts の withCardsBattleColumnFallback）と同型の設計だったが、そちらは
 * 本番実測で対象8列とも実在することを確認したため #834 で撤去された（撤去後のファイルは
 * card-padding-color-errors.ts に改名・縮小され、さらに #954 で image_padding_color
 * フォールバックごと削除された）。本ヘルパー（streamers 側の列群）は #954 の実測
 * 対象外のため温存する。
 */
export async function withLiveDirectorySettingsColumnFallback<T>(
  attempt: (useSafeColumns: boolean) => Promise<T>
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (
      !isMissingLiveDirectorySettingsColumnError(error) &&
      !isMissingTradeSettingsColumnError(error) &&
      !isMissingAlbumSettingsColumnError(error) &&
      !isMissingCardRankingSettingsColumnError(error) &&
      !isMissingDuplicateDisplayTiersColumnError(error) &&
      !isMissingRarityStylesColumnError(error) &&
      !isMissingUnownedCardItemColumnError(error)
    ) {
      throw error;
    }
    return attempt(true);
  }
}

/**
 * デプロイ窓で欠落しうる streamers の trade 設定列。
 * trade_enabled / cross_channel_trade_enabled は 20260817100000 (#722) で、
 * trade_unowned_card_names_visible は 20261117120000 (#2070) で追加された。
 * migration は別だが、どれも「トレード設定の追加列」として同じデプロイ窓
 * フォールバックで検知する必要があるため、1つの検知グループにまとめる。
 *
 * #2070 フォローアップ (C4b): trade_unowned_card_names_visible は設定としては
 * 廃止し、書き込み経路からは撤去した。ただし schema.ts に列定義が残っており、
 * getStreamerById / getStreamerData の全列 SELECT がまだ参照するため、検知対象
 * としては残す（読み取りのデプロイ窓フォールバックを維持する）。ルート側の
 * UPDATE フォールバックは、この列を updateData に含めない。
 *
 * STREAMERS_SAFE_COLUMNS はこの3列を含まない（＝再試行側では undefined に
 * なりうる）。消費側は欠落時に false（fail-closed）へ倒すこと。
 */
export const TRADE_SETTINGS_COLUMNS = [
  "trade_enabled",
  "cross_channel_trade_enabled",
  "trade_unowned_card_names_visible",
] as const;

/**
 * streamers の trade 設定列の欠落
 * (20260817100000 / 20261117120000 の migration 未適用の環境)を検知する。
 */
export function isMissingTradeSettingsColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, TRADE_SETTINGS_COLUMNS);
}

/**
 * デプロイ窓で欠落しうる streamers の新列(20261014120000 の migration で追加。
 * #1765 フォローアップ)。publish_live_status / publish_stats (#738) や
 * trade_enabled (#722) と同じ「アプリデプロイとmigration適用が独立した
 * タイミングで完了する」リスクを持つため、同型のフォールバックを追加する。
 *
 * STREAMERS_SAFE_COLUMNS はこの2列を含まない（＝再試行側では undefined に
 * なりうる）。消費側は欠落時に既定へ fail-closed（並び=3×3、初期表示=grid）で
 * 倒すこと。
 */
export const ALBUM_SETTINGS_COLUMNS = [
  "pack_album_grid_sizes",
  "collection_default_view",
] as const;

/**
 * streamers の pack_album_grid_sizes / collection_default_view 列の欠落
 * (20261014120000 の migration 未適用の環境)を検知する。
 */
export function isMissingAlbumSettingsColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, ALBUM_SETTINGS_COLUMNS);
}

/**
 * デプロイ窓で欠落しうる streamers の新列(20261015050000 の migration で追加。
 * Issue #934)。publish_live_status / publish_stats (#738) と同じ「アプリデプロイと
 * migration適用が独立したタイミングで完了する」リスクを持つため、同型のフォールバックを
 * 追加する。
 *
 * STREAMERS_SAFE_COLUMNS は #738 より前の列だけの固定リストであり、この列も元々
 * 含まれていない。そのため再投影先(STREAMERS_SAFE_COLUMNS)は変更不要で、検知条件だけを
 * この列にも広げればよい。
 */
export const CARD_RANKING_SETTINGS_COLUMNS = ["publish_card_ranking"] as const;

/**
 * streamers の publish_card_ranking 列の欠落
 * (20261015050000 の migration 未適用の環境)を検知する。
 */
export function isMissingCardRankingSettingsColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, CARD_RANKING_SETTINGS_COLUMNS);
}

/**
 * デプロイ窓で欠落しうる streamers の新列(20261015120000 の migration で追加。
 * Issue #1782)。上記各列と同じ「アプリデプロイとmigration適用が独立した
 * タイミングで完了する」リスクを持つため、同型のフォールバックに追加する。
 *
 * STREAMERS_SAFE_COLUMNS はこの列を含まない（＝再試行側では undefined に
 * なりうる）。消費側は欠落時に「段階表示なし」へ fail-closed に倒すこと
 * （sanitizeDuplicateDisplayTiers(undefined) は空マップを返すので、
 *  そのまま resolveDuplicateTier へ渡せば段階 0 = バッジなしになる）。
 */
export const DUPLICATE_DISPLAY_TIER_COLUMNS = ["duplicate_display_tiers"] as const;

/**
 * streamers の duplicate_display_tiers 列の欠落
 * (20261015120000 の migration 未適用の環境)を検知する。
 */
export function isMissingDuplicateDisplayTiersColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, DUPLICATE_DISPLAY_TIER_COLUMNS);
}

/**
 * デプロイ窓で欠落しうる streamers の新列(20261018020000 の migration で追加。
 * Issue #1783)。上記各列と同じ「アプリデプロイとmigration適用が独立した
 * タイミングで完了する」リスクを持つため、同型のフォールバックに追加する。
 *
 * getStreamerData は streamer: streamersTable の無指定 select（全列）を使うため、
 * この列が無い環境では SELECT 自体が 42703 で失敗する。検知条件に加えないと
 * フォールバックへ到達せず、ダッシュボードが null（= /dashboard へリダイレクト）
 * になる。
 *
 * STREAMERS_SAFE_COLUMNS はこの列を含まない（＝再試行側では undefined に
 * なりうる）。消費側は欠落時に「上書きなし = 既定表示」へ fail-closed に倒すこと
 * （`?? {}`）。
 */
export const RARITY_STYLES_COLUMNS = ["rarity_styles"] as const;

/**
 * streamers の rarity_styles 列の欠落
 * (20261018020000 の migration 未適用の環境)を検知する。
 */
export function isMissingRarityStylesColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, RARITY_STYLES_COLUMNS);
}

/**
 * デプロイ窓で欠落しうる streamers の新3列(20261122120000 の migration で追加。
 * Issue #2070 フォローアップ)。未所持カードの公開内容を名前・画像・説明で個別に
 * 切り替えるための設定列で、上記各グループと同じ「アプリデプロイと migration 適用が
 * 独立したタイミングで完了する」リスクを持つため、同型のフォールバック検知に追加する。
 *
 * 3列は1つの migration で同時に追加されるため、デプロイ窓では3列まとめて欠落する。
 * どれか1列でも 42703 になれば同じ安全列集合での再試行へ倒せばよいので、上の各グループと
 * 同様に1つの検知グループへまとめる。
 *
 * STREAMERS_SAFE_COLUMNS には含めない。消費側は欠落時、旧 show_unowned_card_details から
 * 導出（true→3項目すべて true / false→すべて false）して fail-closed に倒すこと
 * （C4b で resolver・dashboard-data・設定API に実装済み）。この導出は現行の
 * 「詳細公開」と同じ公開内容を維持するためのもので、項目別フラグが undefined のまま
 * 個別判定に流れると、設定意図と異なる公開・非公開になりうる。
 */
export const UNOWNED_CARD_ITEM_COLUMNS = [
  "show_unowned_card_name",
  "show_unowned_card_image",
  "show_unowned_card_description",
] as const;

/**
 * streamers の show_unowned_card_name / show_unowned_card_image /
 * show_unowned_card_description 列の欠落
 * (20261122120000 の migration 未適用の環境)を検知する。
 */
export function isMissingUnownedCardItemColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, UNOWNED_CARD_ITEM_COLUMNS);
}
