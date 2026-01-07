import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Card, Streamer } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

async function getUserCards(twitchUserId: string): Promise<CardWithDetails[]> {
  const supabaseAdmin = getSupabaseAdmin();

  // First get the user
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!user) return [];

  // Get user's cards with streamer info
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

  // Group cards and count duplicates
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

export default async function CollectionPage() {
  const session = await getSession();

  if (!session) {
    redirect("/api/auth/twitch/login?role=user");
  }

  const cards = await getUserCards(session.twitchUserId);

  // Sort by rarity
  cards.sort((a, b) => {
    return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
  });

  // Group by streamer
  const cardsByStreamer = cards.reduce((acc, card) => {
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
    total: cards.reduce((sum, c) => sum + c.count, 0),
    unique: cards.length,
    legendary: cards.filter((c) => c.rarity === "legendary").length,
    epic: cards.filter((c) => c.rarity === "epic").length,
    rare: cards.filter((c) => c.rarity === "rare").length,
    common: cards.filter((c) => c.rarity === "common").length,
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
        <h1 className="mb-8 text-3xl font-bold text-white">マイコレクション</h1>

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
                <h2 className="text-xl font-semibold text-white">
                  {streamer.twitch_display_name}
                </h2>
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
                        <h3 className="font-semibold text-white">{card.name}</h3>
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
      </main>
    </div>
  );
}
