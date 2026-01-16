import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData, getUserCards, getRecentGachaHistory } from "@/lib/dashboard-data";
import { RARITY_ORDER } from "@/lib/constants";
import type { Card, Streamer } from "@/types/database";
import Header from "@/components/Header";
import StreamerSettings from "@/components/StreamerSettings";
import RecentWins from "@/components/RecentWins";
import Collection from "@/components/Collection";
import DevelopmentNotice from "@/components/DevelopmentNotice";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/api/auth/twitch/login");
  }

  const isStreamer = canUseStreamerFeatures(session);
  const streamerData = isStreamer ? await getStreamerData(session.twitchUserId) : null;
  const userCards = await getUserCards(session.twitchUserId);
  const recentGacha = await getRecentGachaHistory();

  // Sort cards by rarity
  userCards.sort((a, b) => {
    return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
  });

  // Group by streamer
  const cardsByStreamer = userCards.reduce((acc, card) => {
    const streamerId = card.streamer.id;
    if (!acc[streamerId]) {
      acc[streamerId] = {
        streamer: card.streamer,
        cards: [],
      };
    }
    acc[streamerId].cards.push(card);
    return acc;
  }, {} as Record<string, { streamer: Streamer; cards: CardWithDetails[] }>);

  const stats = {
    total: userCards.reduce((sum, c) => sum + c.count, 0),
    unique: userCards.length,
    legendary: userCards.filter((c) => c.rarity === "legendary").length,
    epic: userCards.filter((c) => c.rarity === "epic").length,
    rare: userCards.filter((c) => c.rarity === "rare").length,
    common: userCards.filter((c) => c.rarity === "common").length,
  };

  return (
    <div className="min-h-screen bg-gray-900">
      <DevelopmentNotice />
      <Header session={session} />

      <main className="container mx-auto px-4 py-8">
        <h1 className="mb-8 text-3xl font-bold text-white">ダッシュボード</h1>

        {/* Streamer Settings Section */}
        {isStreamer && streamerData && (
          <StreamerSettings streamerData={streamerData} />
        )}

        {/* Not a streamer info */}
        {!isStreamer && (
          <div className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-2 text-lg font-semibold text-white">
              配信者機能について
            </h2>
            <p className="text-gray-400">
              チャネルポイント報酬やカード管理機能を使用するには、Twitchアフィリエイトまたはパートナーである必要があります。
            </p>
          </div>
        )}

        {/* Global Recent Wins Section */}
        <RecentWins recentGacha={recentGacha} />

        {/* Collection Section */}
        <Collection cardsByStreamer={cardsByStreamer} stats={stats} />
      </main>
    </div>
  );
}
