import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import Stats from "./Stats";
import ExpandableDescription from "./ExpandableDescription";
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map((card, index) => {
              const rarityInfo = getRarityInfo(card.rarity);
              // First 4 cards get priority for LCP optimization
              // 最初の4枚のカードはLCP最適化のためpriority設定
              const isPriority = index < 4;
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
                        {tCommon("noImage")}
                      </div>
                    )}
                  </div>
                  {/* 説明とカウント */}
                  {/* Description (expandable) and count */}
                  <div className="p-3 pt-2">
                    {card.description && (
                      <ExpandableDescription description={card.description} />
                    )}
                    {card.count > 1 && (
                      <div className="text-sm text-gray-400">
                        {t("cardCount", { count: card.count })}
                      </div>
                    )}
                  </div>
                </div>
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
