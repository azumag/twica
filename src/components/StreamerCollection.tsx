import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import Stats from "./Stats";
import ExpandableDescription from "./ExpandableDescription";
import CollectionCard from "./CollectionCard";
import type { Streamer, Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";
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

interface StreamerCollectionProps {
  streamer: Streamer;
  cards: CardWithDetails[];
  stats: {
    total: number;
    unique: number;
    legendary: number;
    epic: number;
    rare: number;
    common: number;
  };
}

/**
 * Streamer Collection Component (Server Component)
 * Displays user's card collection for a specific streamer
 * 配信者別コレクションコンポーネント（サーバーコンポーネント）
 * 特定の配信者のユーザーカードコレクションを表示
 */
export default async function StreamerCollection({ streamer, cards, stats }: StreamerCollectionProps) {
  const t = await getTranslations("collection");
  const tStreamer = await getTranslations("streamerCollection");
  const tCommon = await getTranslations("common");

  return (
    <div className="min-h-screen bg-gray-900 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header with streamer info */}
        {/* 配信者情報付きヘッダー */}
        <div className="mb-6 flex items-center gap-4">
          {streamer.twitch_profile_image_url && (
            // unoptimized: Twitch CDNから取得済みの画像のため、Vercel Image Transformationsをスキップしてコスト削減
            <Image
              src={streamer.twitch_profile_image_url}
              alt={streamer.twitch_display_name}
              width={64}
              height={64}
              className="h-16 w-16 rounded-full"
              unoptimized
            />
          )}
          <div>
            <h1 className="text-2xl font-bold text-white">
              {tStreamer("title", { streamerName: streamer.twitch_display_name })}
            </h1>
            <p className="text-gray-400">
              {t("cardTypes", { count: cards.length })}
            </p>
          </div>
        </div>

        {/* Stats */}
        <Stats stats={stats} />

        {/* Cards */}
        {cards.length === 0 ? (
          <div className="rounded-xl bg-gray-800 p-8 text-center">
            <p className="text-gray-400">
              {tStreamer("empty.line1")}
              <br />
              {tStreamer("empty.line2")}
            </p>
          </div>
        ) : (
          // Grid layout for cards - uses responsive columns
          // Small images (< 400px) are automatically displayed in compact cards
          // via the CollectionCard component's image size detection
          // items-start: グリッドアイテムを上揃えにして、コンパクトカードの高さを維持
          // カード用グリッドレイアウト - レスポンシブな列数を使用
          // 小さい画像（400px未満）はCollectionCardコンポーネントの
          // 画像サイズ検出により自動的にコンパクトカードで表示される
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-start">
            {cards.map((card, index) => {
              const rarityInfo = getRarityInfo(card.rarity);
              // First 4 cards get priority for LCP optimization
              // 最初の4枚のカードはLCP最適化のためpriority設定
              const isPriority = index < 4;
              return (
                <CollectionCard
                  key={card.id}
                  id={card.id}
                  name={card.name}
                  imageUrl={card.image_url}
                  description={card.description}
                  rarity={card.rarity}
                  rarityInfo={{
                    label: rarityInfo.label,
                    color: rarityInfo.color,
                  }}
                  count={card.count}
                  countLabel={t("cardCount", { count: card.count })}
                  priority={isPriority}
                  noImageText={tCommon("noImage")}
                  descriptionComponent={
                    card.description ? (
                      <ExpandableDescription description={card.description} />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}

        {/* Back link to full collection */}
        {/* フルコレクションへの戻りリンク */}
        <div className="mt-8 text-center">
          <Link
            href="/dashboard/collection"
            className="text-purple-400 hover:text-purple-300 transition-colors"
          >
            {tStreamer("viewFullCollection")}
          </Link>
        </div>
      </div>
    </div>
  );
}
