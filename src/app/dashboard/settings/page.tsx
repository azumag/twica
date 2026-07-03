import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import { getCustomBotAccountDisplayForStreamer } from "@/lib/twitch/token-manager";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
import { getUserPlan } from "@/lib/plan";
import SettingsLayout from "@/components/SettingsLayout";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Settings page for streamers
 * 配信者向け設定ページ
 *
 * UX: Progressive disclosure with two modes.
 * - Simple = quick-start 2-step layout (OBS URL + reward picker compact)
 * - Advanced = sidebar nav with one section visible at a time
 * 既存ユーザーで詳細機能が有効化済みの場合は初期モードを "advanced" にして、
 * 設定が消えたように見える混乱を避ける。localStorage の選択が優先。
 */
export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const isStreamer = canUseStreamerFeatures(session);
  if (!isStreamer) redirect("/dashboard");

  const [streamerData, showVoteCampaign, plan] = await Promise.all([
    getStreamerData(session.twitchUserId),
    shouldShowVoteCampaign(session.twitchUserId),
    // Issue #554: カードパックのプルダウン表示制御用。dashboard/cards/page.tsx の
    // 既存パターン(plan !== "basic")を踏襲する。
    // Issue #176: ガチャ効果音ルールのプレミアムゲート判定にも同じ plan を利用する。
    getUserPlan(session.twitchUserId),
  ]);
  if (!streamerData) redirect("/dashboard");

  const botAccount = await getCustomBotAccountDisplayForStreamer(streamerData.streamer.id);

  const hasAdvancedSettingsInUse =
    Boolean(streamerData.streamer.gacha_sound_enabled) ||
    Boolean(streamerData.streamer.chat_announcement_enabled) ||
    Boolean(streamerData.streamer.show_unowned_cards) ||
    Boolean(streamerData.streamer.show_unowned_card_details);

  return (
    <SettingsLayout
      streamerId={streamerData.streamer.id}
      plan={plan}
      baseUrl={process.env.NEXT_PUBLIC_APP_URL || ""}
      cards={streamerData.cards}
      showVoteCampaign={showVoteCampaign}
      botAccount={botAccount}
      channelPoint={{
        rewardId: streamerData.streamer.channel_point_reward_id,
        rewardName: streamerData.streamer.channel_point_reward_name,
        collectionName: streamerData.streamer.channel_point_collection_name ?? null,
      }}
      gachaSound={{
        soundUrl: streamerData.streamer.gacha_sound_url ?? null,
        soundEnabled: streamerData.streamer.gacha_sound_enabled ?? false,
        soundRules: streamerData.streamer.gacha_sound_rules,
      }}
      chatAnnouncement={{
        enabled: streamerData.streamer.chat_announcement_enabled ?? false,
        template: streamerData.streamer.chat_announcement_template ?? null,
        multiTemplate: streamerData.streamer.chat_announcement_multi_template ?? null,
        multiShowCards: streamerData.streamer.chat_announcement_multi_show_cards ?? true,
      }}
      visibility={{
        showUnowned: streamerData.streamer.show_unowned_cards ?? false,
        showUnownedDetails: streamerData.streamer.show_unowned_card_details ?? false,
      }}
      cardPacks={{
        // canManage=false によるパックselectの非表示/disabled は progressive
        // disclosure / アップセル導線としての「UX」であり、セキュリティ境界では
        // ない。サーバー側 (/api/streamer/settings) は意図的に既存パックの
        // 紐付け(選択)をプランでゲートしない — #553 の確立済み設計のとおり、
        // ゲート対象は「新規パック名の登録」のみ(理由は src/lib/plan-gate.ts 参照)。
        // basicユーザーがAPIを直接叩いて紐付けても、パック登録自体ができない
        // 以上、実質的な価値流出はない。
        canManage: plan !== "basic",
        // 列未デプロイのデプロイ窓では実行時に undefined になり得るため `?? null` でフォールバック。
        defaultPackName: streamerData.streamer.default_card_pack_name ?? null,
      }}
      initialModeHint={hasAdvancedSettingsInUse ? "advanced" : "simple"}
    />
  );
}
