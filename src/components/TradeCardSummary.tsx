"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { formatRarityLabel, getRarityColorClass } from "@/lib/rarity";
import { TRADE_CARD_LABEL_MESSAGE_KEYS, useTradeCardLabel } from "@/lib/trade-card-label";

/** Card display data shared by board rows, the accept dialog and /trade/mine. */
export type TradeCardDisplay = {
  name: string;
  rarity: string;
  imageUrl: string | null;
  /**
   * 閲覧者に依存しない表示番号（Issue #2070 フォローアップ）。
   * 名前が非公開（name が ""）のときに「#N」を出すために使う。null は削除済み・
   * 不明。所持カードなど番号を持たない呼び出し元は省略できる。
   */
  collectionNumber?: number | null;
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
  /**
   * Copies exchanged on this side (#1789). Only the wanted side of an offer
   * can be > 1; a "×N" badge is shown then, so a multi-copy offer is never
   * mistaken for a 1:1 trade.
   */
  quantity?: number;
}

/**
 * Compact card tile for the trade UI.
 *
 * Deliberately simpler than CollectionCard (no detail link / number / owned
 * count): trade rows only need "which card, which rarity, which channel".
 * Images go through the same Cloudflare Images preset as the collection grid.
 *
 * カード名の表示（#2070 フォローアップ / C4a）:
 * トレード・オークションの全画面（ボード、応諾/キャンセル確認、/trade(/mine)、
 * 出品フォーム、入札フォーム、入札一覧）はカード名をこのコンポーネント経由で
 * 表示する。そのため「名前 → #N → 削除されたカード」の共通規則は
 * useTradeCardLabel() に一本化してあり、ここで個別に `name || ...` を書かない。
 * 名前を文（「〜と交換」など）へ埋め込む箇所だけが同フックを直接呼ぶ。
 */
export default function TradeCardSummary({
  card,
  deleted = false,
  label,
  streamer,
  size = "sm",
  quantity = 1,
}: TradeCardSummaryProps) {
  const t = useTranslations("trade");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");
  const cardLabel = useTradeCardLabel();
  const imageSize = size === "lg" ? "h-40 w-40" : "h-20 w-20";
  // 名前が非公開でも #N、番号も無ければ「削除されたカード」を出す。
  // 空文字をそのまま描画して名前欄が空白になる旧挙動をここで止める。
  const name = cardLabel(card);
  // 表示名がすでに「削除されたカード」の場合は、下の「削除済みカード」バッジを
  // 重ねない（同じ意味の文言が2つ並ぶのを避ける）。名前スナップショットが残って
  // いる削除カード（Retired Hero + バッジ）は従来どおりバッジを出し、
  // 「名前は分かるが定義は削除済み」を区別できるようにする。
  const showsDeletedBadge =
    deleted && name !== t(TRADE_CARD_LABEL_MESSAGE_KEYS.deletedName);

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
          {quantity > 1 && (
            <span className="rounded bg-purple-600 px-1.5 py-0.5 text-xs font-semibold text-white">
              {t("quantityBadge", { count: quantity })}
            </span>
          )}
          {card.rarity && (
            <span
              className={`rounded px-1.5 py-0.5 text-xs text-white ${getRarityColorClass(card.rarity)}`}
            >
              {formatRarityLabel(card.rarity, tRarity)}
            </span>
          )}
          {showsDeletedBadge && (
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
