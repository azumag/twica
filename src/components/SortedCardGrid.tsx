"use client";

import { useState, useCallback, useMemo } from "react";
import CollectionCard from "./CollectionCard";
import ExpandableDescription from "./ExpandableDescription";
import type { Rarity, Streamer, Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";

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

/**
 * Image size info tracked for each card
 * 各カードの画像サイズ情報を追跡
 */
interface ImageSizeInfo {
  isSmall: boolean;
  isPortrait: boolean;
}

interface SortedCardGridProps {
  // Cards to display (already sorted by rarity)
  // 表示するカード（既にレアリティでソート済み）
  cards: CardWithDetails[];
  // Streamer ID for linking to card detail pages
  // カード詳細ページへのリンク用配信者ID
  streamerId: string;
  // Translation strings
  // 翻訳文字列
  translations: {
    cardCount: (count: number) => string;
    noImage: string;
  };
}

/**
 * SortedCardGrid - Client component that displays cards with automatic sorting
 * by image size (small images are moved to the end)
 * 画像サイズで自動ソートしてカードを表示するクライアントコンポーネント
 * （小さい画像は末尾に移動）
 *
 * The component tracks image dimensions as they load and re-sorts the cards
 * to group small images together at the bottom of the grid.
 * 画像の読み込み時にサイズを追跡し、小さい画像をグリッドの下部に
 * まとめるようにカードを再ソートします。
 */
export default function SortedCardGrid({
  cards,
  streamerId,
  translations,
}: SortedCardGridProps) {
  // Track image size info for each card as images load
  // 画像の読み込み時に各カードの画像サイズ情報を追跡
  const [imageSizeMap, setImageSizeMap] = useState<Map<string, ImageSizeInfo>>(new Map());

  /**
   * Callback for when a card's image size is detected
   * カードの画像サイズが検出されたときのコールバック
   */
  const handleImageSizeDetected = useCallback((cardId: string, isSmall: boolean, isPortrait: boolean) => {
    setImageSizeMap(prev => {
      const newMap = new Map(prev);
      newMap.set(cardId, { isSmall, isPortrait });
      return newMap;
    });
  }, []);

  /**
   * Sort cards with small images at the end
   * 小さい画像を持つカードを末尾にソート
   *
   * Cards are first sorted by rarity (already done server-side),
   * then small images are moved to the end while preserving
   * the relative rarity order within each group.
   * カードはまずレアリティでソートされ（サーバーサイドで完了）、
   * 次に小さい画像が末尾に移動されますが、各グループ内の
   * 相対的なレアリティ順序は保持されます。
   */
  const sortedCards = useMemo(() => {
    // If no size info yet, return original order
    // サイズ情報がまだない場合は元の順序を返す
    if (imageSizeMap.size === 0) {
      return cards;
    }

    // Separate cards into regular and small image groups
    // カードを通常と小さい画像のグループに分離
    const regularCards: CardWithDetails[] = [];
    const smallCards: CardWithDetails[] = [];

    for (const card of cards) {
      const sizeInfo = imageSizeMap.get(card.id);
      // Cards without size info or with regular-sized images go first
      // サイズ情報がないカードまたは通常サイズの画像のカードを先に
      if (!sizeInfo || !sizeInfo.isSmall) {
        regularCards.push(card);
      } else {
        smallCards.push(card);
      }
    }

    // Combine: regular cards first, then small image cards
    // 結合: 通常カードを先に、次に小さい画像のカード
    return [...regularCards, ...smallCards];
  }, [cards, imageSizeMap]);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-start">
      {sortedCards.map((card, index) => {
        const rarityInfo = getRarityInfo(card.rarity);
        // First 4 cards get priority for LCP optimization
        // 最初の4枚のカードはLCP最適化のためpriority設定
        const isPriority = index < 4;
        return (
          <CollectionCard
            key={card.id}
            id={card.id}
            streamerId={streamerId}
            name={card.name}
            imageUrl={card.image_url}
            description={card.description}
            rarity={card.rarity}
            rarityInfo={{
              label: rarityInfo.label,
              color: rarityInfo.color,
            }}
            count={card.count}
            countLabel={translations.cardCount(card.count)}
            priority={isPriority}
            noImageText={translations.noImage}
            descriptionComponent={
              card.description ? (
                <ExpandableDescription description={card.description} />
              ) : undefined
            }
            onImageSizeDetected={handleImageSizeDetected}
          />
        );
      })}
    </div>
  );
}
