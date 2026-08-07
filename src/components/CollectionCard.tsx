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
  // Stable collection number for encyclopedia-style display
  // 図鑑表示用の固定カード番号
  collectionNumberLabel?: string;
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
  // Whether this card is owned by the current user (default: true for backward compatibility)
  // このカードを現在ユーザーが所持しているか（後方互換のためデフォルトtrue）
  isOwned?: boolean;
  // Whether the card is no longer distributed
  // このカードが現在配布停止中かどうか
  isInactive?: boolean;
  // Label to show when the card is inactive
  // 配布停止中カードに表示するラベル
  inactiveLabel?: string;
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
  collectionNumberLabel,
  count,
  countLabel,
  priority = false,
  noImageText,
  isOwned = true,
  isInactive = false,
  inactiveLabel,
  descriptionComponent,
}: CollectionCardProps) {
  const cardClassName = `group relative overflow-hidden rounded-lg bg-gray-700 transition-transform ${
    isOwned ? "cursor-pointer hover:scale-105" : "cursor-default"
  } ${isInactive ? "ring-1 ring-amber-400/30" : ""}`;

  const cardContent = (
    <>
      {/* Card name and rarity badge at the top */}
      {/* 名前とレアリティを一番上に配置 */}
      <div className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {collectionNumberLabel && (
              <div className="mb-1 text-xs font-semibold text-purple-300">
                {collectionNumberLabel}
              </div>
            )}
            <h3 className={`font-semibold truncate text-base ${isOwned ? "text-white" : "text-white/70"}`}>
              {name}
            </h3>
            {isInactive && inactiveLabel && (
              <span className="mt-1 inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
                {inactiveLabel}
              </span>
            )}
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-white shrink-0 ml-2 text-xs ${rarityInfo.color}`}
          >
            {rarityInfo.label}
          </span>
        </div>
      </div>

      {!isOwned && (
        <div
          role="img"
          aria-label="Unowned card"
          className="absolute right-2 top-2 rounded-full bg-black/60 p-1"
        >
          <svg
            className="h-3.5 w-3.5 text-white"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 10V7a4 4 0 1 1 8 0v3m-9 0h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      {/* Square image area with cropping - 全カード統一の正方形表示 */}
      {/* All cards use the same square aspect ratio with object-cover for consistency */}
      <div className="aspect-square bg-gray-600">
        {imageUrl ? (
          <Image
            src={getOptimizedImageUrl(imageUrl, "thumbnail")}
            alt={name}
            width={300}
            height={300}
            className={`w-full h-full object-cover ${isOwned ? "" : "grayscale opacity-50"} ${isInactive ? "opacity-80 saturate-75" : ""}`}
            priority={priority}
            unoptimized
          />
        ) : (
          <div
            className={`flex h-full items-center justify-center ${
              isOwned ? "text-gray-500" : "text-gray-500/70"
            }`}
          >
            {noImageText}
          </div>
        )}
      </div>

    </>
  );

  const cardDetailHref = `/collection/${streamerId}/card/${id}`;

  // 説明の開閉buttonをカード詳細Linkの外へ置くため、フッターはLinkの兄弟として描画する。
  // Keep the footer outside the card Link so its disclosure button is never nested in an anchor.
  const hasCount = isOwned && (count ?? 0) > 1;
  const hasCardFooter =
    (descriptionComponent !== undefined && descriptionComponent !== null) ||
    hasCount;

  const cardFooter = hasCardFooter ? (
    <div className="p-3 pt-2">
      {descriptionComponent}
      {hasCount && (
        <Link
          href={cardDetailHref}
          className="text-gray-400 text-sm"
          prefetch={false}
        >
          {countLabel}
        </Link>
      )}
    </div>
  ) : null;

  // prefetch={false}: Disable automatic prefetching to prevent N+1 API calls
  // Each card link would trigger a server-side fetch of getUserCardDetail() on hover/viewport
  // With 50 cards, this causes 150+ database queries just from prefetching
  // prefetch={false}: 自動プリフェッチを無効化してN+1 API呼び出しを防止
  // 各カードリンクはホバー/ビューポート時にgetUserCardDetail()のサーバー側フェッチを発生させる
  // 50枚のカードがある場合、プリフェッチだけで150以上のDBクエリが発生する
  return isOwned ? (
    <div className={cardClassName}>
      <Link
        href={cardDetailHref}
        className="block"
        prefetch={false}
      >
        {cardContent}
      </Link>
      {cardFooter}
    </div>
  ) : (
    <div className={cardClassName}>
      {cardContent}
      {cardFooter}
    </div>
  );
}
