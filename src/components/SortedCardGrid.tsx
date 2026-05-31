"use client";

import { useMemo, useState } from "react";
import CollectionCard from "./CollectionCard";
import ExpandableDescription from "./ExpandableDescription";
import type { Rarity, Card } from "@/types/database";
import { getRarityDisplayInfo } from "@/lib/rarity";
import { sortCollectedCards, type CollectionSortMode } from "@/lib/collection-utils";

/**
 * Get rarity information (label and color) for a given rarity value.
 * カスタムレアリティも正しく表示するため共通ヘルパに集約。
 */
const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

interface CardWithDetails extends Card {
  count: number;
  isOwned?: boolean;
  collectionNumber?: number;
}

interface SortedCardGridProps {
  // Cards to display (already sorted by rarity)
  // 表示するカード（既にレアリティでソート済み）
  cards: CardWithDetails[];
  // Streamer ID for linking to card detail pages
  // カード詳細ページへのリンク用配信者ID
  streamerId: string;
  // 未所持カードの画像/説明を隠すか（プレースホルダー表示）
  // Issue #395: when true, unowned cards render without image/description (rarity badge + "???" only).
  hideUnownedDetails?: boolean;
  // Translation strings - must be serializable (no functions)
  // 翻訳文字列 - シリアライズ可能である必要あり（関数不可）
  translations: {
    // Template for card count display, e.g., "x{count}"
    // カード枚数表示用テンプレート、例: "x{count}"
    cardCountTemplate: string;
    noImage: string;
    unownedCard: string;
    inactiveStatus: string;
    cardNumberTemplate: string;
    sortLabel: string;
    sortByNumber: string;
    sortByRarity: string;
  };
}

/**
 * CardGrid - カードを統一サイズのグリッドで表示するコンポーネント
 * 全カードが同一サイズで表示され、レアリティ順（サーバーサイドで事前ソート済み）を維持
 * CardGrid - Displays cards in a uniform-size grid, preserving rarity sort order (pre-sorted server-side)
 */
export default function SortedCardGrid({
  cards,
  streamerId,
  hideUnownedDetails = false,
  translations,
}: SortedCardGridProps) {
  const [sortMode, setSortMode] = useState<CollectionSortMode>("number");
  const sortedCards = useMemo(
    () => sortCollectedCards(cards, sortMode),
    [cards, sortMode]
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-400">{translations.sortLabel}</span>
        {([
          ["number", translations.sortByNumber],
          ["rarity", translations.sortByRarity],
        ] as const).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setSortMode(mode)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              sortMode === mode
                ? "bg-purple-600 text-white"
                : "border border-gray-600 text-gray-300 hover:bg-gray-700"
            }`}
            aria-pressed={sortMode === mode}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sortedCards.map((card, index) => {
          const isOwned = card.isOwned ?? true;
          const rarityInfo = getRarityInfo(card.rarity);
          // First 4 cards get priority for LCP optimization
          // 最初の4枚のカードはLCP最適化のためpriority設定
          const isPriority = index < 4;

          // 未所持カードの「詳細マスク」モード:
          //   show_unowned_card_details=false (=hideUnownedDetails=true) のときに有効。
          //   名前/画像/説明をプレースホルダーに置き換え、レアリティバッジのみ残す。
          //
          // 「詳細公開」モード (hideUnownedDetails=false) のときは未所持カードでも
          //   名前・画像・説明を本来のまま表示する。所持済カードとの違いはロック表示と
          //   グレースケール、所有数の非表示のみ。
          //
          // Issue #395 の要求:
          //   - 視聴者は所持していないカードを「⑤???」のような形で見られる (placeholder)
          //   - もしくは公開モードでは画像と説明まで含めて見られる
          const maskUnownedDetails = !isOwned && hideUnownedDetails;
          const displayName = maskUnownedDetails ? translations.unownedCard : card.name;
          const displayImageUrl = maskUnownedDetails ? null : card.image_url;
          const showDescription =
            (isOwned || !hideUnownedDetails) && Boolean(card.description);

          return (
            <CollectionCard
              key={card.id}
              id={card.id}
              streamerId={streamerId}
              name={displayName}
              imageUrl={displayImageUrl}
              mediaType={maskUnownedDetails ? null : card.media_type}
              rarityInfo={{
                label: rarityInfo.label,
                color: rarityInfo.color,
              }}
              collectionNumberLabel={
                card.collectionNumber
                  ? translations.cardNumberTemplate.replace("{number}", String(card.collectionNumber))
                  : undefined
              }
              count={isOwned ? card.count : undefined}
              countLabel={
                isOwned
                  ? translations.cardCountTemplate.replace("{count}", String(card.count))
                  : undefined
              }
              priority={isPriority}
              noImageText={
                maskUnownedDetails ? translations.unownedCard : translations.noImage
              }
              isOwned={isOwned}
              isInactive={isOwned && !card.is_active}
              inactiveLabel={translations.inactiveStatus}
              descriptionComponent={
                showDescription ? (
                  <ExpandableDescription description={card.description as string} />
                ) : undefined
              }
            />
          );
        })}
      </div>
    </>
  );
}
