"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { TradeOfferDto, TradeScope } from "@/lib/trade";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeOfferRow from "./TradeOfferRow";
import TradeAcceptModal from "./TradeAcceptModal";
import TradePager from "./TradePager";

/** Filter option. Only cards already visible to the viewer are ever passed. */
export type TradeBoardFilterCard = { cardId: string; name: string };

interface TradeBoardProps {
  streamerId: string;
  scope: TradeScope;
  isLoggedIn: boolean;
  /**
   * The channel shows unowned cards with details. When false the API only
   * returns offers whose cards the viewer owns (design doc §3 visibility), so
   * the board says so explicitly and uses a dedicated empty state.
   */
  revealsUnownedCards: boolean;
  /** In-channel tab only (cross tab has no card filter in the MVP). */
  filterCards: TradeBoardFilterCard[];
  /** Login URL returning to this exact board (scope included). */
  loginHref: string;
  /** Listing flow URL (or login URL for anonymous viewers). */
  createHref: string;
  /** Arrived right after creating an offer (?listed=1). */
  justListed?: boolean;
}

/** Result of one GET /api/trades call, tagged with the query it answers. */
const CTA_CLASS =
  "mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700";

type ListResult =
  | { key: string; status: "error" }
  | { key: string; status: "ok"; offers: TradeOfferDto[]; hasMore: boolean };

/**
 * Trade board list (§6.3).
 *
 * Offers are fetched from the browser through GET /api/trades instead of
 * being rendered by the server component: the endpoint's tradeRead rate
 * limit is the abuse guard for this public, login-optional list, and SSR
 * calling listTradeOffers directly would bypass it.
 */
export default function TradeBoard({
  streamerId,
  scope,
  isLoggedIn,
  revealsUnownedCards,
  filterCards,
  loginHref,
  createHref,
  justListed = false,
}: TradeBoardProps) {
  const t = useTranslations("trade");
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";
  const [page, setPage] = useState(1);
  const [wantedCardId, setWantedCardId] = useState("");
  const [offeredCardId, setOfferedCardId] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<ListResult | null>(null);
  const [accepting, setAccepting] = useState<{ offer: TradeOfferDto; requestId: string } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // offerId → requestId. Kept across dialog close/reopen and failed attempts
  // (network error, TRADE_BUSY, CSRF retry...) so a retried accept that the
  // server already committed is answered as an idempotent replay instead of
  // being treated as a second trade. Dropped only after a confirmed success.
  // Known limitation: the map lives in memory, so a reload/tab switch after a
  // lost success response yields "already completed" on retry instead of the
  // replayed success. Ownership is still transferred exactly once.
  const acceptRequestIds = useRef(new Map<string, string>());

  const showCardFilter = scope === "in_channel" && filterCards.length > 0;
  const isFiltered = scope === "in_channel" && (wantedCardId !== "" || offeredCardId !== "");

  const params = new URLSearchParams({ streamerId, scope, page: String(page) });
  if (scope === "in_channel") {
    if (wantedCardId) params.set("wantedCardId", wantedCardId);
    if (offeredCardId) params.set("offeredCardId", offeredCardId);
  }
  // reloadToken is part of the key so "retry"/refetch after a trade shows the
  // loading state again even though the URL itself is unchanged.
  const queryKey = `${params.toString()}#${reloadToken}`;
  // Loading is derived (the latest result answers an older query) instead of
  // being set synchronously inside the effect.
  const list: ListResult | { status: "loading" } =
    result && result.key === queryKey ? result : { status: "loading" };

  useEffect(() => {
    const controller = new AbortController();
    const [query] = queryKey.split("#");
    fetch(`/api/trades?${query}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { offers?: TradeOfferDto[]; hasMore?: boolean };
        // A superseded query must not move the page or overwrite the result.
        if (controller.signal.aborted) return;
        const offers = Array.isArray(data.offers) ? data.offers : [];
        const requestedPage = Number(new URLSearchParams(query).get("page"));
        if (offers.length === 0 && requestedPage > 1) {
          // The last row(s) of a later page were accepted/cancelled meanwhile:
          // step back instead of showing the "no offers yet" empty state.
          setPage(requestedPage - 1);
          return;
        }
        setResult({
          key: queryKey,
          status: "ok",
          offers,
          hasMore: data.hasMore === true,
        });
      })
      .catch(() => {
        // An aborted request belongs to a superseded query; its result must not
        // overwrite the newer one.
        if (!controller.signal.aborted) setResult({ key: queryKey, status: "error" });
      });
    return () => controller.abort();
  }, [queryKey]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    if (!justListed) return;
    // Drop ?listed=1 from the address bar so a reload does not show the
    // "listed" notice again (no navigation / server re-render).
    const url = new URL(window.location.href);
    url.searchParams.delete("listed");
    window.history.replaceState(window.history.state, "", url);
  }, [justListed]);

  const openAccept = (offer: TradeOfferDto, trigger: HTMLButtonElement) => {
    let requestId = acceptRequestIds.current.get(offer.id);
    if (!requestId) {
      requestId = crypto.randomUUID();
      acceptRequestIds.current.set(offer.id, requestId);
    }
    triggerRef.current = trigger;
    setAccepting({ offer, requestId });
  };

  const closeAccept = ({ refetch }: { refetch: boolean }) => {
    setAccepting(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (refetch) {
      reload();
    } else if (trigger) {
      // Return focus to the row's button (same as CardManager's zoom dialog).
      requestAnimationFrame(() => {
        if (trigger.isConnected) trigger.focus();
      });
    }
  };

  const changeFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const selectClass =
    "w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400";

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
        <span>{t("loadError")}</span>
        <button
          type="button"
          onClick={reload}
          className="rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600"
        >
          {t("retryButton")}
        </button>
      </div>
    );
  } else if (list.offers.length === 0) {
    // Three distinct empty states: a filter matched nothing; the channel hides
    // unowned cards (so "no offers" only means "none with your cards"); or the
    // board is genuinely empty (invite the first listing, §6.8).
    body = (
      <div className="rounded-xl bg-gray-800 p-8 text-center">
        {isFiltered ? (
          <p className="text-gray-400">{t("emptyStateFiltered")}</p>
        ) : !revealsUnownedCards ? (
          <p className="text-gray-400">{t("emptyStateUnrevealed")}</p>
        ) : (
          <>
            <p className="text-gray-400">{t("emptyStateMessage")}</p>
            {/* Anonymous: createHref is the OAuth API route → plain <a> (no prefetch). */}
            {isLoggedIn ? (
              <Link href={createHref} className={CTA_CLASS}>
                {t("emptyStateCta")}
              </Link>
            ) : (
              <a href={createHref} className={CTA_CLASS}>
                {t("emptyStateCta")}
              </a>
            )}
          </>
        )}
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {list.offers.map((offer) => (
          <TradeOfferRow
            key={offer.id}
            offer={offer}
            showStreamers={scope === "cross_channel"}
            isLoggedIn={isLoggedIn}
            loginHref={loginHref}
            writeBlocked={writeBlocked}
            onAccept={openAccept}
          />
        ))}
      </ul>
    );
  }

  return (
    <section>
      {justListed && (
        <div role="status" className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          <p>{t("listedNotice")}</p>
        </div>
      )}
      {!revealsUnownedCards && (
        <p className="mb-4 rounded-xl border border-gray-600 bg-gray-800 p-3 text-sm text-gray-300">
          {t("unrevealedNotice")}
        </p>
      )}
      {showCardFilter && (
        <fieldset className="mb-4 grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t("filterLabel")}</legend>
          <label className="text-sm text-gray-300">
            {t("filterWantedCard")}
            <select
              className={`mt-1 ${selectClass}`}
              value={wantedCardId}
              onChange={(event) => changeFilter(setWantedCardId, event.target.value)}
            >
              <option value="">{t("filterAll")}</option>
              {filterCards.map((card) => (
                <option key={card.cardId} value={card.cardId}>
                  {card.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-300">
            {t("filterOfferedCard")}
            <select
              className={`mt-1 ${selectClass}`}
              value={offeredCardId}
              onChange={(event) => changeFilter(setOfferedCardId, event.target.value)}
            >
              <option value="">{t("filterAll")}</option>
              {filterCards.map((card) => (
                <option key={card.cardId} value={card.cardId}>
                  {card.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}

      {body}

      {list.status === "ok" && (
        <TradePager page={page} hasMore={list.hasMore} onPageChange={setPage} />
      )}

      {accepting && (
        <TradeAcceptModal
          offer={accepting.offer}
          requestId={accepting.requestId}
          writeBlocked={writeBlocked}
          onCompleted={() => acceptRequestIds.current.delete(accepting.offer.id)}
          onClose={closeAccept}
        />
      )}
    </section>
  );
}
