import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import { getCustomBotAccountDisplayForStreamer } from "@/lib/twitch/token-manager";
import { shouldShowVoteCampaign } from "@/lib/storage-db";
import { VOTE_CAMPAIGN_CONFIG } from "@/lib/constants";
import VoteCampaignButton from "@/components/VoteCampaignButton";

const OverlayPreview = dynamic(() => import("@/components/OverlayPreview"), {
  loading: () => (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 text-sm text-gray-400">
      Loading overlay preview...
    </div>
  ),
});

const ChannelPointSettings = dynamic(() => import("@/components/ChannelPointSettings"), {
  loading: () => <SettingsPanelSkeleton />,
});
const GachaSoundSettings = dynamic(() => import("@/components/GachaSoundSettings"), {
  loading: () => <SettingsPanelSkeleton />,
});
const ChatAnnouncementSettings = dynamic(() => import("@/components/ChatAnnouncementSettings"), {
  loading: () => <SettingsPanelSkeleton />,
});
const CardVisibilitySettings = dynamic(() => import("@/components/CardVisibilitySettings"), {
  loading: () => <SettingsPanelSkeleton />,
});

function SettingsPanelSkeleton() {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
      <div className="h-4 w-1/3 rounded bg-gray-700" />
      <div className="mt-3 h-3 w-2/3 rounded bg-gray-700" />
    </div>
  );
}

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Settings page for streamers
 * Includes OBS overlay URL and channel point reward configuration
 * 配信者向け設定ページ
 * OBSオーバーレイURLとチャネルポイント報酬の設定を含む
 */
export default async function SettingsPage() {
  const t = await getTranslations("settingsPage");
  const session = await getSession();

  // Session check is handled by layout, but double-check for safety
  // セッションチェックはレイアウトで行われるが、安全のため再確認
  if (!session) {
    redirect("/");
  }

  // Redirect non-streamers to main dashboard
  // 非配信者はメインダッシュボードにリダイレクト
  const isStreamer = canUseStreamerFeatures(session);
  if (!isStreamer) {
    redirect("/dashboard");
  }

  // 配信者データ取得とキャンペーン判定を並列実行してレイテンシ削減
  const [streamerData, showVoteCampaign] = await Promise.all([
    getStreamerData(session.twitchUserId),
    shouldShowVoteCampaign(session.twitchUserId),
  ]);

  if (!streamerData) {
    redirect("/dashboard");
  }

  const botAccount = await getCustomBotAccountDisplayForStreamer(streamerData.streamer.id);

  return (
    <div>
      {/* 投票キャンペーンボタン（期間内かつ未適用の場合のみ表示） */}
      <VoteCampaignButton visible={showVoteCampaign} bonusMb={VOTE_CAMPAIGN_CONFIG.BONUS_MB} />

      {/* Page header */}
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mt-2 text-gray-400">
          {t("description")}
        </p>
      </div>

      {/* OBSブラウザソースURLとカード引換設定を横並びに配置、プレビューは下に全幅で表示 */}
      {/* URL settings and channel point settings side by side, preview below full width */}
      {/* cardsを渡してセレクトボックスでカードを選択可能にする */}
      {/* Pass cards prop to enable card selection in dropdown */}
      <OverlayPreview
        streamerId={streamerData.streamer.id}
        baseUrl={process.env.NEXT_PUBLIC_APP_URL || ""}
        cards={streamerData.cards}
        sideContent={
          <>
            <ChannelPointSettings
              streamerId={streamerData.streamer.id}
              currentRewardId={streamerData.streamer.channel_point_reward_id}
              currentRewardName={streamerData.streamer.channel_point_reward_name}
            />
            {/* ガチャ効果音設定 */}
            {/* Gacha sound effect settings */}
            <GachaSoundSettings
              streamerId={streamerData.streamer.id}
              currentSoundUrl={streamerData.streamer.gacha_sound_url ?? null}
              currentSoundEnabled={streamerData.streamer.gacha_sound_enabled ?? false}
            />
            {/* チャット通知設定 */}
            {/* Chat announcement settings */}
            <ChatAnnouncementSettings
              streamerId={streamerData.streamer.id}
              currentEnabled={streamerData.streamer.chat_announcement_enabled ?? false}
              currentTemplate={streamerData.streamer.chat_announcement_template ?? null}
              currentMultiTemplate={streamerData.streamer.chat_announcement_multi_template ?? null}
              currentMultiShowCards={streamerData.streamer.chat_announcement_multi_show_cards ?? true}
              botAccount={botAccount}
            />
            {/* 未所持カード表示設定（Issue #395） */}
            {/* Unowned-card visibility settings (Issue #395) */}
            <CardVisibilitySettings
              streamerId={streamerData.streamer.id}
              currentShowUnowned={streamerData.streamer.show_unowned_cards ?? false}
              currentShowUnownedDetails={
                streamerData.streamer.show_unowned_card_details ?? false
              }
            />
          </>
        }
      />
    </div>
  );
}
