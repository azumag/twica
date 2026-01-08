import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Card, Streamer } from "@/types/database";
import CardManager from "@/components/CardManager";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import CopyButton from "@/components/CopyButton";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

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

async function getUserCards(twitchUserId: string): Promise<CardWithDetails[]> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!user) return [];

  const { data: userCards } = await supabaseAdmin
    .from("user_cards")
    .select(`
      card_id,
      cards (
        *,
        streamers (*)
      )
    `)
    .eq("user_id", user.id);

  if (!userCards) return [];

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of userCards) {
    const card = uc.cards as unknown as Card & { streamers: Streamer };
    if (!card) continue;

    const existing = cardMap.get(card.id);
    if (existing) {
      existing.count++;
    } else {
      cardMap.set(card.id, {
        ...card,
        streamer: card.streamers,
        count: 1,
      });
    }
  }

  return Array.from(cardMap.values());
}

const RARITY_ORDER = ["legendary", "epic", "rare", "common"];
const RARITY_COLORS = {
  common: "bg-gray-500",
  rare: "bg-blue-500",
  epic: "bg-purple-500",
  legendary: "bg-yellow-500",
};

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/api/auth/twitch/login");
  }

  const isStreamer = canUseStreamerFeatures(session);
  const streamerData = isStreamer ? await getStreamerData(session.twitchUserId) : null;
  const userCards = await getUserCards(session.twitchUserId);

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
              {isStreamer && (
                <span className="rounded bg-purple-600 px-2 py-0.5 text-xs text-white">
                  {session.broadcasterType}
                </span>
              )}
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

        {/* Streamer Settings Section */}
        {isStreamer && streamerData && (
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

        {/* Collection Section */}
        <section>
          <h2 className="mb-6 text-2xl font-semibold text-white">マイコレクション</h2>

          {/* Stats */}
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <div className="rounded-xl bg-gray-800 p-4 text-center">
              <div className="text-3xl font-bold text-white">{stats.total}</div>
              <div className="text-sm text-gray-400">総カード数</div>
            </div>
            <div className="rounded-xl bg-gray-800 p-4 text-center">
              <div className="text-3xl font-bold text-white">{stats.unique}</div>
              <div className="text-sm text-gray-400">ユニーク</div>
            </div>
            <div className="rounded-xl bg-yellow-500/20 p-4 text-center">
              <div className="text-3xl font-bold text-yellow-400">
                {stats.legendary}
              </div>
              <div className="text-sm text-yellow-400/70">レジェンダリー</div>
            </div>
            <div className="rounded-xl bg-purple-500/20 p-4 text-center">
              <div className="text-3xl font-bold text-purple-400">
                {stats.epic}
              </div>
              <div className="text-sm text-purple-400/70">エピック</div>
            </div>
            <div className="rounded-xl bg-blue-500/20 p-4 text-center">
              <div className="text-3xl font-bold text-blue-400">{stats.rare}</div>
              <div className="text-sm text-blue-400/70">レア</div>
            </div>
            <div className="rounded-xl bg-gray-500/20 p-4 text-center">
              <div className="text-3xl font-bold text-gray-400">
                {stats.common}
              </div>
              <div className="text-sm text-gray-400/70">コモン</div>
            </div>
          </div>

          {/* Cards by Streamer */}
          {Object.keys(cardsByStreamer).length === 0 ? (
            <div className="rounded-xl bg-gray-800 p-8 text-center">
              <p className="text-gray-400">
                まだカードを持っていません。
                <br />
                配信者のチャネルポイントを使ってカードをゲットしましょう！
              </p>
            </div>
          ) : (
            Object.values(cardsByStreamer).map(({ streamer, cards }) => (
              <div key={streamer.id} className="mb-8">
                <div className="mb-4 flex items-center gap-3">
                  {streamer.twitch_profile_image_url && (
                    <img
                      src={streamer.twitch_profile_image_url}
                      alt={streamer.twitch_display_name}
                      className="h-10 w-10 rounded-full"
                    />
                  )}
                  <h3 className="text-xl font-semibold text-white">
                    {streamer.twitch_display_name}
                  </h3>
                  <span className="text-sm text-gray-400">
                    ({cards.length} 種類)
                  </span>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {cards.map((card) => (
                    <div
                      key={card.id}
                      className="group relative overflow-hidden rounded-lg bg-gray-800"
                    >
                      <div className="aspect-[3/4] bg-gray-700">
                        {card.image_url ? (
                          <img
                            src={card.image_url}
                            alt={card.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-4xl">
                            🎴
                          </div>
                        )}
                      </div>
                      <div className="p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <h4 className="font-semibold text-white">{card.name}</h4>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs text-white ${
                              RARITY_COLORS[card.rarity]
                            }`}
                          >
                            {card.rarity}
                          </span>
                        </div>
                        {card.count > 1 && (
                          <div className="text-sm text-gray-400">
                            x{card.count}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      </main>
    </div>
  );
}
