import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import OverlayPreview from "@/components/OverlayPreview";
import GachaSoundSettings from "@/components/GachaSoundSettings";

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

  // Fetch streamer data for settings
  // 設定用に配信者データを取得
  const streamerData = await getStreamerData(session.twitchUserId);

  if (!streamerData) {
    redirect("/dashboard");
  }

  return (
    <div>
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
          </>
        }
      />
    </div>
  );
}
