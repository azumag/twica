import Image from "next/image";
import Link from "next/link";
import { getOptimizedImageUrl } from "@/lib/image-utils";

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
 * CollectionCard - カードを統一サイズで表示するコンポーネント
 * 全カードを同一サイズ（正方形 + object-cover）で表示し、グリッドの統一感を保つ
 * CollectionCard - Displays cards in uniform size (square + object-cover) for consistent grid layout
 */
export default function CollectionCard({
  id,
  streamerId,
  name,
  imageUrl,
  rarityInfo,
  count,
  countLabel,
  priority = false,
  noImageText,
  descriptionComponent,
}: CollectionCardProps) {
  // prefetch={false}: Disable automatic prefetching to prevent N+1 API calls
  // Each card link would trigger a server-side fetch of getUserCardDetail() on hover/viewport
  // With 50 cards, this causes 150+ database queries just from prefetching
  // prefetch={false}: 自動プリフェッチを無効化してN+1 API呼び出しを防止
  // 各カードリンクはホバー/ビューポート時にgetUserCardDetail()のサーバー側フェッチを発生させる
  // 50枚のカードがある場合、プリフェッチだけで150以上のDBクエリが発生する
  return (
    <Link
      href={`/collection/${streamerId}/card/${id}`}
      className="group relative overflow-hidden rounded-lg bg-gray-700 cursor-pointer transition-transform hover:scale-105"
      prefetch={false}
    >
      {/* Card name and rarity badge at the top */}
      {/* 名前とレアリティを一番上に配置 */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white truncate text-base">{name}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-white shrink-0 ml-2 text-xs ${rarityInfo.color}`}
          >
            {rarityInfo.label}
          </span>
        </div>
      </div>

      {/* Square image area with cropping - 全カード統一の正方形表示 */}
      {/* All cards use the same square aspect ratio with object-cover for consistency */}
      <div className="aspect-square bg-gray-600">
        {imageUrl ? (
          <Image
            src={getOptimizedImageUrl(imageUrl, "thumbnail")}
            alt={name}
            width={300}
            height={300}
            className="w-full h-full object-cover"
            priority={priority}
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            {noImageText}
          </div>
        )}
      </div>

      {/* Description and count at the bottom */}
      {/* 説明とカウント */}
      <div className="p-3 pt-2">
        {descriptionComponent}
        {(count ?? 0) > 1 && (
          <div className="text-gray-400 text-sm">
            {countLabel}
          </div>
        )}
      </div>
    </Link>
  );
}
