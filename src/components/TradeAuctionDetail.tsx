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
  | { status: "error"; rateLimited?: boolean }
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
  // The button that opened the confirm dialog, kept so closing can restore
  // focus. Held in state (not a ref) on purpose: the element is captured from
  // `event.currentTarget` inside render-created onClick closures, and feeding
  // that value into a ref makes the compiler type the event handler's argument
  // as a ref value (react-hooks/refs: "passing a ref to a function"). It is
  // only read inside event handlers / timers, never during render.
  const [confirmTrigger, setConfirmTrigger] = useState<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const bidRequestRef = useRef<{ selection: string; id: string } | null>(null);
  const settleRequestIds = useRef(new Map<string, string>());
  // Bumped to reload the detail (after a write, or the retry button).
  const [reloadKey, setReloadKey] = useState(0);
  // The effect-owned GET in flight, if any. A write aborts it right before
  // its own refetch: the retry answer was computed before the write, so it
  // must not land after the refetch and mark the stale rows fresh again.
  const effectLoadRef = useRef<AbortController | null>(null);

  /**
   * One GET of the auction detail, shared by the mount/reload effect and the
   * write flow. The write flow awaits it so that `busy` covers the refetch
   * too (O1): between the write's answer and the fresh rows the screen still
   * shows the old phase, and a second confirm on those stale rows would fire
   * a request the server refuses — a second settle, for example, replaces
   * the success notice with TRADE_AUCTION_NOT_OPEN.
   *
   * `signal` aborts an effect-owned load when the effect re-runs (unmount or
   * reloadKey bump). The write flow passes none: its load is not tied to the
   * effect, and React drops a late setState of an unmounted instance.
   */
  const loadDetail = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const res = await fetch(`/api/trades/auctions/${auctionId}`, {
          credentials: "include",
          cache: "no-store",
          signal,
        });
        const data = (await res.json().catch(() => null)) as
          | { auction?: TradeAuctionDto; bids?: TradeAuctionBidDto[] | null; code?: string }
          | null;
        if (signal?.aborted) return;
        if (res.ok && data?.auction) {
          setDetail({ status: "ok", auction: data.auction, bids: data.bids ?? null, refreshFailed: false });
          return;
        }
        if (res.status === 404) {
          setDetail({ status: "notFound" });
          return;
        }
        if (res.status === 429) {
          setDetail((prev) => (prev.status === "ok" ? { ...prev, refreshFailed: true } : { status: "error", rateLimited: true }));
          return;
        }
        if (data?.code === "TRADE_AUCTION_UNAVAILABLE") {
          setDetail({ status: "unavailable" });
          return;
        }
        throw new Error(`status ${res.status}`);
      } catch {
        if (signal?.aborted) return;
        // Keep data that is already on screen (flagged as possibly stale).
        setDetail((prev) => (prev.status === "ok" ? { ...prev, refreshFailed: true } : { status: "error" }));
      }
    },
    [auctionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    effectLoadRef.current = controller;
    // loadDetail は内部で setDetail を呼ぶ（実際の更新は fetch 後の非同期
    // コールバック）。effect 本体からの直接呼び出しは react-hooks/set-state-in-effect
    // が検出するため匿名 async 関数の内側で起動する。呼び出し自体は最初の await
    // まで同期的に実行されるため従来と同一タイミングで、abort シグナルもそのまま
    // 引き継ぐ（act() スコープ内に収まり queueMicrotask より忠実）。
    void (async () => {
      await loadDetail(controller.signal);
    })();
    return () => {
      // The ref may already have been aborted and nulled by a write.
      if (effectLoadRef.current === controller) effectLoadRef.current = null;
      controller.abort();
    };
  }, [auctionId, reloadKey, loadDetail]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  const errorText = (result: Extract<TradePostResult<unknown>, { ok: false }>) =>
    result.maintenanceMessage
    ?? t(result.networkError ? "errorNetwork" : tradeErrorMessageKey(result.code));

  /**
   * Run one write. A network error leaves everything as is (the same
   * requestId is reused by the retry). Any answer from the server — success
   * or a refusal such as "deadline passed" — means the state on screen may
   * be stale, so the detail, the list cache and the server props refresh.
   *
   * `busy` is held until that refetched detail is on screen (O1): with the
   * stale rows still displayed, every action button stays disabled, so a
   * second confirm cannot race the reload and replace a just-shown success
   * notice with a refusal such as TRADE_AUCTION_NOT_OPEN. The refetch is
   * the last answer applied: an effect-owned retry GET still in flight is
   * aborted first (its answer predates this write), so it cannot land after
   * the refetch and mark the stale rows fresh again.
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
    if (result.ok) {
      onSuccess?.();
      setNotice({ text: successText, isError: false });
    } else {
      setNotice({ text: errorText(result), isError: true });
    }
    if (result.ok || !result.networkError) {
      clearTradeListCache();
      router.refresh();
      // A retry GET may still be in flight; its answer was computed before
      // this write, so abort it — landing after the refetch below would
      // mark the stale rows fresh again and reopen the O1 window.
      effectLoadRef.current?.abort();
      effectLoadRef.current = null;
      await loadDetail();
    }
    setBusy(null);
  };

  // The event object is passed whole and `currentTarget` is read here (event
  // time) instead of at the JSX call site: reading `event.currentTarget` inside
  // a render-created closure is flagged by react-hooks/refs when the value
  // flows toward a ref, so it is stored as component state instead.
  const openConfirm = (value: Confirming, event: React.MouseEvent<HTMLElement>) => {
    if (busy) return;
    if (writeBlocked) {
      setNotice({ text: tMaintenance("writeDisabled"), isError: true });
      return;
    }
    setConfirmTrigger(event.currentTarget);
    setConfirming(value);
  };

  const restoreFocus = () => {
    const trigger = confirmTrigger;
    setConfirmTrigger(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) {
        trigger.focus();
      } else if (noticeRef.current?.isConnected) {
        // The originating button may have disappeared on success (e.g. a
        // settled bid row); move focus to the result notice instead of letting
        // it fall to <body> (O4).
        noticeRef.current.focus();
      }
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
        <span>{detail.rateLimited ? t("errorRateLimited") : t("auctionDetailLoadError")}</span>
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
                          onClick={(event) => openConfirm({ kind: "settle", bid }, event)}
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
              onClick={(event) => openConfirm({ kind: "cancel" }, event)}
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
  // `bidCards` is a server prop refreshed after every write, and its free
  // counts can shrink while this form stays open: another tab can lock the
  // copies, or a refused bid reloads the detail. The stored `quantity` then
  // falls outside the options, so the select, the summary, the POST body and
  // the disabled state all derive the value the current limits allow instead
  // of trusting the possibly stale state (otherwise the button looks enabled
  // but `submitBid` returns without sending anything).
  const effectiveQuantity = selectedCard ? Math.min(quantity, selectedUsable) : 0;

  const submitBid = () => {
    if (!selectedCard || effectiveQuantity < 1) return;
    const selection = `${selectedCard.cardId}:${effectiveQuantity}`;
    if (bidRequestRef.current?.selection !== selection) {
      bidRequestRef.current = { selection, id: crypto.randomUUID() };
    }
    const requestId = bidRequestRef.current.id;
    const changing = myActiveBid !== null;
    void runWrite(
      "bid",
      () => postTradeJson(`/api/trades/auctions/${auctionId}/bids`, {
        bidCardId: selectedCard.cardId,
        quantity: effectiveQuantity,
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
          {effectiveQuantity > 0 && (
            <label className="mt-4 flex items-center gap-3 text-sm text-gray-200">
              {t("auctionBidQuantityLabel")}
              <select
                value={effectiveQuantity}
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
            {selectedCard && effectiveQuantity > 0
              ? t("auctionBidSummary", { card: selectedCard.name, count: effectiveQuantity })
              : t("auctionBidPending")}
          </p>
          <p className="mt-1 text-xs text-gray-400">{t("auctionBidLockNotice")}</p>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={effectiveQuantity < 1 || busy !== null || writeBlocked}
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
                    onClick={(event) => openConfirm({ kind: "withdraw", bid: myActiveBid }, event)}
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
          ref={noticeRef}
          tabIndex={-1}
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
