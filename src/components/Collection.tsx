import Image from "next/image";
import Stats from "./Stats";
import type { Streamer, Card } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

interface CollectionProps {
  cardsByStreamer: Record<string, { streamer: Streamer; cards: CardWithDetails[] }>;
  stats: {
    total: number;
    unique: number;
    legendary: number;
    epic: number;
    rare: number;
    common: number;
  };
}

export default function Collection({ cardsByStreamer, stats }: CollectionProps) {
  return (
    <section>
      <h2 className="mb-6 text-2xl font-semibold text-white">マイコレクション</h2>

      {/* Stats */}
      <Stats stats={stats} />

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
                <Image
                  src={streamer.twitch_profile_image_url}
                  alt={streamer.twitch_display_name}
                  width={40}
                  height={40}
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
                      <Image
                        src={card.image_url}
                        alt={card.name}
                        width={200}
                        height={300}
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
                        className={`rounded-full px-2 py-0.5 text-xs text-white bg-yellow-500`}
                      >
                        {card.rarity}
                      </span>
                    </div>
                    {card.description && (
                      <p className="mb-2 text-xs text-gray-400 line-clamp-2">
                        {card.description}
                      </p>
                    )}
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
  );
}