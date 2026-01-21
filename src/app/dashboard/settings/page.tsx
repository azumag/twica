import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CopyButton from "@/components/CopyButton";
import { UI_STRINGS } from "@/lib/constants";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Settings page for streamers
 * Includes OBS overlay URL and channel point reward configuration
 * 配信者向け設定ページ
 * OBSオーバーレイURLとチャネルポイント報酬の設定を含む
 */
export default async function SettingsPage() {
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
          {UI_STRINGS.SETTINGS_PAGE.TITLE}
        </h1>
        <p className="mt-2 text-gray-400">
          {UI_STRINGS.SETTINGS_PAGE.DESCRIPTION}
        </p>
      </div>

      {/* Settings grid */}
      {/* 設定グリッド */}
      <div className="grid gap-8 lg:grid-cols-2">
        {/* OBS Overlay URL Section */}
        {/* OBSオーバーレイURLセクション */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {UI_STRINGS.DASHBOARD.OBS_OVERLAY_URL}
          </h2>
          <p className="mb-4 text-sm text-gray-400">
            {UI_STRINGS.DASHBOARD.OBS_OVERLAY_DESCRIPTION}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={`${process.env.NEXT_PUBLIC_APP_URL}/overlay/${streamerData.streamer.id}`}
              className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
            />
            <CopyButton
              text={`${process.env.NEXT_PUBLIC_APP_URL}/overlay/${streamerData.streamer.id}`}
            />
          </div>
        </div>

        {/* Channel Point Settings Section */}
        {/* チャネルポイント設定セクション */}
        <ChannelPointSettings
          streamerId={streamerData.streamer.id}
          currentRewardId={streamerData.streamer.channel_point_reward_id}
          currentRewardName={streamerData.streamer.channel_point_reward_name}
        />
      </div>
    </div>
  );
}
