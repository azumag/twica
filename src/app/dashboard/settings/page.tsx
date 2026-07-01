import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import { getCustomBotAccountDisplayForStreamer } from "@/lib/twitch/token-manager";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
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

  const [streamerData, showVoteCampaign] = await Promise.all([
    getStreamerData(session.twitchUserId),
    shouldShowVoteCampaign(session.twitchUserId),
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
      initialModeHint={hasAdvancedSettingsInUse ? "advanced" : "simple"}
    />
  );
}
