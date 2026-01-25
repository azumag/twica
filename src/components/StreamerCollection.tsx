import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import Stats from "./Stats";
import SortedCardGrid from "./SortedCardGrid";
import type { Streamer, Card } from "@/types/database";

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
        {/* カード一覧 - SortedCardGridコンポーネントを使用して小さい画像を末尾にソート */}
        {cards.length === 0 ? (
          <div className="rounded-xl bg-gray-800 p-8 text-center">
            <p className="text-gray-400">
              {tStreamer("empty.line1")}
              <br />
              {tStreamer("empty.line2")}
            </p>
          </div>
        ) : (
          // SortedCardGrid: Displays cards with automatic sorting
          // Small images (< 400px) are moved to the end of the grid
          // Portrait images are displayed without frame
          // SortedCardGrid: カードを自動ソートして表示
          // 小さい画像（400px未満）はグリッドの末尾に移動
          // 縦長画像は枠なしで表示
          <SortedCardGrid
            cards={cards}
            streamerId={streamer.id}
            translations={{
              cardCount: (count: number) => t("cardCount", { count }),
              noImage: tCommon("noImage"),
            }}
          />
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
