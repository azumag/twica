import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import Stats from "./Stats";
import SortedCardGrid from "./SortedCardGrid";
import CollectionProgress from "./CollectionProgress";
import CollectionPackFilter from "./CollectionPackFilter";
import type { CollectionPackDisplay } from "./CollectionPackFilter";
import type { Streamer, Card } from "@/types/database";

export interface StreamerCollectionCard extends Card {
  count: number;
  isOwned: boolean;
  collectionNumber?: number;
}

interface StreamerCollectionProps {
  streamer: Streamer;
  cards: StreamerCollectionCard[];
  stats: {
    total: number;
    unique: number;
    legendary: number;
    epic: number;
    rare: number;
    common: number;
    // カスタムレアリティ別の所持ユニーク数（デフォルト4種以外）。
    // 後方互換のため optional（Stats 側で `?? []` ガード）。
    customRarities?: { rarity: string; count: number }[];
  };
  progress: {
    owned: number;
    total: number;
  };
  visibleCardTypes: number;
  // 過去のコンプリート達成履歴（デフォルト空配列で後方互換）
  completionHistory?: { total_cards: number; completed_at: string }[];
  // 未所持カードの画像/説明を隠すか（プレースホルダー表示にするか）
  // Issue #395: streamer の show_unowned_card_details=false のときに true。
  // When true, unowned cards are rendered as placeholders (no image / no description).
  hideUnownedDetails?: boolean;
  // パック絞り込みタブに表示するパック一覧 (Issue #557)。空配列（デフォルト）
  // のときはフィルタUIを一切出さず従来表示のまま（名前付きパック未使用の
  // 配信者では見た目・挙動とも完全に不変）。
  // Pack filter tabs. Empty (default) = no filter UI, legacy layout untouched.
  packs?: CollectionPackDisplay[];
}

/**
 * Streamer Collection Component (Server Component)
 * Displays user's card collection for a specific streamer
 * 配信者別コレクションコンポーネント（サーバーコンポーネント）
 * 特定の配信者のユーザーカードコレクションを表示
 */
export default async function StreamerCollection({
  streamer,
  cards,
  stats,
  progress,
  visibleCardTypes,
  completionHistory = [],
  hideUnownedDetails = false,
  packs = [],
}: StreamerCollectionProps) {
  const t = await getTranslations("collection");
  const tStreamer = await getTranslations("streamerCollection");
  const tCommon = await getTranslations("common");
  const tCardManager = await getTranslations("cardManager");

  // SortedCardGrid 向けのシリアライズ済み翻訳。従来表示とパックフィルタ表示の
  // 両方でグリッドを描画するため、1回だけ組み立てて共有する。
  // Pass template strings instead of functions (Server -> Client serialization)
  // 関数ではなくテンプレート文字列を渡す（サーバー→クライアントのシリアライズ用）
  const gridTranslations = {
    cardCountTemplate: t("cardCount", { count: "{count}" }),
    noImage: tCommon("noImage"),
    unownedCard: t("unownedCard"),
    inactiveStatus: tCardManager("status.paused"),
    cardNumberTemplate: t("cardNumber"),
    sortLabel: t("sort.label"),
    sortByNumber: t("sort.number"),
    sortByRarity: t("sort.rarity"),
  };

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
              {t("cardTypes", { count: visibleCardTypes })}
            </p>
          </div>
        </div>

        {/* Stats */}
        <Stats stats={stats} />

        {packs.length > 0 ? (
          // Issue #557: 名前付きパックがある場合はパック絞り込みUI。
          // 進捗表示とグリッドは選択スコープに応じてクライアント側で切り替わる
          // （「すべて」選択時は下の従来表示と同一の入力になる）。
          <CollectionPackFilter
            cards={cards}
            streamerId={streamer.id}
            hideUnownedDetails={hideUnownedDetails}
            overallProgress={progress}
            overallCompletionHistory={completionHistory}
            packs={packs}
            gridTranslations={gridTranslations}
          />
        ) : (
          <>
            <CollectionProgress owned={progress.owned} total={progress.total} completionHistory={completionHistory} />

            {/* Cards */}
            {/* カード一覧 */}
            {cards.length === 0 ? (
              <div className="rounded-xl bg-gray-800 p-8 text-center">
                <p className="text-gray-400">
                  {tStreamer("empty.line1")}
                  <br />
                  {tStreamer("empty.line2")}
                </p>
              </div>
            ) : (
              // SortedCardGrid: 全カード統一サイズ（正方形 + object-cover）のグリッド表示
              // レアリティ順はサーバーサイドで事前ソート済み
              <SortedCardGrid
                cards={cards}
                streamerId={streamer.id}
                hideUnownedDetails={hideUnownedDetails}
                translations={gridTranslations}
              />
            )}
          </>
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
