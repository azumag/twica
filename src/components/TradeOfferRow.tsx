"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import type { TradeOfferDto } from "@/lib/trade";

function formatListedAt(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  try {
    const rtf = new Intl.RelativeTimeFormat(locale === "ja" ? "ja" : "en", {
      numeric: "auto",
    });
    if (diffSeconds < 60) return rtf.format(-diffSeconds, "second");
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return rtf.format(-diffMinutes, "minute");
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return rtf.format(-diffHours, "hour");
    return rtf.format(-Math.floor(diffHours / 24), "day");
  } catch {
    return new Date(time).toLocaleString();
  }
}

function CardThumb({
  name,
  rarity,
  imageUrl,
}: {
  name: string;
  rarity: string;
  imageUrl: string | null;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 text-center">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={name} className="h-20 w-20 rounded-lg object-cover" />
      ) : (
        <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-gray-700 p-1 text-xs text-gray-400">
          {name}
        </div>
      )}
      <p className="text-sm font-semibold text-white">{name}</p>
      <p className="text-xs text-gray-400">{rarity}</p>
    </div>
  );
}

/**
 * トレードボードのオファー行 (#726, §6.3)。
 * 応諾者視点: もらえるカード (offered) = 左/上、渡すカード (wanted) = 右/下。
 * モバイルは縦積み、sm 以上で横並び。
 */
export default function TradeOfferRow({
  offer,
  streamerId,
  showStreamerBadges,
  onAccept,
  onCancelled,
  onListError,
}: {
  offer: TradeOfferDto;
  streamerId: string;
  showStreamerBadges: boolean;
  onAccept: (offer: TradeOfferDto) => void;
  onCancelled: () => void;
  onListError: (messageKey: string) => void;
}) {
  const t = useTranslations("trade");
  const locale = useLocale();
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // 応諾ボタン4状態 (§11.3 状態遷移表)。未ログイン時は canAccept が省略される。
  const renderAcceptArea = () => {
    if (offer.isOwnOffer) {
      return (
        <div className="flex flex-col items-stretch gap-2">
          <span className="rounded-full bg-gray-700 px-3 py-1 text-center text-xs font-semibold text-gray-300">
            {t("ownOfferBadge")}
          </span>
          {confirmingCancel ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-gray-300">{t("cancelConfirmText")}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={async () => {
                    setCancelling(true);
                    try {
                      const response = await fetch(`/api/trades/${offer.id}/cancel`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({}),
                      });
                      if (!response.ok) {
                        onListError(response.status === 429 ? "errorRateLimited" : "errorGeneric");
                        return;
                      }
                      onCancelled();
                    } catch {
                      onListError("errorGeneric");
                    } finally {
                      setCancelling(false);
                      setConfirmingCancel(false);
                    }
                  }}
                  className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  {t("cancelConfirmYes")}
                </button>
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => setConfirmingCancel(false)}
                  className="flex-1 rounded-lg bg-gray-700 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-600 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                >
                  {t("cancelConfirmNo")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingCancel(true)}
              className="rounded-lg bg-gray-700 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {t("cancelOfferButton")}
            </button>
          )}
        </div>
      );
    }
    switch (offer.canAccept) {
      case "yes":
        return (
          <button
            type="button"
            onClick={() => onAccept(offer)}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("acceptButton")}
          </button>
        );
      case "not_owned":
        return (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="cursor-not-allowed rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold text-gray-400"
          >
            {t("acceptButtonNotOwned")}
          </button>
        );
      case "all_listed":
        return (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="cursor-not-allowed rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold text-gray-400"
          >
            {t("acceptButtonAllListed")}
          </button>
        );
      default: {
        // 未ログイン (canAccept 省略): returnTo パターンでログインへ誘導する
        const returnTo = encodeURIComponent(`/trade/${streamerId}`);
        return (
          <a
            href={`/api/auth/twitch/login?redirect=true&returnTo=${returnTo}`}
            className="rounded-lg bg-purple-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("acceptButtonLoginRequired")}
          </a>
        );
      }
    }
  };

  return (
    <li className="rounded-xl bg-gray-800 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <CardThumb
          name={offer.offeredCard.name}
          rarity={offer.offeredCard.rarity}
          imageUrl={offer.offeredCard.imageUrl}
        />
        <span
          role="img"
          aria-label={t("directionIconLabel")}
          className="self-center text-xl text-gray-300"
        >
          ⇄
        </span>
        <CardThumb
          name={offer.wantedCard.name}
          rarity={offer.wantedCard.rarity}
          imageUrl={offer.wantedCard.imageUrl}
        />
      </div>
      {showStreamerBadges && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-400">
          {offer.offeredStreamer && (
            <span className="inline-flex items-center gap-1">
              {offer.offeredStreamer.twitchProfileImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={offer.offeredStreamer.twitchProfileImageUrl}
                  alt=""
                  className="h-4 w-4 rounded-full"
                />
              )}
              {offer.offeredStreamer.twitchDisplayName} ⇄
            </span>
          )}
          {offer.wantedStreamer && (
            <span className="inline-flex items-center gap-1">
              {offer.wantedStreamer.twitchProfileImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={offer.wantedStreamer.twitchProfileImageUrl}
                  alt=""
                  className="h-4 w-4 rounded-full"
                />
              )}
              {offer.wantedStreamer.twitchDisplayName}
            </span>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-400">
          {t("offeredByLabel")}: {offer.offerer?.twitchDisplayName ?? "-"} {t("metaSeparator")}{" "}
          {formatListedAt(offer.createdAt, locale)}
        </p>
        <div className="flex flex-col gap-1">
          {renderAcceptArea()}
          {!offer.isOwnOffer && (
            <p className="text-xs text-gray-500">{t("autoSelectNotice")}</p>
          )}
        </div>
      </div>
    </li>
  );
}
