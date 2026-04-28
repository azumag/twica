import CollectionCard from "./CollectionCard";
import ExpandableDescription from "./ExpandableDescription";
import type { Rarity, Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) =>
  RARITIES.find((r) => r.value === rarity) || RARITIES[0];

interface CardWithDetails extends Card {
  count: number;
  isOwned?: boolean;
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
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((card, index) => {
        const isOwned = card.isOwned ?? true;
        const rarityInfo = getRarityInfo(card.rarity);
        // First 4 cards get priority for LCP optimization
        // 最初の4枚のカードはLCP最適化のためpriority設定
        const isPriority = index < 4;
        // 未所持カードで「詳細を隠す」設定の場合は image_url を null に伏せる。
        // これにより画像領域は noImageText (例: "未所持") のみ表示される。
        // When hiding unowned details, mask image_url so the image slot only renders the placeholder text.
        const shouldMaskImage = !isOwned && hideUnownedDetails;
        const effectiveImageUrl = shouldMaskImage ? null : card.image_url;
        return (
          <CollectionCard
            key={card.id}
            id={card.id}
            streamerId={streamerId}
            name={isOwned ? card.name : translations.unownedCard}
            imageUrl={effectiveImageUrl}
            rarityInfo={{
              label: rarityInfo.label,
              color: rarityInfo.color,
            }}
            count={isOwned ? card.count : undefined}
            countLabel={
              isOwned
                ? translations.cardCountTemplate.replace("{count}", String(card.count))
                : undefined
            }
            priority={isPriority}
            noImageText={
              shouldMaskImage ? translations.unownedCard : translations.noImage
            }
            isOwned={isOwned}
            isInactive={isOwned && !card.is_active}
            inactiveLabel={translations.inactiveStatus}
            descriptionComponent={
              isOwned && card.description ? (
                <ExpandableDescription description={card.description} />
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
