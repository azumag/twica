import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Card } from "@/types/database";
import CardManager from "@/components/CardManager";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CopyButton from "@/components/CopyButton";

async function getStreamerData(twitchUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!streamer) return null;

  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamer.id)
    .order("created_at", { ascending: false });

  return { streamer, cards: cards || [] };
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session || session.role !== "streamer") {
    redirect("/api/auth/twitch/login?role=streamer");
  }

  const data = await getStreamerData(session.twitchUserId);

  if (!data) {
    redirect("/");
  }

  const { streamer, cards } = data;
  const overlayUrl = `${process.env.NEXT_PUBLIC_APP_URL}/overlay/${streamer.id}`;

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <Link href="/" className="text-2xl font-bold text-white">
            TwiCa
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {session.twitchProfileImageUrl && (
                <img
                  src={session.twitchProfileImageUrl}
                  alt={session.twitchDisplayName}
                  className="h-8 w-8 rounded-full"
                />
              )}
              <span className="text-white">{session.twitchDisplayName}</span>
            </div>
            <Link
              href="/api/auth/logout"
              className="rounded-lg border border-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-800"
            >
              ログアウト
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <h1 className="mb-8 text-3xl font-bold text-white">ダッシュボード</h1>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* OBS Overlay URL */}
          <div className="rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              OBSブラウザソースURL
            </h2>
            <p className="mb-4 text-sm text-gray-400">
              OBSのブラウザソースにこのURLを設定してください（推奨サイズ:
              800x600）
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={overlayUrl}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
              />
              <CopyButton text={overlayUrl} />
            </div>
          </div>

          {/* Channel Point Settings */}
          <ChannelPointSettings
            streamerId={streamer.id}
            currentRewardId={streamer.channel_point_reward_id}
            currentRewardName={streamer.channel_point_reward_name}
          />
        </div>

        {/* Card Manager */}
        <div className="mt-8">
          <CardManager streamerId={streamer.id} initialCards={cards as Card[]} />
        </div>
      </main>
    </div>
  );
}
