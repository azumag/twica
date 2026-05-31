import Image from "next/image";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { isVideoCard } from "@/lib/card-media";

interface CardMediaProps {
  url: string;
  mediaType?: string | null;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
  imageVariant?: "icon" | "thumbnail";
  controls?: boolean;
}

export default function CardMedia({
  url,
  mediaType,
  alt,
  width,
  height,
  className,
  priority = false,
  imageVariant = "thumbnail",
  controls = false,
}: CardMediaProps) {
  if (isVideoCard(mediaType)) {
    // controls=false の場合（コレクション一覧やCardManagerサムネイル等）、
    // poster 未指定の <video> は黒画面のままになるため、ミュート autoplay + loop で
    // 1フレーム目以降をループ再生しサムネイルとして機能させる。
    // muted は autoplay のブラウザポリシー要件、playsInline は iOS 対策。
    // OBSオーバーレイ（controls=true 等の本表示）側では別途 video 要素を使うため
    // ここでは controls=false の thumbnail/icon 用途のみ自動再生を有効化する。
    // (PR #449 レビュー指摘: thumbnail/icon で動画が黒画面)
    const isThumbnail = !controls;
    return (
      <video
        src={url}
        className={className}
        controls={controls}
        muted={isThumbnail}
        autoPlay={isThumbnail}
        loop={isThumbnail}
        playsInline
        preload="metadata"
        aria-label={alt}
      />
    );
  }

  return (
    <Image
      src={getOptimizedImageUrl(url, imageVariant)}
      alt={alt}
      width={width}
      height={height}
      className={className}
      priority={priority}
      unoptimized
    />
  );
}
