import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Streamer, Card } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

/**
 * Calculate rarity statistics for a set of cards
 * カードセットのレアリティ別統計を計算
 */
const calculateStreamerStats = (cards: CardWithDetails[]) => ({
  total: cards.reduce((sum, c) => sum + c.count, 0),
  unique: cards.length,
  legendary: cards.filter((c) => c.rarity === "legendary").length,
  epic: cards.filter((c) => c.rarity === "epic").length,
  rare: cards.filter((c) => c.rarity === "rare").length,
  common: cards.filter((c) => c.rarity === "common").length,
});

interface CollectionProps {
  cardsByStreamer: Record<string, {
    streamer: Streamer;
    cards: CardWithDetails[];
    totalActive: number;
    ownedActive: number;
    isComplete?: boolean;
  }>;
}

/**
 * Collection Component (Server Component)
 * Displays summary of user's card collection by streamer
 * コレクションコンポーネント（サーバーコンポーネント）- 配信者ごとのコレクションサマリを表示
 */
export default async function Collection({ cardsByStreamer }: CollectionProps) {
  const t = await getTranslations("collection");
  const tStats = await getTranslations("stats");
  const tCollectionPage = await getTranslations("collectionPage");

  return (
    <section>
      <h2 className="mb-6 text-2xl font-semibold text-white">{t("title")}</h2>

      {/* Streamer List with Summary - 配信者一覧とサマリ */}
      {Object.keys(cardsByStreamer).length === 0 ? (
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-400">
            {t("empty.line1")}
            <br />
            {t("empty.line2")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.values(cardsByStreamer).map(({ streamer, cards, totalActive, ownedActive, isComplete }) => {
            // Calculate rarity statistics for each streamer
            // 各配信者のレアリティ別統計を計算
            const streamerStats = calculateStreamerStats(cards);
            const streamerCompletionPercent = totalActive > 0 ? Math.round((ownedActive / totalActive) * 100) : 0;
            const safeStreamerCompletionPercent = Math.max(0, Math.min(100, streamerCompletionPercent));
            return (
              <div
                key={streamer.id}
                className="rounded-xl bg-gray-800 p-4 hover:bg-gray-700 transition-colors"
              >
                {/* Streamer Header - 配信者ヘッダー */}
                <div className="flex items-center gap-3 mb-4">
                  {streamer.twitch_profile_image_url && (
                    // unoptimized: Twitch CDNから取得済みの画像のため、Vercel Image Transformationsをスキップしてコスト削減
                    <Image
                      src={streamer.twitch_profile_image_url}
                      alt={streamer.twitch_display_name}
                      width={48}
                      height={48}
                      className="h-12 w-12 rounded-full"
                      unoptimized
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="flex items-center gap-1 min-w-0 font-semibold text-white">
                      <span className="truncate">{streamer.twitch_display_name}</span>
                      {/* 勲章アイコン: ゴールド=現在コンプリート */}
                      {isComplete && (
                        <svg className="w-4 h-4 shrink-0 text-yellow-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M8 2l2 4h4l2-4H8z" opacity="0.7" />
                          <circle cx="12" cy="14" r="7" />
                          <path d="M12 9l1.5 3 3.5.5-2.5 2.5.5 3.5L12 16.5 9 18.5l.5-3.5L7 12.5l3.5-.5z" fill="white" opacity="0.3" />
                        </svg>
                      )}
                    </h3>
                    <p className="text-sm text-gray-400">
                      {tCollectionPage("streamerOwnedCards", {
                        total: streamerStats.total,
                      })}
                    </p>
                    <p className="text-xs text-gray-500">
                      {tCollectionPage("streamerCompletionProgress", {
                        owned: ownedActive,
                        total: totalActive,
                      })}
                    </p>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
                      <div
                        className="h-full rounded-full bg-emerald-500/90 transition-all"
                        style={{ width: `${safeStreamerCompletionPercent}%` }}
                        aria-label={tCollectionPage("progressAria", { percent: safeStreamerCompletionPercent })}
                      />
                    </div>
                  </div>
                </div>

                {/* Rarity Summary - レアリティサマリ */}
                <div className="grid grid-cols-4 gap-2 mb-4">
                  {/* Legendary */}
                  {streamerStats.legendary > 0 && (
                    <div className="rounded-lg bg-yellow-500/20 px-2 py-1 text-center">
                      <div className="text-sm font-bold text-yellow-400">{streamerStats.legendary}</div>
                      <div className="text-xs text-yellow-400/80">{tStats("legendary")}</div>
                    </div>
                  )}
                  {/* Epic */}
                  {streamerStats.epic > 0 && (
                    <div className="rounded-lg bg-purple-500/20 px-2 py-1 text-center">
                      <div className="text-sm font-bold text-purple-400">{streamerStats.epic}</div>
                      <div className="text-xs text-purple-400/80">{tStats("epic")}</div>
                    </div>
                  )}
                  {/* Rare */}
                  {streamerStats.rare > 0 && (
                    <div className="rounded-lg bg-blue-500/20 px-2 py-1 text-center">
                      <div className="text-sm font-bold text-blue-400">{streamerStats.rare}</div>
                      <div className="text-xs text-blue-400/80">{tStats("rare")}</div>
                    </div>
                  )}
                  {/* Common */}
                  {streamerStats.common > 0 && (
                    <div className="rounded-lg bg-gray-600/50 px-2 py-1 text-center">
                      <div className="text-sm font-bold text-gray-300">{streamerStats.common}</div>
                      <div className="text-xs text-gray-400">{tStats("common")}</div>
                    </div>
                  )}
                </div>

                {/* View Collection Button - コレクション表示ボタン */}
                <Link
                  href={`/collection/${streamer.id}`}
                  className="block w-full rounded-lg bg-purple-600 hover:bg-purple-700 px-4 py-2 text-center text-sm font-medium text-white transition-colors"
                >
                  {t("viewCollection")}
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
