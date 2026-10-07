"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { TradeOfferDto, TradeOfferStatus } from "@/lib/trade";
import {
  formatTradeDateTime,
  postTradeJson,
  tradeBoardPath,
  tradeErrorMessageKey,
  viewerSides,
} from "@/lib/trade-client";
import { useTradeList, type TradeListPage } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeCancelModal from "./TradeCancelModal";
import TradeCardSummary from "./TradeCardSummary";
import TradePager from "./TradePager";

const TABS: ReadonlyArray<{ status: TradeOfferStatus; labelKey: string; emptyKey: string }> = [
  { status: "open", labelKey: "myTradesTabOpen", emptyKey: "myTradesEmptyOpen" },
  { status: "completed", labelKey: "myTradesTabCompleted", emptyKey: "myTradesEmptyCompleted" },
  { status: "cancelled", labelKey: "myTradesTabCancelled", emptyKey: "myTradesEmptyCancelled" },
];

/** GET /api/trades/mine URL of one tab page (also the client cache key). */
function myTradesUrl(status: TradeOfferStatus, page: number) {
  return `/api/trades/mine?status=${status}&page=${page}`;
}

/**
 * /trade/mine (§6.6): open / completed / cancelled tabs, paged by the API.
 *
 * Whether an open offer can still be accepted is reported by the API
 * (`tradeable`, #1754 item 4): false once a card definition was deleted or
 * deactivated, or a participating channel's trade setting was turned off. Such
 * rows are marked so the offerer knows to cancel them instead of waiting for an
 * acceptance that can no longer happen. A deleted card definition is called out
 * separately (its name is only a listing-time snapshot).
 *
 * Tab/page results are cached per mount (useTradeList): switching back to a
 * tab shows its rows immediately, and "loading" only appears for a tab page
 * that has never been fetched. `initialOpen` is the first page of the open
 * tab rendered by the server, so the default view needs no client request.
 */
export default function MyTrades({ initialOpen = null }: { initialOpen?: TradeListPage | null }) {
  const t = useTranslations("trade");
  const tMaintenance = useTranslations("maintenance");
  const locale = useLocale();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";
  const [tab, setTab] = useState<TradeOfferStatus>("open");
  const [page, setPage] = useState(1);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState<TradeOfferDto | null>(null);
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);
  // Row button that opened the confirmation dialog (focus returns to it).
  const cancelTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { view: list, retry, invalidate } = useTradeList(myTradesUrl(tab, page), {
    initial: initialOpen ? { url: myTradesUrl("open", 1), page: initialOpen } : null,
    // e.g. the only row of the last page was just cancelled: step back
    // instead of showing the tab's empty state.
    onEmptyPage: setPage,
  });

  const selectTab = (status: TradeOfferStatus) => {
    setTab(status);
    setPage(1);
    setNotice(null);
  };

  /**
   * Open the confirmation dialog for one of the viewer's open offers. Same as
   * the accept flow this is our own dialog (#1754 item 5) instead of
   * window.confirm, so the offer being withdrawn is shown explicitly; the POST
   * still happens in this component (see confirmCancel).
   */
  const openCancelConfirm = (offer: TradeOfferDto, trigger: HTMLButtonElement) => {
    if (cancellingId) return;
    if (writeBlocked) {
      setNotice({ text: tMaintenance("writeDisabled"), isError: true });
      return;
    }
    cancelTriggerRef.current = trigger;
    setConfirmingCancel(offer);
  };

  /** Row button focused again, unless the row is gone (cancel succeeded). */
  const restoreCancelFocus = () => {
    const trigger = cancelTriggerRef.current;
    cancelTriggerRef.current = null;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };

  const closeCancelConfirm = () => {
    setConfirmingCancel(null);
    restoreCancelFocus();
  };

  const cancelOffer = async (offer: TradeOfferDto) => {
    setCancellingId(offer.id);
    setNotice(null);
    const res = await postTradeJson(`/api/trades/${offer.id}/cancel`, {});
    setCancellingId(null);
    if (res.ok) {
      setNotice({ text: t("cancelOfferSuccess"), isError: false });
    } else {
      setNotice({
        text:
          res.maintenanceMessage
          ?? t(res.networkError ? "errorNetwork" : tradeErrorMessageKey(res.code)),
        isError: true,
      });
    }
    // Success or not, the row's state may have changed (e.g. completed by an
    // acceptor meanwhile → TRADE_OFFER_NOT_OPEN), and a cancel moves the row
    // to the cancelled tab and off the board: drop every cached page and
    // refresh this one in the background. A confirmed cancel removes the row
    // right away instead of leaving a stale cancel button on screen.
    invalidate(
      res.ok
        ? (current) => ({
            ...current,
            offers: current.offers.filter((item) => item.id !== offer.id),
          })
        : undefined,
    );
  };

  /** Confirmed in the dialog: perform the cancel and return focus to the row. */
  const confirmCancel = () => {
    const offer = confirmingCancel;
    if (!offer) return;
    setConfirmingCancel(null);
    void cancelOffer(offer).finally(restoreCancelFocus);
  };

  const activeTab = TABS.find((item) => item.status === tab) ?? TABS[0];

  let body: React.ReactNode;
  if (list.status === "loading") {
    body = (
      <p className="py-8 text-center text-gray-400" role="status">
        {t("loading")}
      </p>
    );
  } else if (list.status === "error") {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl bg-red-900/40 p-4 text-sm text-red-200 sm:flex-row sm:justify-between">
        <span>{t("myTradesLoadError")}</span>
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
      <p className="rounded-xl bg-gray-800 p-8 text-center text-gray-400">{t(activeTab.emptyKey)}</p>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {list.offers.map((offer) => {
          const { give, get, partner } = viewerSides(offer);
          const isCompleted = offer.status === "completed";
          // An open offer nobody can accept any more: the API reports it as
          // `tradeable: false` (deleted/inactive card, trade setting off). The
          // deleted-card case gets its own copy, because its name is only a
          // listing-time snapshot.
          const cardDeleted = give.deleted || get.deleted;
          const unavailable = offer.status === "open" && (cardDeleted || offer.tradeable !== true);
          const dateText = isCompleted
            ? t("myTradesCompletedAt", { date: formatTradeDateTime(offer.completedAt ?? offer.updatedAt, locale) })
            : offer.status === "cancelled"
              ? t("myTradesUpdatedAt", { date: formatTradeDateTime(offer.updatedAt, locale) })
              : t("myTradesCreatedAt", { date: formatTradeDateTime(offer.createdAt, locale) });
          return (
            <li key={offer.id} className="rounded-xl bg-gray-800 p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded bg-gray-700 px-2 py-0.5 text-gray-200">
                  {offer.mineRole === "acceptor" ? t("myTradesRoleAcceptor") : t("myTradesRoleOfferer")}
                </span>
                {unavailable && (
                  <span className="rounded bg-yellow-700 px-2 py-0.5 text-yellow-50">
                    {t("myTradesUnavailableBadge")}
                  </span>
                )}
                <span className="text-gray-400">{dateText}</span>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <TradeCardSummary
                    card={give.card}
                    deleted={give.deleted}
                    label={isCompleted ? t("myTradesGave") : t("myTradesGive")}
                  />
                </div>
                <span
                  role="img"
                  aria-label={t("directionIconLabel")}
                  className="self-center text-2xl text-purple-300 max-sm:rotate-90"
                >
                  ⇄
                </span>
                <div className="min-w-0 flex-1">
                  <TradeCardSummary
                    card={get.card}
                    deleted={get.deleted}
                    label={isCompleted ? t("myTradesReceived") : t("myTradesWant")}
                  />
                </div>
              </div>
              {unavailable && (
                <p className="mt-2 text-xs text-yellow-200">
                  {t(cardDeleted ? "myTradesUnavailableHelp" : "myTradesUnavailableHelpNotTradeable")}
                </p>
              )}
              {/* Only open/completed rows have footer content. Omit the whole
                  wrapper for cancelled rows so its border/padding cannot leave
                  an empty action area beneath their preserved trade history. */}
              {(offer.status === "open" || isCompleted) && (
                <div className="mt-3 flex flex-col gap-2 border-t border-gray-700 pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-300">
                    {isCompleted && (
                      <span>
                        {t("myTradesPartner", { name: partner?.twitchDisplayName ?? t("unknownUser") })}
                      </span>
                    )}
                    {offer.status === "open" && (
                      <Link
                        href={tradeBoardPath(
                          offer.offeredStreamerId,
                          offer.isCrossChannel ? "cross_channel" : "in_channel",
                        )}
                        className="text-purple-300 hover:text-purple-200"
                      >
                        {t("myTradesBoardLink")}
                      </Link>
                    )}
                  </div>
                  {offer.status === "open" && offer.mineRole === "offerer" && (
                    <button
                      type="button"
                      onClick={(event) => openCancelConfirm(offer, event.currentTarget)}
                      disabled={cancellingId !== null || writeBlocked}
                      className="rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {cancellingId === offer.id ? t("cancelOfferSubmitting") : t("cancelOfferButton")}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section>
      {/* WAI-ARIA tabs pattern: roving tabindex + Arrow/Home/End keys. */}
      <div
        role="tablist"
        aria-label={t("myTradesTitle")}
        className="mb-4 flex gap-2 overflow-x-auto"
        onKeyDown={(event) => {
          // Leave modified keys (e.g. Alt+Left = browser back) to the browser.
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const index = TABS.findIndex((item) => item.status === tab);
          const next =
            event.key === "ArrowRight" ? (index + 1) % TABS.length
            : event.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length
            : event.key === "Home" ? 0
            : event.key === "End" ? TABS.length - 1
            : null;
          if (next === null) return;
          event.preventDefault();
          selectTab(TABS[next].status);
          document.getElementById(`my-trades-tab-${TABS[next].status}`)?.focus();
        }}
      >
        {TABS.map((item) => {
          const selected = item.status === tab;
          return (
            <button
              key={item.status}
              id={`my-trades-tab-${item.status}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="my-trades-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(item.status)}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm ${
                selected ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>
      {notice && (
        <p
          role={notice.isError ? "alert" : "status"}
          className={`mb-4 rounded-lg p-3 text-sm ${
            notice.isError ? "bg-red-900/40 text-red-200" : "bg-emerald-500/10 text-emerald-100"
          }`}
        >
          {notice.text}
        </p>
      )}
      <div id="my-trades-panel" role="tabpanel" aria-labelledby={`my-trades-tab-${tab}`}>
        {body}
      </div>
      {list.status === "ok" && (
        <TradePager page={page} hasMore={list.hasMore} onPageChange={setPage} />
      )}
      {confirmingCancel && (
        <TradeCancelModal
          offer={confirmingCancel}
          onConfirm={confirmCancel}
          onClose={closeCancelConfirm}
        />
      )}
    </section>
  );
}
