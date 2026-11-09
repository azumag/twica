"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { TradeScope } from "@/lib/trade";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import { tradeAuctionDetailPath } from "@/lib/trade-client";
import { useTradeList } from "@/lib/use-trade-list";
import TradeAuctionRow from "./TradeAuctionRow";
import TradePager from "./TradePager";
import TradeRefreshFailedNotice from "./TradeRefreshFailedNotice";

interface TradeAuctionBoardProps {
  streamerId: string;
  scope: TradeScope;
  isLoggedIn: boolean;
  /** Same per-viewer cache namespace as <TradeBoard> (rows carry myBid / isOwnAuction). */
  viewerKey: string;
  /** Auction listing flow URL (or login URL for anonymous viewers). */
  createHref: string;
  /** Arrived right after listing an auction (?listed=1). */
  justListed?: boolean;
}

const CTA_CLASS =
  "mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700";

/**
 * Auction tab of the trade board (#1791, design §6).
 *
 * Fetched from the browser through GET /api/trades/auctions (behind the
 * tradeRead rate limit, like the offer board) with the same page cache
 * (useTradeList, shared + viewerKey): rows carry viewer-specific fields
 * (isOwnAuction, myBid), so another account's rows are never reused.
 *
 * Deploy window (design §4.6): while the auction schema is not migrated the
 * API answers 503 TRADE_AUCTION_UNAVAILABLE; the tab then shows a "not
 * available yet" notice instead of an error, and the offer tabs are not
 * affected at all (separate endpoint, separate component).
 */
export default function TradeAuctionBoard({
  streamerId,
  scope,
  isLoggedIn,
  viewerKey,
  createHref,
  justListed = false,
}: TradeAuctionBoardProps) {
  const t = useTranslations("trade");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ streamerId, scope, page: String(page) });
  const { view: list, retry, refresh } = useTradeList<TradeAuctionDto>(
    `/api/trades/auctions?${params.toString()}`,
    { shared: true, viewerKey, rowsKey: "auctions", onEmptyPage: setPage },
  );

  useEffect(() => {
    if (!justListed) return;
    // Same as <TradeBoard>: drop ?listed=1 so a reload does not repeat the notice.
    const url = new URL(window.location.href);
    url.searchParams.delete("listed");
    window.history.replaceState(window.history.state, "", url);
  }, [justListed]);

  let body: React.ReactNode;
  if (list.status === "loading") {
    body = (
      <p className="py-8 text-center text-gray-400" role="status">
        {t("loading")}
      </p>
    );
  } else if (list.status === "error" && list.unavailable) {
    body = (
      <p role="status" className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">
        {t("auctionUnavailableNotice")}
      </p>
    );
  } else if (list.status === "error") {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl bg-red-900/40 p-4 text-sm text-red-200 sm:flex-row sm:justify-between">
        <span>{t("auctionLoadError")}</span>
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
    body = (
      <div className="rounded-xl bg-gray-800 p-8 text-center">
        <p className="text-gray-400">{t("auctionEmptyState")}</p>
        {/* The cross tab lists other channels' auctions: listing one there
            would be in this channel, so the CTA is in-channel only. */}
        {scope === "in_channel" && (
          isLoggedIn ? (
            <Link href={createHref} className={CTA_CLASS}>
              {t("auctionEmptyStateCta")}
            </Link>
          ) : (
            // Anonymous: createHref is the OAuth API route → plain <a> (no prefetch).
            <a href={createHref} className={CTA_CLASS}>
              {t("auctionEmptyStateCta")}
            </a>
          )
        )}
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {list.offers.map((auction) => (
          <TradeAuctionRow
            key={auction.id}
            auction={auction}
            showStreamer={scope === "cross_channel"}
            detailHref={tradeAuctionDetailPath(streamerId, auction.id, scope)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section>
      {justListed && (
        <div role="status" className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          <p>{t("auctionListedNotice")}</p>
        </div>
      )}
      <p className="mb-4 text-sm text-gray-400">{t("auctionBoardHelp")}</p>
      {list.status === "ok" && list.refreshFailed && <TradeRefreshFailedNotice onRetry={refresh} />}
      {body}
      {list.status === "ok" && (
        <TradePager page={page} hasMore={list.hasMore} onPageChange={setPage} />
      )}
    </section>
  );
}
