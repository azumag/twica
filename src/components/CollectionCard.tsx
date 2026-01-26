"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import type { Rarity } from "@/types/database";

/**
 * Props for the CollectionCard component
 * CollectionCardコンポーネントのプロパティ
 */
interface CollectionCardProps {
  // Card unique identifier
  // カードの一意識別子
  id: string;
  // Streamer ID for linking to card detail page
  // カード詳細ページへのリンク用配信者ID
  streamerId: string;
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
  // Callback to report image size info to parent component for sorting
  // 親コンポーネントにソート用の画像サイズ情報を報告するコールバック
  onImageSizeDetected?: (cardId: string, isSmall: boolean, isPortrait: boolean) => void;
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
  streamerId,
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
  onImageSizeDetected,
}: CollectionCardProps) {
  // Track if the image is small (< 400px in either dimension)
  // 画像が小さい（幅または高さ400px未満）かどうかを追跡
  const [isSmallImage, setIsSmallImage] = useState(false);
  // Track if the image is portrait (height > width)
  // 画像が縦長（高さ > 幅）かどうかを追跡
  const [isPortrait, setIsPortrait] = useState(false);
  // Track if image size has been determined
  // 画像サイズが判定済みかどうかを追跡
  const [sizeChecked, setSizeChecked] = useState(false);

  /**
   * Check image dimensions on load to determine display mode
   * 画像ロード時にサイズを確認し、表示モードを判定
   *
   * Small images (< 400px) are displayed in compact card format.
   * Portrait images (height > width) are displayed without frame.
   * 小さい画像（400px未満）はコンパクトカード形式で表示。
   * 縦長画像（高さ > 幅）は枠なしで表示。
   */
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    // Check if image is smaller than 400px in either dimension
    // 画像の幅または高さが400px未満かどうかを確認
    const isSmall = img.naturalWidth < 400 || img.naturalHeight < 400;
    // Check if image is portrait (height > width)
    // 画像が縦長（高さ > 幅）かどうかを確認
    const portrait = img.naturalHeight > img.naturalWidth;
    setIsSmallImage(isSmall);
    setIsPortrait(portrait);
    setSizeChecked(true);
    // Report to parent for sorting purposes
    // ソート用に親コンポーネントに報告
    onImageSizeDetected?.(id, isSmall, portrait);
  }, [id, onImageSizeDetected]);

  // Handle image load error - mark size as checked to prevent infinite loading state
  // 画像読み込みエラー時 - 無限ローディング状態を防ぐためサイズチェック済みとしてマーク
  const handleImageError = useCallback(() => {
    setSizeChecked(true);
  }, []);

  // Determine if portrait mode should be used (no frame display)
  // ポートレートモード（枠なし表示）を使用するかどうかを決定
  const usePortraitMode = isPortrait && sizeChecked;

  // Determine card size classes based on image size
  // 画像サイズに基づいてカードサイズのクラスを決定
  // Small cards use reduced dimensions to better display small images like emotes
  // 小さいカードはエモートなどの小さい画像をより良く表示するために縮小されたサイズを使用
  // h-fit: カードの高さをコンテンツに合わせる（グリッド内で縦も小さくなる）
  // self-start: グリッドセル内で上揃えにする
  // Portrait images: displayed without frame (no background, just the image)
  // 縦長画像: 枠なし表示（背景なし、画像のみ）
  const getCardClasses = () => {
    if (usePortraitMode) {
      // Portrait mode: no background, just rounded corners on image
      // ポートレートモード: 背景なし、画像に角丸のみ
      return "group relative overflow-hidden h-fit self-start cursor-pointer transition-transform hover:scale-105";
    }
    if (isSmallImage && sizeChecked) {
      return "group relative overflow-hidden rounded-lg bg-gray-700 max-w-[160px] h-fit self-start mx-auto cursor-pointer transition-transform hover:scale-105";
    }
    return "group relative overflow-hidden rounded-lg bg-gray-700 cursor-pointer transition-transform hover:scale-105";
  };

  // Image container classes - smaller for small images
  // 画像コンテナのクラス - 小さい画像用には小さく
  // Portrait: no aspect ratio constraint, let image display naturally
  // ポートレート: アスペクト比制約なし、画像を自然に表示
  const getImageContainerClasses = () => {
    if (usePortraitMode) {
      return "bg-transparent";
    }
    if (isSmallImage && sizeChecked) {
      return "aspect-square bg-gray-600 w-full";
    }
    return "aspect-square bg-gray-600";
  };

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

  // Card content - wrapped in Link for navigation to detail page
  // カードコンテンツ - 詳細ページへのナビゲーション用にLinkでラップ
  const cardContent = (
    <>
      {/* Portrait mode: show image only without frame */}
      {/* ポートレートモード: 枠なしで画像のみ表示 */}
      {usePortraitMode ? (
        <div className={getImageContainerClasses()}>
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={name}
              width={300}
              height={420}
              className="w-full h-auto rounded-lg object-contain"
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
      ) : (
        <>
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
          <div className={getImageContainerClasses()}>
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
        </>
      )}
    </>
  );

  // prefetch={false}: Disable automatic prefetching to prevent N+1 API calls
  // Each card link would trigger a server-side fetch of getUserCardDetail() on hover/viewport
  // With 50 cards, this causes 150+ database queries just from prefetching
  // prefetch={false}: 自動プリフェッチを無効化してN+1 API呼び出しを防止
  // 各カードリンクはホバー/ビューポート時にgetUserCardDetail()のサーバー側フェッチを発生させる
  // 50枚のカードがある場合、プリフェッチだけで150以上のDBクエリが発生する
  return (
    <Link
      href={`/collection/${streamerId}/card/${id}`}
      className={getCardClasses()}
      prefetch={false}
    >
      {cardContent}
    </Link>
  );
}
