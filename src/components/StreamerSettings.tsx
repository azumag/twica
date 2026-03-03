import { getTranslations } from "next-intl/server";
import { getStreamerData } from "@/lib/dashboard-data";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CardManager from "@/components/CardManager";
import CopyButton from "@/components/CopyButton";
import OverlayPreview from "@/components/OverlayPreview";
import type { Card } from "@/types/database";

interface StreamerSettingsProps {
  streamerData: Awaited<ReturnType<typeof getStreamerData>>;
}

/**
 * Streamer Settings Component (Server Component)
 * Displays streamer-specific settings including OBS overlay and channel point configuration
 * 配信者設定コンポーネント（サーバーコンポーネント）- OBSオーバーレイとチャネルポイント設定を含む配信者固有の設定を表示
 */
export default async function StreamerSettings({ streamerData }: StreamerSettingsProps) {
  const t = await getTranslations("dashboard");
  if (!streamerData) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "";

  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">{t("streamerSettings")}</h2>
      <div className="grid gap-8 lg:grid-cols-2">
        {/* OBS Overlay URL */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h3 className="mb-4 text-xl font-semibold text-white">
            {t("obsOverlayUrl")}
          </h3>
          <p className="mb-4 text-sm text-gray-400">
            {t("obsOverlayDescription")}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={`${baseUrl}/overlay/${streamerData.streamer.id}`}
              className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
            />
            <CopyButton text={`${baseUrl}/overlay/${streamerData.streamer.id}`} />
          </div>
        </div>

        {/* Channel Point Settings */}
        <ChannelPointSettings
          streamerId={streamerData.streamer.id}
          currentRewardId={streamerData.streamer.channel_point_reward_id}
          currentRewardName={streamerData.streamer.channel_point_reward_name}
        />
      </div>

      {/* Overlay Preview - オーバーレイ設定とプレビュー */}
      {/* カード一覧を渡してデバッグ用にセレクトボックスで選択可能にする */}
      <div className="mt-8">
        <OverlayPreview
          streamerId={streamerData.streamer.id}
          baseUrl={baseUrl}
          cards={streamerData.cards as Card[]}
        />
      </div>

      {/* Card Manager */}
      <div className="mt-8">
        <CardManager
          streamerId={streamerData.streamer.id}
          initialCards={streamerData.cards as Card[]}
          initialRarityWeights={streamerData.streamer.rarity_weights}
        />
      </div>
    </section>
  );
}
