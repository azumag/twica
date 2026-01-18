import { getStreamerData } from "@/lib/dashboard-data";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CardManager from "@/components/CardManager";
import CopyButton from "@/components/CopyButton";
import type { Card } from "@/types/database";
import { UI_STRINGS } from "@/lib/constants";

interface StreamerSettingsProps {
  streamerData: Awaited<ReturnType<typeof getStreamerData>>;
}

export default function StreamerSettings({ streamerData }: StreamerSettingsProps) {
  if (!streamerData) return null;

  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">{UI_STRINGS.DASHBOARD.STREAMER_SETTINGS}</h2>
      <div className="grid gap-8 lg:grid-cols-2">
        {/* OBS Overlay URL */}
        <div className="rounded-xl bg-gray-800 p-6">
          <h3 className="mb-4 text-xl font-semibold text-white">
            {UI_STRINGS.DASHBOARD.OBS_OVERLAY_URL}
          </h3>
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