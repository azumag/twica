import { getStreamerData } from "@/lib/dashboard-data";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CardManager from "@/components/CardManager";
import CopyButton from "@/components/CopyButton";
import type { Card } from "@/types/database";

interface StreamerSettingsProps {
  streamerData: Awaited<ReturnType<typeof getStreamerData>>;
}

export default function StreamerSettings({ streamerData }: StreamerSettingsProps) {
  if (!streamerData) return null;

  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">配信者設定</h2>
      <div className="grid gap-8 lg:grid-cols-2">
        {/* OBS Overlay URL */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h3 className="mb-4 text-xl font-semibold text-white">
            OBSブラウザソースURL
          </h3>
          <p className="mb-4 text-sm text-gray-400">
            OBSのブラウザソースにこのURLを設定してください（推奨サイズ:
            800x600）
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={`${process.env.NEXT_PUBLIC_APP_URL}/overlay/${streamerData.streamer.id}`}
              className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
            />
            <CopyButton text={`${process.env.NEXT_PUBLIC_APP_URL}/overlay/${streamerData.streamer.id}`} />
          </div>
        </div>

        {/* Channel Point Settings */}
        <ChannelPointSettings
          streamerId={streamerData.streamer.id}
          currentRewardId={streamerData.streamer.channel_point_reward_id}
          currentRewardName={streamerData.streamer.channel_point_reward_name}
        />
      </div>

        {/* Card Manager */}
        <div className="mt-8">
          <CardManager
            streamerId={streamerData.streamer.id}
            initialCards={streamerData.cards as Card[]}
          />
        </div>
    </section>
  );
}