import Image from "next/image";
import Stats from "./Stats";
import type { Streamer, Card } from "@/types/database";
import { UI_STRINGS, RARITIES } from "@/lib/constants";
import type { Rarity } from "@/types/database";

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) =>
  RARITIES.find((r) => r.value === rarity) || RARITIES[0];

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
      <h2 className="mb-6 text-2xl font-semibold text-white">{UI_STRINGS.COLLECTION.TITLE}</h2>

      {/* Stats */}
      <Stats stats={stats} />

      {/* Cards by Streamer */}
      {Object.keys(cardsByStreamer).length === 0 ? (
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-400">
            {UI_STRINGS.COLLECTION.EMPTY_MESSAGE.LINE1}
            <br />
            {UI_STRINGS.COLLECTION.EMPTY_MESSAGE.LINE2}
          </p>
        </div>
      ) : (
        // Track global card index across all streamers for LCP priority
        // 全配信者を通じてカードインデックスを追跡してLCP優先度を設定
        (() => {
          let globalCardIndex = 0;
          return Object.values(cardsByStreamer).map(({ streamer, cards }) => (
          <div key={streamer.id} className="mb-8">
            <div className="mb-4 flex items-center gap-3">
              {streamer.twitch_profile_image_url && (
                // unoptimized: Twitch CDNから取得済みの画像のため、Vercel Image Transformationsをスキップしてコスト削減
                <Image
                  src={streamer.twitch_profile_image_url}
                  alt={streamer.twitch_display_name}
                  width={40}
                  height={40}
                  className="h-10 w-10 rounded-full"
                  unoptimized
                />
              )}
              <h3 className="text-xl font-semibold text-white">
                {streamer.twitch_display_name}
              </h3>
              <span className="text-sm text-gray-400">
                {UI_STRINGS.COLLECTION.CARD_TYPES(cards.length)}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {cards.map((card) => {
                const rarityInfo = getRarityInfo(card.rarity);
                // First 4 cards get priority for LCP optimization
                // 最初の4枚のカードはLCP最適化のためpriority設定
                const isPriority = globalCardIndex < 4;
                globalCardIndex++;
                return (
                  <div
                    key={card.id}
                    className="group relative overflow-hidden rounded-lg bg-gray-700"
                  >
                    {/* 名前とレアリティを一番上に配置 */}
                    <div className="p-3 pb-2">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-white truncate">{card.name}</h3>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs text-white shrink-0 ml-2 ${rarityInfo.color}`}
                        >
                          {rarityInfo.label}
                        </span>
                      </div>
                    </div>
                    {/* 正方形画像（トリミング） */}
                    <div className="aspect-square bg-gray-600">
                      {card.image_url ? (
                        // unoptimized: ImageCropperで400x400px・JPEG85%に最適化済みのため、Vercel Image Transformationsをスキップしてコスト削減
                        <Image
                          src={card.image_url}
                          alt={card.name}
                          width={300}
                          height={300}
                          className="w-full h-full object-cover"
                          priority={isPriority}
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-gray-500">
                          画像なし
                        </div>
                      )}
                    </div>
                    {/* 説明とカウント */}
                    <div className="p-3 pt-2">
                      {card.description && (
                        <p className="text-sm text-gray-300 line-clamp-2 mb-1">
                          {card.description}
                        </p>
                      )}
                      {card.count > 1 && (
                        <div className="text-sm text-gray-400">
                          {UI_STRINGS.COLLECTION.CARD_COUNT(card.count)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ));
        })()
      )}
    </section>
  );
}