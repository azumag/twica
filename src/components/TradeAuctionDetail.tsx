"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { TradeAuctionBidDto, TradeAuctionDto } from "@/lib/trade-auction";
import {
  auctionBidStateLabelKey,
  formatTradeDateTime,
  postTradeJson,
  tradeErrorMessageKey,
  type TradePostResult,
} from "@/lib/trade-client";
import { clearTradeListCache } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeAuctionConfirmModal from "./TradeAuctionConfirmModal";
import { TradeAuctionPhaseBadge } from "./TradeAuctionStatus";
import TradeCardChoiceList from "./TradeCardChoiceList";
import TradeCardSummary from "./TradeCardSummary";
import TradeRefreshFailedNotice from "./TradeRefreshFailedNotice";

/**
 * A card the viewer could bid with, prepared by the server page from
 * listWantableCards (trade_wantable + visibility, #1790) ∩ the viewer's
 * copies. `freeCount` = copies not locked by an offer, auction or bid.
 */
export type TradeAuctionBidCard = {
  cardId: string;
  name: string;
  rarity: string;
  imageUrl: string | null;
  freeCount: number;
};

interface TradeAuctionDetailProps {
  auctionId: string;
  isLoggedIn: boolean;
  /** Login URL returning to this detail page. */
  loginHref: string;
  /** Bid candidates of the board's channel (empty for anonymous viewers). */
  bidCards: TradeAuctionBidCard[];
  /** TRADE_MAX_BID_QUANTITY, passed from the server page (API re-validates). */
  maxBidQuantity: number;
}

type DetailState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "notFound" }
  | { status: "unavailable" }
  | {
      status: "ok";
      auction: TradeAuctionDto;
      /** Seller only: every non-withdrawn bid. null for everyone else. */
      bids: TradeAuctionBidDto[] | null;
      /** A refresh after the first load failed; the data shown may be stale. */
      refreshFailed: boolean;
    };

type Confirming =
  | { kind: "withdraw"; bid: TradeAuctionBidDto }
  | { kind: "cancel" }
  | { kind: "settle"; bid: TradeAuctionBidDto };

const PRIMARY_BUTTON =
  "rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON =
  "rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Auction detail (#1791, design §6): bid / change / withdraw for bidders,
 * the bid list with settle and cancel for the seller.
 *
 * Data comes from GET /api/trades/auctions/[id] in the browser (behind the
 * tradeRead rate limit, same reason as the board), which already applies the
 * disclosure rule: `bids` only for the seller, `myBid` only for the bidder.
 * Every phase boundary (deadline, selection window, settleable) is decided by
 * the server; the UI only mirrors the last answer and explains a refused
 * operation with the API error copy, then reloads.
 *
 * Double submission: one action at a time (`busy` disables every action
 * button), and the create-like writes carry a requestId that is reused for a
 * retry of the same choice (bid: bound to card + quantity like the listing
 * flow; settle: per bid like the accept flow) and dropped after a confirmed
 * success. Withdraw and cancel are idempotent in state and need none.
 *
 * After any answered write the page reloads the detail, drops the client
 * list cache (locks changed → board/mine rows are stale) and refreshes the
 * server props (`bidCards` free counts).
 */
export default function TradeAuctionDetail({
  auctionId,
  isLoggedIn,
  loginHref,
  bidCards,
  maxBidQuantity,
}: TradeAuctionDetailProps) {
  const t = useTranslations("trade");
  const tMaintenance = useTranslations("maintenance");
  const locale = useLocale();
  const router = useRouter();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";

  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [bidCardId, setBidCardId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const bidRequestRef = useRef<{ selection: string; id: string } | null>(null);
  const settleRequestIds = useRef(new Map<string, string>());
  // Bumped to reload the detail (after a write, or the retry button).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/trades/auctions/${auctionId}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { auction?: TradeAuctionDto; bids?: TradeAuctionBidDto[] | null; code?: string }
          | null;
        if (controller.signal.aborted) return;
        if (res.ok && data?.auction) {
          setDetail({ status: "ok", auction: data.auction, bids: data.bids ?? null, refreshFailed: false });
          return;
        }
        if (res.status === 404) {
          setDetail({ status: "notFound" });
          return;
        }
        if (data?.code === "TRADE_AUCTION_UNAVAILABLE") {
          setDetail({ status: "unavailable" });
          return;
        }
        throw new Error(`status ${res.status}`);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Keep data that is already on screen (flagged as possibly stale).
        setDetail((prev) => (prev.status === "ok" ? { ...prev, refreshFailed: true } : { status: "error" }));
      });
    return () => controller.abort();
  }, [auctionId, reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  const errorText = (result: Extract<TradePostResult<unknown>, { ok: false }>) =>
    result.maintenanceMessage
    ?? t(result.networkError ? "errorNetwork" : tradeErrorMessageKey(result.code));

  /**
   * Run one write. A network error leaves everything as is (the same
   * requestId is reused by the retry). Any answer from the server — success
   * or a refusal such as "deadline passed" — means the state on screen may
   * be stale, so the detail, the list cache and the server props refresh.
   */
  const runWrite = async (
    key: string,
    request: () => Promise<TradePostResult<unknown>>,
    successText: string,
    onSuccess?: () => void,
  ) => {
    if (busy) return;
    if (writeBlocked) {
      setNotice({ text: tMaintenance("writeDisabled"), isError: true });
      return;
    }
    setBusy(key);
    setNotice(null);
    const result = await request();
    setBusy(null);
    if (result.ok) {
      onSuccess?.();
      setNotice({ text: successText, isError: false });
    } else {
      setNotice({ text: errorText(result), isError: true });
    }
    if (result.ok || !result.networkError) {
      clearTradeListCache();
      router.refresh();
      reload();
    }
  };

  const openConfirm = (value: Confirming, trigger: HTMLElement) => {
    if (busy) return;
    if (writeBlocked) {
      setNotice({ text: tMaintenance("writeDisabled"), isError: true });
      return;
    }
    confirmTriggerRef.current = trigger;
    setConfirming(value);
  };

  const restoreFocus = () => {
    const trigger = confirmTriggerRef.current;
    confirmTriggerRef.current = null;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };

  const closeConfirm = () => {
    setConfirming(null);
    restoreFocus();
  };

  const performConfirmed = () => {
    const value = confirming;
    if (!value) return;
    setConfirming(null);
    let write: Promise<void>;
    if (value.kind === "withdraw") {
      write = runWrite(
        "withdraw",
        () => postTradeJson(`/api/trades/auctions/${auctionId}/bids/${value.bid.id}/withdraw`, {}),
        t("auctionWithdrawSuccess"),
      );
    } else if (value.kind === "cancel") {
      write = runWrite(
        "cancel",
        () => postTradeJson(`/api/trades/auctions/${auctionId}/cancel`, {}),
        t("auctionCancelSuccess"),
      );
    } else {
      const bidId = value.bid.id;
      let requestId = settleRequestIds.current.get(bidId);
      if (!requestId) {
        requestId = crypto.randomUUID();
        settleRequestIds.current.set(bidId, requestId);
      }
      const settleRequestId = requestId;
      write = runWrite(
        `settle:${bidId}`,
        () => postTradeJson(`/api/trades/auctions/${auctionId}/settle`, { bidId, requestId: settleRequestId }),
        t("auctionSettleSuccess"),
        () => settleRequestIds.current.delete(bidId),
      );
    }
    void write.finally(restoreFocus);
  };

  if (detail.status === "loading") {
    return (
      <p className="py-8 text-center text-gray-400" role="status">
        {t("loading")}
      </p>
    );
  }
  if (detail.status === "notFound") {
    return <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">{t("errorTradeAuctionNotFound")}</p>;
  }
  if (detail.status === "unavailable") {
    return (
      <p role="status" className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">
        {t("auctionUnavailableNotice")}
      </p>
    );
  }
  if (detail.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl bg-red-900/40 p-4 text-sm text-red-200 sm:flex-row sm:justify-between">
        <span>{t("auctionDetailLoadError")}</span>
        <button type="button" onClick={reload} className="rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600">
          {t("retryButton")}
        </button>
      </div>
    );
  }

  const { auction, bids } = detail;
  const myBid = auction.myBid ?? null;
  const myActiveBid = myBid && myBid.state === "active" ? myBid : null;
  const isOpenStatus = auction.status === "open";

  const bidCardView = (bid: TradeAuctionBidDto, label: string) => (
    <TradeCardSummary card={bid.bidCard} deleted={bid.bidCardId === null} quantity={bid.quantity} label={label} />
  );

  // ---------------------------------------------------------------- header
  const header = (
    <section aria-labelledby="auction-detail-title" className="rounded-xl bg-gray-800 p-4">
      <h2 id="auction-detail-title" className="sr-only">
        {t("auctionDetailTitle")}
      </h2>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <TradeCardSummary
            card={auction.offeredCard}
            deleted={auction.offeredCardId === null}
            label={t("auctionOfferedCardLabel")}
            streamer={auction.offeredStreamer}
            size="lg"
          />
        </div>
        <dl className="grid gap-1 text-sm text-gray-300 sm:text-right">
          <div>
            <dt className="sr-only">{t("auctionStatusLabel")}</dt>
            <dd>
              <TradeAuctionPhaseBadge auction={auction} />
            </dd>
          </div>
          <div>
            <dt className="sr-only">{t("auctionBidCountLabel")}</dt>
            <dd>{t("auctionBidCount", { count: auction.bidCount })}</dd>
          </div>
          <div>
            <dt className="sr-only">{t("auctionSellerLabel")}</dt>
            <dd>{t("offeredByLabel", { name: auction.seller?.twitchDisplayName ?? t("unknownUser") })}</dd>
          </div>
          <div>
            <dt className="sr-only">{t("auctionEndsAtLabel")}</dt>
            <dd>{t("auctionEndsAt", { date: formatTradeDateTime(auction.endsAt, locale) })}</dd>
          </div>
          {(auction.phase === "selecting" || (auction.phase === "bidding" && auction.isOwnAuction)) && (
            <div>
              <dt className="sr-only">{t("auctionSelectionDeadlineLabel")}</dt>
              <dd>{t("auctionSelectionDeadline", { date: formatTradeDateTime(auction.selectionDeadline, locale) })}</dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );

  // ---------------------------------------------------------------- seller
  const sellerPanel = () => {
    const list = bids ?? [];
    return (
      <section aria-labelledby="auction-bids-title" className="rounded-xl bg-gray-800 p-4">
        <h2 id="auction-bids-title" className="mb-2 text-lg font-semibold text-white">
          {t("auctionBidsTitle")}
        </h2>
        <p className="mb-3 text-sm text-gray-300">
          {auction.phase === "bidding"
            ? t("auctionSellerBiddingHelp")
            : auction.phase === "selecting"
              ? t("auctionSellerSelectingHelp", { date: formatTradeDateTime(auction.selectionDeadline, locale) })
              : t(auction.phase === "completed" ? "auctionSellerCompletedHelp" : "auctionSellerClosedHelp")}
        </p>
        {list.length === 0 ? (
          <p className="rounded-lg bg-gray-900/40 p-4 text-sm text-gray-400">{t("auctionBidsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((bid) => {
              const unsettleable = bid.state === "active" && !bid.settleable;
              const canSettle = auction.phase === "selecting" && bid.state === "active" && bid.settleable;
              return (
                <li key={bid.id} className="rounded-lg border border-gray-700 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      {bidCardView(bid, t("auctionBidderLabel", { name: bid.bidder?.twitchDisplayName ?? t("unknownUser") }))}
                    </div>
                    <div className="flex flex-col items-stretch gap-2 sm:items-end">
                      {bid.state !== "active" && (
                        <span className="w-fit rounded bg-gray-600 px-2 py-0.5 text-xs text-gray-100">
                          {t(bid.state === "won" ? "auctionSellerBidWon" : bid.state === "lost" ? "auctionSellerBidLost" : "auctionBidStateReleased")}
                        </span>
                      )}
                      {unsettleable && (
                        <span className="w-fit rounded bg-yellow-700 px-2 py-0.5 text-xs text-yellow-50">
                          {t("auctionBidUnsettleableBadge")}
                        </span>
                      )}
                      {auction.phase === "selecting" && bid.state === "active" && (
                        <button
                          type="button"
                          className={PRIMARY_BUTTON}
                          disabled={!canSettle || busy !== null || writeBlocked}
                          aria-busy={busy === `settle:${bid.id}`}
                          onClick={(event) => openConfirm({ kind: "settle", bid }, event.currentTarget)}
                        >
                          {busy === `settle:${bid.id}` ? t("auctionSettleSubmitting") : t("auctionSettleButton")}
                        </button>
                      )}
                    </div>
                  </div>
                  {unsettleable && auction.phase === "selecting" && (
                    <p className="mt-2 text-xs text-yellow-200">{t("auctionSellerUnsettleableHelp")}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {isOpenStatus && auction.bidCount === 0 && (
          // Spec: an auction without an active bid can be cancelled before or
          // after its deadline. With bids the server answers HAS_BIDS, so the
          // button is not offered at all.
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={busy !== null || writeBlocked}
              aria-busy={busy === "cancel"}
              onClick={(event) => openConfirm({ kind: "cancel" }, event.currentTarget)}
            >
              {busy === "cancel" ? t("auctionCancelSubmitting") : t("auctionCancelButton")}
            </button>
          </div>
        )}
        {isOpenStatus && auction.bidCount > 0 && auction.phase === "bidding" && (
          <p className="mt-3 text-xs text-gray-400">{t("auctionCancelHasBidsHelp")}</p>
        )}
      </section>
    );
  };

  // ---------------------------------------------------------------- bidder
  const usableCount = (card: TradeAuctionBidCard) =>
    // Copies of the viewer's current bid are reusable for its change (the
    // RPC re-selects them), so they count as usable for the same card.
    card.freeCount + (myActiveBid && myActiveBid.bidCardId === card.cardId ? myActiveBid.quantity : 0);
  const selectedCard = bidCards.find((card) => card.cardId === bidCardId) ?? null;
  const selectedUsable = selectedCard ? Math.min(usableCount(selectedCard), maxBidQuantity) : 0;

  const submitBid = () => {
    if (!selectedCard || quantity < 1 || quantity > selectedUsable) return;
    const selection = `${selectedCard.cardId}:${quantity}`;
    if (bidRequestRef.current?.selection !== selection) {
      bidRequestRef.current = { selection, id: crypto.randomUUID() };
    }
    const requestId = bidRequestRef.current.id;
    const changing = myActiveBid !== null;
    void runWrite(
      "bid",
      () => postTradeJson(`/api/trades/auctions/${auctionId}/bids`, {
        bidCardId: selectedCard.cardId,
        quantity,
        requestId,
      }),
      t(changing ? "auctionBidChangeSuccess" : "auctionBidSuccess"),
      () => {
        bidRequestRef.current = null;
        setBidCardId(null);
        setQuantity(1);
      },
    );
  };

  const bidForm = () => (
    <section aria-labelledby="auction-bid-form-title" className="rounded-xl bg-gray-800 p-4">
      <h2 id="auction-bid-form-title" className="mb-2 text-lg font-semibold text-white">
        {t(myActiveBid ? "auctionBidChangeTitle" : "auctionBidFormTitle")}
      </h2>
      <p className="mb-3 text-sm text-gray-300">{t("auctionBidFormHelp")}</p>
      {bidCards.length === 0 ? (
        <p className="rounded-lg bg-gray-900/40 p-4 text-sm text-gray-400">{t("auctionBidCardsEmpty")}</p>
      ) : (
        <>
          <TradeCardChoiceList
            choices={bidCards.map((card) => {
              const sameAsOffered = card.cardId === auction.offeredCardId;
              const usable = usableCount(card);
              return {
                cardId: card.cardId,
                card,
                disabled: sameAsOffered || usable === 0,
                title: sameAsOffered ? t("auctionBidSameCard") : undefined,
                badge: (
                  <span className="ml-2 shrink-0 rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-100">
                    {sameAsOffered ? t("auctionBidSameCardBadge") : t("auctionBidUsableBadge", { count: usable })}
                  </span>
                ),
              };
            })}
            selectedCardId={bidCardId}
            onSelect={(cardId) => {
              const card = bidCards.find((item) => item.cardId === cardId);
              setBidCardId(cardId);
              // Keep the quantity within what the new card allows.
              if (card) setQuantity((value) => Math.max(1, Math.min(value, usableCount(card), maxBidQuantity)));
              setNotice(null);
            }}
            disabled={busy !== null}
          />
          {selectedCard && (
            <label className="mt-4 flex items-center gap-3 text-sm text-gray-200">
              {t("auctionBidQuantityLabel")}
              <select
                value={quantity}
                disabled={busy !== null}
                onChange={(event) => {
                  setQuantity(Number(event.target.value));
                  setNotice(null);
                }}
                className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {Array.from({ length: selectedUsable }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {t("createStep2QuantityOption", { count: value })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="mt-3 text-sm text-gray-200">
            {selectedCard
              ? t("auctionBidSummary", { card: selectedCard.name, count: quantity })
              : t("auctionBidPending")}
          </p>
          <p className="mt-1 text-xs text-gray-400">{t("auctionBidLockNotice")}</p>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={!selectedCard || busy !== null || writeBlocked}
              aria-busy={busy === "bid"}
              onClick={submitBid}
            >
              {busy === "bid"
                ? t("auctionBidSubmitting")
                : t(myActiveBid ? "auctionBidChangeSubmit" : "auctionBidSubmit")}
            </button>
          </div>
        </>
      )}
    </section>
  );

  const bidderPanel = () => {
    // Withdrawal: always before the deadline; after it only for a bid the
    // seller can no longer settle (spec). Otherwise the server answers
    // BID_LOCKED, so the button is not offered.
    const canWithdraw =
      myActiveBid !== null
      && (auction.phase === "bidding" || (auction.phase === "selecting" && !myActiveBid.settleable));
    return (
      <>
        {myBid && (
          <section aria-labelledby="auction-my-bid-title" className="rounded-xl bg-gray-800 p-4">
            <h2 id="auction-my-bid-title" className="mb-3 text-lg font-semibold text-white">
              {t("auctionMyBidTitle")}
            </h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">{bidCardView(myBid, t("myTradesGive"))}</div>
              <div className="flex flex-col items-stretch gap-2 sm:items-end">
                <span className="w-fit rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-100">
                  {t(auctionBidStateLabelKey(myBid.state, auction.phase))}
                </span>
                {myActiveBid && !myActiveBid.settleable && (
                  <span className="w-fit rounded bg-yellow-700 px-2 py-0.5 text-xs text-yellow-50">
                    {t("auctionBidUnsettleableBadge")}
                  </span>
                )}
                {canWithdraw && (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={busy !== null || writeBlocked}
                    aria-busy={busy === "withdraw"}
                    onClick={(event) => openConfirm({ kind: "withdraw", bid: myActiveBid }, event.currentTarget)}
                  >
                    {busy === "withdraw" ? t("auctionWithdrawSubmitting") : t("auctionWithdrawButton")}
                  </button>
                )}
              </div>
            </div>
            {myActiveBid && auction.phase === "selecting" && (
              <p className="mt-3 text-sm text-gray-300">
                {myActiveBid.settleable
                  ? t("auctionWaitingForSeller", { date: formatTradeDateTime(auction.selectionDeadline, locale) })
                  : t("auctionMyBidUnsettleableHelp")}
              </p>
            )}
          </section>
        )}
        {auction.phase === "bidding" ? (
          bidForm()
        ) : (
          !myBid && <p className="rounded-xl bg-gray-800 p-4 text-sm text-gray-300">{t("auctionBiddingClosedNotice")}</p>
        )}
      </>
    );
  };

  let body: React.ReactNode;
  if (auction.isOwnAuction) {
    body = sellerPanel();
  } else if (!isLoggedIn) {
    body = auction.phase === "bidding" ? (
      // Plain <a>: the login URL is an API route that starts OAuth.
      <a href={loginHref} className={`${PRIMARY_BUTTON} block text-center`}>
        {t("auctionLoginToBid")}
      </a>
    ) : (
      <p className="rounded-xl bg-gray-800 p-4 text-sm text-gray-300">{t("auctionBiddingClosedNotice")}</p>
    );
  } else {
    body = bidderPanel();
  }

  const modal = (() => {
    if (!confirming) return null;
    if (confirming.kind === "cancel") {
      return (
        <TradeAuctionConfirmModal
          title={t("auctionCancelConfirmTitle")}
          warning={t("auctionCancelConfirmWarning")}
          confirmLabel={t("auctionCancelConfirmButton")}
          destructive
          onConfirm={performConfirmed}
          onClose={closeConfirm}
        >
          <TradeCardSummary card={auction.offeredCard} label={t("auctionOfferedCardLabel")} />
        </TradeAuctionConfirmModal>
      );
    }
    if (confirming.kind === "withdraw") {
      return (
        <TradeAuctionConfirmModal
          title={t("auctionWithdrawConfirmTitle")}
          warning={t("auctionWithdrawConfirmWarning")}
          confirmLabel={t("auctionWithdrawConfirmButton")}
          destructive
          onConfirm={performConfirmed}
          onClose={closeConfirm}
        >
          {bidCardView(confirming.bid, t("auctionMyBidTitle"))}
        </TradeAuctionConfirmModal>
      );
    }
    return (
      <TradeAuctionConfirmModal
        title={t("auctionSettleConfirmTitle")}
        warning={t("auctionSettleConfirmWarning")}
        confirmLabel={t("auctionSettleConfirmButton")}
        onConfirm={performConfirmed}
        onClose={closeConfirm}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <TradeCardSummary card={auction.offeredCard} label={t("myTradesGive")} />
          </div>
          <span role="img" aria-label={t("directionIconLabel")} className="self-center text-2xl text-purple-300 max-sm:rotate-90">
            ⇄
          </span>
          <div className="min-w-0 flex-1">{bidCardView(confirming.bid, t("receiveLabel"))}</div>
        </div>
      </TradeAuctionConfirmModal>
    );
  })();

  return (
    <div className="flex flex-col gap-4">
      {detail.refreshFailed && <TradeRefreshFailedNotice onRetry={reload} />}
      {header}
      {notice && (
        <p
          role={notice.isError ? "alert" : "status"}
          className={`rounded-lg p-3 text-sm ${
            notice.isError ? "bg-red-900/40 text-red-200" : "bg-emerald-500/10 text-emerald-100"
          }`}
        >
          {notice.text}
        </p>
      )}
      {body}
      {modal}
    </div>
  );
}
