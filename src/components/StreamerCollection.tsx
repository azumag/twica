import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import Stats from "./Stats";
import SortedCardGrid from "./SortedCardGrid";
import CollectionProgress from "./CollectionProgress";
import DuplicateCardExchange from "./DuplicateCardExchange";
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
  cardStoneBalance?: number;
  duplicateExchangeCards?: Array<{
    id: string;
    name: string;
    rarity: StreamerCollectionCard["rarity"];
    count: number;
    collectionNumber?: number;
    stoneValue: number;
  }>;
  // 未所持カードの画像/説明を隠すか（プレースホルダー表示にするか）
  // Issue #395: streamer の show_unowned_card_details=false のときに true。
  // When true, unowned cards are rendered as placeholders (no image / no description).
  hideUnownedDetails?: boolean;
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
  cardStoneBalance = 0,
  duplicateExchangeCards = [],
  hideUnownedDetails = false,
}: StreamerCollectionProps) {
  const t = await getTranslations("collection");
  const tStreamer = await getTranslations("streamerCollection");
  const tCommon = await getTranslations("common");
  const tCardManager = await getTranslations("cardManager");

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
        <CollectionProgress owned={progress.owned} total={progress.total} completionHistory={completionHistory} />
        <DuplicateCardExchange
          balance={cardStoneBalance}
          cards={duplicateExchangeCards}
          translations={{
            title: t("duplicateExchange.title"),
            balance: t("duplicateExchange.balance", { count: "{count}" }),
            empty: t("duplicateExchange.empty"),
            description: t("duplicateExchange.description"),
            exchange: t("duplicateExchange.exchange"),
            exchanging: t("duplicateExchange.exchanging"),
            cardNumberTemplate: t("cardNumber"),
            duplicateCountTemplate: t("duplicateExchange.duplicateCount", { count: "{count}" }),
            stoneValueTemplate: t("duplicateExchange.stoneValue", { count: "{count}" }),
            confirmTemplate: t("duplicateExchange.confirmMessage", { name: "{name}", count: "{count}" }),
            successTemplate: t("duplicateExchange.success", { count: "{count}" }),
            errorFallback: t("duplicateExchange.errorFallback"),
          }}
        />

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
            translations={{
              // Pass template string instead of function (Server -> Client serialization)
              // 関数ではなくテンプレート文字列を渡す（サーバー→クライアントのシリアライズ用）
              cardCountTemplate: t("cardCount", { count: "{count}" }),
              noImage: tCommon("noImage"),
              unownedCard: t("unownedCard"),
              inactiveStatus: tCardManager("status.paused"),
              cardNumberTemplate: t("cardNumber"),
              sortLabel: t("sort.label"),
              sortByNumber: t("sort.number"),
              sortByRarity: t("sort.rarity"),
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
