"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import type { Rarity } from "@/types/database";

/**
 * Props for the CollectionCard component
 * CollectionCardコンポーネントのプロパティ
 */
interface CollectionCardProps {
  // Card unique identifier
  // カードの一意識別子
  id: string;
  // Card name to display
  // 表示するカード名
  name: string;
  // Card image URL (optional)
  // カード画像URL（任意）
  imageUrl: string | null;
  // Card description (optional)
  // カード説明（任意）
  description?: string | null;
  // Card rarity for badge styling
  // バッジスタイリング用のカードレアリティ
  rarity: Rarity;
  // Rarity display info (label and color class)
  // レアリティ表示情報（ラベルとカラークラス）
  rarityInfo: {
    label: string;
    color: string;
  };
  // Number of copies the user owns (optional, shown if > 1)
  // ユーザーが所有する枚数（任意、1より大きい場合に表示）
  count?: number;
  // Text to show for card count
  // カード枚数表示用のテキスト
  countLabel?: string;
  // Whether to prioritize image loading (for LCP optimization)
  // 画像読み込みを優先するかどうか（LCP最適化用）
  priority?: boolean;
  // Text to show when no image is available
  // 画像がない場合に表示するテキスト
  noImageText: string;
  // Description component to render (passed to avoid client-side i18n issues)
  // 描画する説明コンポーネント（クライアントサイドのi18n問題を避けるため渡す）
  descriptionComponent?: React.ReactNode;
}

/**
 * CollectionCard - Client component that displays a card with automatic size detection
 * 画像サイズを自動検出してカードを表示するクライアントコンポーネント
 *
 * Small images (width or height < 400px) are displayed in a compact card style
 * to better match their original size and improve the visual presentation.
 * 小さい画像（幅または高さ400px未満）はコンパクトなカードスタイルで表示され、
 * 元のサイズに合わせてより良い視覚的表現を実現します。
 */
export default function CollectionCard({
  id,
  name,
  imageUrl,
  description,
  rarity,
  rarityInfo,
  count,
  countLabel,
  priority = false,
  noImageText,
  descriptionComponent,
}: CollectionCardProps) {
  // Track if the image is small (< 400px in either dimension)
  // 画像が小さい（幅または高さ400px未満）かどうかを追跡
  const [isSmallImage, setIsSmallImage] = useState(false);
  // Track if image size has been determined
  // 画像サイズが判定済みかどうかを追跡
  const [sizeChecked, setSizeChecked] = useState(false);

  /**
   * Check image dimensions on load to determine if small card mode should be used
   * 画像ロード時にサイズを確認し、小さいカードモードを使用するか判定
   *
   * Images smaller than 400x400 pixels (e.g., Twitch emotes at 112x112)
   * are displayed in a more compact card format to avoid excessive scaling
   * and maintain visual quality.
   * 400x400ピクセル未満の画像（例：112x112のTwitchエモート）は
   * 過度なスケーリングを避け、視覚的品質を維持するために
   * よりコンパクトなカード形式で表示されます。
   */
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    // Check if image is smaller than 400px in either dimension
    // 画像の幅または高さが400px未満かどうかを確認
    const isSmall = img.naturalWidth < 400 || img.naturalHeight < 400;
    setIsSmallImage(isSmall);
    setSizeChecked(true);
  }, []);

  // Handle image load error - mark size as checked to prevent infinite loading state
  // 画像読み込みエラー時 - 無限ローディング状態を防ぐためサイズチェック済みとしてマーク
  const handleImageError = useCallback(() => {
    setSizeChecked(true);
  }, []);

  // Determine card size classes based on image size
  // 画像サイズに基づいてカードサイズのクラスを決定
  // Small cards use reduced dimensions to better display small images like emotes
  // 小さいカードはエモートなどの小さい画像をより良く表示するために縮小されたサイズを使用
  const cardClasses = isSmallImage && sizeChecked
    ? "group relative overflow-hidden rounded-lg bg-gray-700 max-w-[160px] mx-auto"
    : "group relative overflow-hidden rounded-lg bg-gray-700";

  // Image container classes - smaller for small images
  // 画像コンテナのクラス - 小さい画像用には小さく
  const imageContainerClasses = isSmallImage && sizeChecked
    ? "aspect-square bg-gray-600 w-full"
    : "aspect-square bg-gray-600";

  // Image display size - smaller for small images to maintain quality
  // 画像表示サイズ - 品質を維持するため小さい画像には小さく
  const imageWidth = isSmallImage && sizeChecked ? 160 : 300;
  const imageHeight = isSmallImage && sizeChecked ? 160 : 300;

  // Text size classes - smaller for compact cards
  // テキストサイズクラス - コンパクトカード用には小さく
  const nameSizeClass = isSmallImage && sizeChecked ? "text-sm" : "text-base";
  const raritySizeClass = isSmallImage && sizeChecked ? "text-[10px]" : "text-xs";
  const paddingClass = isSmallImage && sizeChecked ? "p-2 pb-1" : "p-3 pb-2";
  const bottomPaddingClass = isSmallImage && sizeChecked ? "p-2 pt-1" : "p-3 pt-2";

  return (
    <div key={id} className={cardClasses}>
      {/* Card name and rarity badge at the top */}
      {/* 名前とレアリティを一番上に配置 */}
      <div className={paddingClass}>
        <div className="flex items-center justify-between">
          <h3 className={`font-semibold text-white truncate ${nameSizeClass}`}>{name}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-white shrink-0 ml-2 ${raritySizeClass} ${rarityInfo.color}`}
          >
            {rarityInfo.label}
          </span>
        </div>
      </div>

      {/* Square image area with cropping */}
      {/* 正方形画像（トリミング） */}
      <div className={imageContainerClasses}>
        {imageUrl ? (
          // unoptimized: Images are already optimized during upload
          // Skip Vercel Image Transformations to reduce costs
          // unoptimized: アップロード時に既に最適化済み
          // Vercel Image Transformations をスキップしてコスト削減
          <Image
            src={imageUrl}
            alt={name}
            width={imageWidth}
            height={imageHeight}
            className="w-full h-full object-cover"
            priority={priority}
            unoptimized
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            {noImageText}
          </div>
        )}
      </div>

      {/* Description and count at the bottom */}
      {/* 説明とカウント */}
      <div className={bottomPaddingClass}>
        {descriptionComponent}
        {count && count > 1 && (
          <div className={`text-gray-400 ${isSmallImage && sizeChecked ? "text-xs" : "text-sm"}`}>
            {countLabel}
          </div>
        )}
      </div>
    </div>
  );
}
