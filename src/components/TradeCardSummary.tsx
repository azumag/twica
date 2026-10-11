"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { formatRarityLabel, getRarityColorClass } from "@/lib/rarity";

/** Card display data shared by board rows, the accept dialog and /trade/mine. */
export type TradeCardDisplay = {
  name: string;
  rarity: string;
  imageUrl: string | null;
};

/** Channel shown next to a card on the cross-channel tab (§6.3). */
export type TradeCardStreamer = {
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
};

interface TradeCardSummaryProps {
  card: TradeCardDisplay;
  /**
   * The card definition was deleted (trade row's *_card_id is NULL). The
   * snapshot taken at listing time is still shown, labelled as deleted (§6.6).
   */
  deleted?: boolean;
  /** Visible direction label ("もらう"/"渡す"); never conveyed by colour alone (§6.8). */
  label?: string;
  streamer?: TradeCardStreamer | null;
  size?: "sm" | "lg";
}

/**
 * Compact card tile for the trade UI.
 *
 * Deliberately simpler than CollectionCard (no detail link / number / owned
 * count): trade rows only need "which card, which rarity, which channel".
 * Images go through the same Cloudflare Images preset as the collection grid.
 */
export default function TradeCardSummary({
  card,
  deleted = false,
  label,
  streamer,
  size = "sm",
}: TradeCardSummaryProps) {
  const t = useTranslations("trade");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");
  const imageSize = size === "lg" ? "h-40 w-40" : "h-20 w-20";
  // A snapshot can be empty for legacy/broken rows; never render a blank name.
  const name = card.name || t("deletedCardLabel");

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={`${imageSize} relative shrink-0 overflow-hidden rounded-lg bg-gray-700`}
      >
        {card.imageUrl ? (
          // unoptimized: Cloudflare Images preset is applied by getOptimizedImageUrl
          // (same as CollectionCard), so Next's optimizer is skipped.
          <Image
            src={getOptimizedImageUrl(card.imageUrl, size === "lg" ? "large" : "thumbnail")}
            alt={name}
            fill
            sizes={size === "lg" ? "160px" : "80px"}
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
            {tCommon("noImage")}
          </div>
        )}
      </div>
      <div className="min-w-0 text-sm">
        {label && <p className="text-xs font-semibold text-gray-400">{label}</p>}
        <p className="break-words font-semibold text-white">{name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {card.rarity && (
            <span
              className={`rounded px-1.5 py-0.5 text-xs text-white ${getRarityColorClass(card.rarity)}`}
            >
              {formatRarityLabel(card.rarity, tRarity)}
            </span>
          )}
          {deleted && (
            <span className="rounded bg-gray-600 px-1.5 py-0.5 text-xs text-gray-200">
              {t("deletedCardLabel")}
            </span>
          )}
        </div>
        {streamer && (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-gray-400">
            {streamer.twitchProfileImageUrl && (
              // unoptimized: Twitch CDN image (same as Header/Collection).
              <Image
                src={streamer.twitchProfileImageUrl}
                alt=""
                width={16}
                height={16}
                className="h-4 w-4 rounded-full"
                unoptimized
              />
            )}
            <span className="truncate">
              {t("cardStreamerLabel", { name: streamer.twitchDisplayName })}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
