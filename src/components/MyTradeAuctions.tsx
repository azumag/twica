"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { TradeAuctionDto, TradeAuctionMineRole } from "@/lib/trade-auction";
import {
  auctionBidStateLabelKey,
  formatTradeDateTime,
  tradeAuctionDetailPath,
} from "@/lib/trade-client";
import { useTradeList } from "@/lib/use-trade-list";
import TradeCardSummary from "./TradeCardSummary";
import { TradeAuctionPhaseBadge } from "./TradeAuctionStatus";
import TradePager from "./TradePager";
import TradeRefreshFailedNotice from "./TradeRefreshFailedNotice";

const ROLES: ReadonlyArray<{ role: TradeAuctionMineRole; labelKey: string; emptyKey: string }> = [
  { role: "selling", labelKey: "myAuctionsRoleSelling", emptyKey: "myAuctionsEmptySelling" },
  { role: "bidding", labelKey: "myAuctionsRoleBidding", emptyKey: "myAuctionsEmptyBidding" },
];

/** GET /api/trades/auctions/mine URL of one role page (also the cache key). */
function myAuctionsUrl(role: TradeAuctionMineRole, page: number) {
  return `/api/trades/auctions/mine?role=${role}&page=${page}`;
}

/**
 * "Auctions" tab of /trade/mine (#1791, design §6):
 *
 *   my auctions — 出品中 / 選択待ち（成立操作）/ 成立 / 流札・取消
 *   my bids     — 入札中 / 選択待ち / 落札 / 落選・解放
 *
 * Reads the separate GET /api/trades/auctions/mine (design §4.6), so a
 * failure here — including 503 TRADE_AUCTION_UNAVAILABLE in the migration
 * deploy window, shown as "not available yet" — never affects the offer tabs
 * of the same page. Every action (settle, cancel, withdraw) is on the detail
 * page, which has the bid list; the rows link there, and a selecting auction
 * gets a prominent "choose a bid" link so the 72-hour window is not missed.
 */
export default function MyTradeAuctions() {
  const t = useTranslations("trade");
  const locale = useLocale();
  const [role, setRole] = useState<TradeAuctionMineRole>("selling");
  const [page, setPage] = useState(1);
  const { view: list, retry, refresh } = useTradeList<TradeAuctionDto>(myAuctionsUrl(role, page), {
    rowsKey: "auctions",
    onEmptyPage: setPage,
  });

  const activeRole = ROLES.find((item) => item.role === role) ?? ROLES[0];

  let body: React.ReactNode;
  if (list.status === "loading") {
    body = (
      <p className="py-8 text-center text-gray-400" role="status">
        {t("loading")}
      </p>
    );
  } else if (list.status === "error" && list.unavailable) {
    body = (
      <p role="status" className="rounded-xl bg-gray-800 p-8 text-center text-gray-300">
        {t("auctionUnavailableNotice")}
      </p>
    );
  } else if (list.status === "error") {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl bg-red-900/40 p-4 text-sm text-red-200 sm:flex-row sm:justify-between">
        <span>{t("myAuctionsLoadError")}</span>
        <button
          type="button"
          onClick={retry}
          className="rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600"
        >
          {t("retryButton")}
        </button>
      </div>
    );
  } else if (list.offers.length === 0) {
    body = <p className="rounded-xl bg-gray-800 p-8 text-center text-gray-400">{t(activeRole.emptyKey)}</p>;
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {list.offers.map((auction) => {
          const myBid = auction.myBid ?? null;
          // The detail page is opened from the channel whose cards are
          // involved: the auction's channel for the seller, the bid card's
          // channel for a bidder (that is where a bid change picks cards).
          const detailStreamerId =
            role === "bidding" && myBid ? myBid.bidStreamerId : auction.offeredStreamerId;
          // Cross-channel bids open the detail on the bid card's channel; keep
          // the scope so the detail's "back" link returns to that channel's
          // cross tab (O2).
          const detailScope =
            role === "bidding" && myBid && myBid.bidStreamerId !== auction.offeredStreamerId
              ? "cross_channel"
              : "in_channel";
          const detailHref = tradeAuctionDetailPath(detailStreamerId, auction.id, detailScope);
          const needsSelection = role === "selling" && auction.phase === "selecting";
          const dateText =
            auction.phase === "completed"
              ? t("myTradesCompletedAt", { date: formatTradeDateTime(auction.completedAt, locale) })
              : auction.phase === "selecting"
                ? t("auctionSelectionDeadline", { date: formatTradeDateTime(auction.selectionDeadline, locale) })
                : t("auctionEndsAt", { date: formatTradeDateTime(auction.endsAt, locale) });
          return (
            <li key={auction.id} className="rounded-xl bg-gray-800 p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                {role === "selling" ? (
                  <TradeAuctionPhaseBadge auction={auction} />
                ) : (
                  myBid && (
                    <span className="rounded bg-gray-700 px-2 py-0.5 text-gray-100">
                      {t(auctionBidStateLabelKey(myBid.state, auction.phase))}
                    </span>
                  )
                )}
                {role === "bidding" && myBid?.state === "active" && !myBid.settleable && (
                  <span className="rounded bg-yellow-700 px-2 py-0.5 text-yellow-50">
                    {t("auctionBidUnsettleableBadge")}
                  </span>
                )}
                <span className="text-gray-400">{dateText}</span>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <TradeCardSummary
                    card={auction.offeredCard}
                    deleted={auction.offeredCardId === null}
                    label={t(role === "selling" ? "myTradesGive" : "auctionOfferedCardLabel")}
                    streamer={auction.offeredStreamer}
                  />
                </div>
                {role === "bidding" && myBid && (
                  <>
                    <span
                      role="img"
                      aria-label={t("directionIconLabel")}
                      className="self-center text-2xl text-purple-300 max-sm:rotate-90"
                    >
                      ⇄
                    </span>
                    <div className="min-w-0 flex-1">
                      <TradeCardSummary
                        card={myBid.bidCard}
                        deleted={myBid.bidCardId === null}
                        quantity={myBid.quantity}
                        label={t("auctionMyBidTitle")}
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="mt-3 flex flex-col gap-2 border-t border-gray-700 pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="text-gray-300">{t("auctionBidCount", { count: auction.bidCount })}</span>
                <Link
                  href={detailHref}
                  className={
                    needsSelection
                      ? "rounded-lg bg-purple-600 px-4 py-2 text-center font-semibold text-white hover:bg-purple-700"
                      : "text-center text-purple-300 hover:text-purple-200"
                  }
                >
                  {t(needsSelection ? "myAuctionsSettleLink" : "myAuctionsDetailLink")}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div>
      {/* Two-way switch between my auctions and my bids: a radio-like group
          of toggle buttons (aria-pressed) nested inside the page's tab panel,
          rather than a second tablist inside a tabpanel. */}
      <div role="group" aria-label={t("myAuctionsRoleLabel")} className="mb-4 flex gap-2 overflow-x-auto">
        {ROLES.map((item) => {
          const selected = item.role === role;
          return (
            <button
              key={item.role}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setRole(item.role);
                setPage(1);
              }}
              className={`shrink-0 rounded-full border px-3 py-1 text-sm ${
                selected
                  ? "border-purple-400 bg-purple-900/40 text-white"
                  : "border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>
      {list.status === "ok" && list.refreshFailed && <TradeRefreshFailedNotice onRetry={refresh} />}
      {body}
      {list.status === "ok" && <TradePager page={page} hasMore={list.hasMore} onPageChange={setPage} />}
    </div>
  );
}
