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
    return (
      <video
        src={url}
        className={className}
        controls={controls}
        muted={!controls}
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
