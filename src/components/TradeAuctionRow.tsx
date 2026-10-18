"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import { auctionBidStateLabelKey } from "@/lib/trade-client";
import TradeCardSummary from "./TradeCardSummary";
import { TradeAuctionPhaseBadge } from "./TradeAuctionStatus";

interface TradeAuctionRowProps {
  auction: TradeAuctionDto;
  /** Cross-channel tab: show the auction's channel next to the card. */
  showStreamer: boolean;
  /** Detail page URL (bids are placed there). */
  detailHref: string;
}

const LINK_CLASS =
  "w-full rounded-lg bg-purple-600 px-4 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 sm:w-auto";

/**
 * One auction on the board's auction tab (design §6): the listed card, the
 * time left while bidding or "waiting for selection", the number of active
 * bids, and the viewer's own relation to it (own auction / own bid and its
 * state). Bid contents of OTHER bidders are never part of the board DTO
 * (spec: only the count is public), so nothing else can be shown here.
 *
 * Every action (bid, change, withdraw, settle, cancel) lives on the detail
 * page, so the row has one link instead of per-state buttons.
 */
export default function TradeAuctionRow({ auction, showStreamer, detailHref }: TradeAuctionRowProps) {
  const t = useTranslations("trade");
  const myBid = auction.myBid ?? null;

  const linkLabel = auction.isOwnAuction
    ? t("auctionRowManageLink")
    : myBid
      ? t("auctionRowMyBidLink")
      : t("auctionRowDetailLink");

  return (
    <li className="rounded-xl bg-gray-800 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <TradeCardSummary
            card={auction.offeredCard}
            deleted={auction.offeredCardId === null}
            label={t("auctionOfferedCardLabel")}
            streamer={showStreamer ? auction.offeredStreamer : null}
          />
        </div>
        <div className="flex flex-col items-start gap-2 text-sm sm:items-end">
          <TradeAuctionPhaseBadge auction={auction} />
          <span className="text-gray-300">{t("auctionBidCount", { count: auction.bidCount })}</span>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-3 border-t border-gray-700 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1 text-xs text-gray-400">
          <span>{t("offeredByLabel", { name: auction.seller?.twitchDisplayName ?? t("unknownUser") })}</span>
          {auction.isOwnAuction && (
            <span className="w-fit rounded border border-purple-500 px-2 py-0.5 text-purple-200">
              {t("auctionOwnBadge")}
            </span>
          )}
          {myBid && (
            <span className="break-words text-gray-200">
              {t("auctionRowMyBid", {
                card: myBid.bidCard.name || t("deletedCardLabel"),
                count: myBid.quantity,
                state: t(auctionBidStateLabelKey(myBid.state, auction.phase)),
              })}
            </span>
          )}
          {myBid && myBid.state === "active" && auction.phase === "selecting" && !myBid.settleable && (
            // The seller cannot pick this bid any more, and the bidder may
            // withdraw it (spec); say so on the board, not only in the detail.
            <span className="w-fit rounded bg-yellow-700 px-2 py-0.5 text-yellow-50">
              {t("auctionBidUnsettleableBadge")}
            </span>
          )}
        </div>
        <Link href={detailHref} className={LINK_CLASS}>
          {linkLabel}
        </Link>
      </div>
    </li>
  );
}
