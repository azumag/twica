"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeCollectionSort, TradeOfferDto } from "@/lib/trade";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import type { TradeCollectionSection } from "@/lib/trade-collections";
import {
  tradeAuctionDetailPath,
  tradeLoginHref,
} from "@/lib/trade-client";
import { clearTradeListCache } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeAcceptModal from "./TradeAcceptModal";
import TradeAuctionRow from "./TradeAuctionRow";
import TradeOfferRow from "./TradeOfferRow";

type ExpandedKind =
  | { kind: "offer"; offers: TradeOfferDto[]; total: number; hasMore: boolean; page: number }
  | { kind: "auction"; auctions: TradeAuctionDto[]; total: number; hasMore: boolean; page: number };

function expandKey(kind: "offer" | "auction", streamerId: string) {
  return `${kind}:${streamerId}`;
}

/**
 * Append the next API page without repeating a row that was already shown.
 *
 * Pages are offset-based (page N = rows (N-1)*TRADE_PAGE_SIZE+1..), so a row
 * created or removed between two requests can shift across the page boundary
 * and appear on both pages. The UI must not show such a row twice, hence the
 * id filter instead of a plain concat. The first page replaces the preview
 * (no append), so this only runs for page >= 2.
 */
function appendUniqueById<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...next.filter((row) => !seen.has(row.id))];
}

const subscribeToHydration = () => () => {};

/**
 * False during SSR, true after hydration. The collection rows reuse
 * <TradeOfferRow> / <TradeAuctionRow>, which were written for client-only
 * lists: the former formats the creation time in the viewer's local time
 * zone, and <TradeAuctionTimeLeft> starts from `Date.now()`. Rendering them
 * in the server HTML would produce a hydration mismatch, so the first
 * server paint shows the section's loading state; the server-fetched data is
 * still passed as props (no extra request after hydration).
 */
function useIsClient() {
  return useSyncExternalStore(subscribeToHydration, () => true, () => false);
}

/**
 * ハブのコレクション別出品一覧 (#2079)。
 *
 * 1コレクションの中は「トレード」と「オークション」の2つの小さな一覧に
 * 分ける。どちらも既存の TradeOfferRow / TradeAuctionRow をそのまま使い、
 * 応諾は既存の TradeAcceptModal、オークションは既存の詳細画面へ送る。
 * 新しい行コンポーネントや新しい DTO は作らない（可視性の処理を作り直すと
 * 漏えいの面積が増えるため）。
 *
 * 先頭5件はサーバーが SQL の ROW_NUMBER() で返す。6件目以降は
 * GET /api/trades/collections/[streamerId] を展開時に1ページ取得し、さらに
 * 「さらに表示」で page+1 を取得して末尾へ追記する。この API は折りたたみ時と
 * 同じサービス関数を配信者1件・TRADE_PAGE_SIZE 件で呼ぶので、条件・並び・DTO が
 * ずれない。以前は残りを /trade/[streamerId] のチャネル内タブへリンクしていたが、
 * この一覧にはクロスチャネル出品も混ざるため、そのタブでは残りに到達できなかった
 * (#2079 レビュー)。ページ間で件数が動いても同じ行を二重に表示しないよう、
 * 追記時は id で重複を除き、API の hasMore が false になったらボタンを消す。
 *
 * ソートはサーバー側で行う（先頭5件がソートで変わるため）。この
 * コンポーネントは select の変更を URL に反映してサーバー再描画を促すだけ。
 * `ending_soon` はオークションにだけ効き、トレードは新着順のまま。
 *
 * 幅が狭いときにラベル・件数・ボタンが1文字ずつ折り返される不具合
 * (#2083) を避けるため、それらには shrink-0 whitespace-nowrap を付け、
 * 操作のまとまりは flex min-w-0 flex-wrap items-center gap-2 にする。
 */
export default function TradeCollections({
  initialCollections,
  sort,
}: {
  /** null: 取得失敗（サーバー側の prefetch が縮退した）。[]: 出品0件。 */
  initialCollections: TradeCollectionSection[] | null;
  sort: TradeCollectionSort;
}) {
  const t = useTranslations("trade");
  const router = useRouter();
  const isClient = useIsClient();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";

  const [expanded, setExpanded] = useState<Record<string, ExpandedKind>>({});
  // A section loads at most one page at a time, but different sections can be
  // expanded concurrently, so the in-flight flag is per section (key) rather
  // than a single value. The ref is the synchronous duplicate-click guard: the
  // disabled attribute only lands after React re-renders.
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const inFlightKeys = useRef(new Set<string>());
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // Offers accepted from this page disappear immediately; router.refresh()
  // then replaces the server props. Keep the request ids per offer so a retry
  // after a lost success response is an idempotent replay (same as the board).
  const [hiddenOfferIds, setHiddenOfferIds] = useState<ReadonlySet<string>>(new Set());
  const [accepting, setAccepting] = useState<{ offer: TradeOfferDto; requestId: string } | null>(null);
  const acceptRequestIds = useRef(new Map<string, string>());
  const acceptTriggerRef = useRef<HTMLButtonElement | null>(null);
  const completedOfferId = useRef<string | null>(null);
  const mounted = useRef(true);
  const previousInitialCollections = useRef(initialCollections);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // A server refresh can change what the viewer can accept: cancelling a
    // listing in <MyTrades> releases the offered card, and accepting here
    // consumes one. The preview follows the new server props, but pages
    // fetched through the expand API keep the old canAccept flags, so drop
    // them when the prefetched sections change. The first render is skipped
    // (the ref already holds that prop).
    if (previousInitialCollections.current === initialCollections) return;
    previousInitialCollections.current = initialCollections;
    setExpanded({});
    setErrorKey(null);
  }, [initialCollections]);

  const changeSort = (value: string) => {
    const next = new URLSearchParams();
    if (value === "ending_soon") next.set("sort", "ending_soon");
    const query = next.toString();
    router.push(query ? `/trade?${query}` : "/trade");
  };

  const setSectionLoading = (key: string, loading: boolean) => {
    setLoadingKeys((current) => {
      const next = new Set(current);
      if (loading) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /**
   * Load one API page for a section. page 1 replaces the 5-row preview (the
   * expand button); page > 1 appends (the "load more" button and its retry).
   *
   * A failure keeps the rows already on screen: the component only records
   * errorKey, and the error block's retry calls this function again with the
   * same page (page 1 when nothing was expanded yet, otherwise
   * expanded.page + 1), so an append retry does not restart at page 1.
   */
  const loadExpanded = async (
    kind: "offer" | "auction",
    streamerId: string,
    page: number,
  ) => {
    const key = expandKey(kind, streamerId);
    // Two rapid clicks can both run before the disabled button re-renders.
    // Return before issuing the same page twice; the first request's finally
    // clears the guard.
    if (inFlightKeys.current.has(key)) return;
    inFlightKeys.current.add(key);
    setSectionLoading(key, true);
    setErrorKey(null);
    try {
      const query = new URLSearchParams({ kind, sort, page: String(page) });
      const res = await fetch(
        `/api/trades/collections/${streamerId}?${query.toString()}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!res.ok) throw new Error("trade collection page request failed");
      const data = (await res.json()) as {
        offers?: TradeOfferDto[];
        auctions?: TradeAuctionDto[];
        total?: number;
        hasMore?: boolean;
      };
      if (!mounted.current) return;
      const offers = Array.isArray(data.offers) ? data.offers : [];
      const auctions = Array.isArray(data.auctions) ? data.auctions : [];
      const total = Number(data.total ?? 0);
      const hasMore = data.hasMore === true;
      setExpanded((current) => {
        const previous = current[key];
        // A continuation only appends to the section that requested it. If
        // the viewer collapsed the section (or an accept reset every expanded
        // page) while this request was in flight, previous is gone; discard
        // the page instead of re-expanding with page 2+ missing page 1.
        if (page > 1) {
          if (previous?.kind === "offer" && kind === "offer") {
            return {
              ...current,
              [key]: {
                kind: "offer",
                offers: appendUniqueById(previous.offers, offers),
                total,
                hasMore,
                page,
              },
            };
          }
          if (previous?.kind === "auction" && kind === "auction") {
            return {
              ...current,
              [key]: {
                kind: "auction",
                auctions: appendUniqueById(previous.auctions, auctions),
                total,
                hasMore,
                page,
              },
            };
          }
          return current;
        }
        // The initial expand replaces the 5-row preview.
        return {
          ...current,
          [key]: kind === "offer"
            ? { kind: "offer", offers, total, hasMore, page }
            : { kind: "auction", auctions, total, hasMore, page },
        };
      });
    } catch {
      if (mounted.current) setErrorKey(key);
    } finally {
      inFlightKeys.current.delete(key);
      if (mounted.current) setSectionLoading(key, false);
    }
  };

  const collapse = (kind: "offer" | "auction", streamerId: string) => {
    const key = expandKey(kind, streamerId);
    setExpanded((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (errorKey === key) setErrorKey(null);
  };

  const openAccept = (offer: TradeOfferDto, trigger: HTMLButtonElement) => {
    let requestId = acceptRequestIds.current.get(offer.id);
    if (!requestId) {
      requestId = crypto.randomUUID();
      acceptRequestIds.current.set(offer.id, requestId);
    }
    acceptTriggerRef.current = trigger;
    setAccepting({ offer, requestId });
  };

  const closeAccept = ({ refetch }: { refetch: boolean }) => {
    setAccepting(null);
    const trigger = acceptTriggerRef.current;
    acceptTriggerRef.current = null;
    const completed = completedOfferId.current;
    completedOfferId.current = null;
    if (refetch) {
      if (completed) {
        setHiddenOfferIds((current) => new Set(current).add(completed));
        acceptRequestIds.current.delete(completed);
      }
      // The accept also changes the hub's "my trades" rows. That panel keeps
      // its pages in a per-mount useTradeList cache, which this module-level
      // clear cannot reach, but the hub gives <MyTrades> a request-scoped key:
      // the router.refresh() below re-renders the server page with a new key
      // and remounts the panel, discarding its cache. clearTradeListCache()
      // still drops the board's shared browser cache (e.g. the board the
      // viewer opens later), exactly like the board's own accept path.
      clearTradeListCache();
      // Ownership and the collection totals changed: drop the expanded pages
      // (they were ranked under the previous ownership) and re-render the
      // server section from the same service functions. The parent remounts
      // this component on a sort change via key={sort}, so no effect is needed.
      setExpanded({});
      setErrorKey(null);
      router.refresh();
    } else if (trigger) {
      requestAnimationFrame(() => {
        if (trigger.isConnected) trigger.focus();
      });
    }
  };

  const sortSelect = (
    <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
      <label
        htmlFor="trade-collection-sort"
        className="shrink-0 whitespace-nowrap text-sm text-gray-300"
      >
        {t("collectionSortLabel")}
      </label>
      <select
        id="trade-collection-sort"
        value={sort}
        onChange={(event) => changeSort(event.target.value)}
        className="min-w-0 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
      >
        <option value="newest">{t("collectionSortNewest")}</option>
        <option value="ending_soon">{t("collectionSortEndingSoon")}</option>
      </select>
      <span className="min-w-0 text-xs text-gray-400">{t("collectionSortHelp")}</span>
    </div>
  );

  if (!isClient) {
    return (
      <div>
        {sortSelect}
        <p className="py-8 text-center text-gray-400" role="status">
          {t("loading")}
        </p>
      </div>
    );
  }

  if (initialCollections === null) {
    return (
      <div>
        {sortSelect}
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl bg-red-900/40 p-4 text-sm text-red-200 sm:flex-row sm:justify-between"
        >
          <span>{t("collectionsLoadError")}</span>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600"
          >
            {t("retryButton")}
          </button>
        </div>
      </div>
    );
  }

  if (initialCollections.length === 0) {
    return (
      <div>
        {sortSelect}
        <p className="rounded-xl bg-gray-800 p-8 text-center text-gray-400">
          {t("collectionsEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div>
      {sortSelect}
      <div className="flex flex-col gap-6">
        {initialCollections.map((collection) => {
          const streamerId = collection.streamer.id;
          const offerKey = expandKey("offer", streamerId);
          const auctionKey = expandKey("auction", streamerId);
          const expandedOffers = expanded[offerKey];
          const expandedAuctions = expanded[auctionKey];
          const offers = expandedOffers?.kind === "offer"
            ? expandedOffers.offers.filter((offer) => !hiddenOfferIds.has(offer.id))
            : collection.offers.filter((offer) => !hiddenOfferIds.has(offer.id));
          const offerTotal = expandedOffers?.kind === "offer"
            ? expandedOffers.total
            : collection.offerTotal;
          const offerHasMore = expandedOffers?.kind === "offer"
            ? expandedOffers.hasMore
            : collection.offerTotal > collection.offers.length;
          const auctions = expandedAuctions?.kind === "auction"
            ? expandedAuctions.auctions
            : collection.auctions;
          const auctionTotal = expandedAuctions?.kind === "auction"
            ? expandedAuctions.total
            : collection.auctionTotal;
          const auctionHasMore = expandedAuctions?.kind === "auction"
            ? expandedAuctions.hasMore
            : collection.auctionTotal > collection.auctions.length;

          return (
            <section
              key={streamerId}
              aria-labelledby={`trade-collection-${streamerId}`}
              className="rounded-xl border border-gray-700 p-4"
            >
              <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
                <h3
                  id={`trade-collection-${streamerId}`}
                  className="min-w-0 break-words text-lg font-semibold text-white"
                >
                  {collection.streamer.twitchDisplayName}
                </h3>
              </div>

              {collection.offerTotal > 0 && (
                <div className="mb-5">
                  <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                    <h4 className="shrink-0 whitespace-nowrap text-sm font-semibold text-purple-200">
                      {t("collectionOffersTitle")}
                    </h4>
                    <span className="shrink-0 whitespace-nowrap rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-200">
                      {t("collectionOfferCount", { count: offerTotal })}
                    </span>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {expandedOffers?.kind !== "offer" && offerHasMore && (
                        <button
                          type="button"
                          onClick={() => void loadExpanded("offer", streamerId, 1)}
                          disabled={loadingKeys.has(offerKey)}
                          className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingKeys.has(offerKey)
                            ? t("collectionExpanding")
                            : t("collectionExpand", { count: offerTotal })}
                        </button>
                      )}
                      {expandedOffers?.kind === "offer" && (
                        <>
                          <button
                            type="button"
                            onClick={() => collapse("offer", streamerId)}
                            className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600"
                          >
                            {t("collectionCollapse")}
                          </button>
                          {offerHasMore && (
                            <button
                              type="button"
                              onClick={() => void loadExpanded("offer", streamerId, expandedOffers.page + 1)}
                              disabled={loadingKeys.has(offerKey)}
                              className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {loadingKeys.has(offerKey)
                                ? t("collectionExpanding")
                                : t("collectionLoadMore")}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {errorKey === offerKey && (
                    <div role="alert" className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-sm text-red-200">
                      <span>{t("collectionsLoadError")}</span>
                      <button
                        type="button"
                        onClick={() => void loadExpanded(
                          "offer",
                          streamerId,
                          expandedOffers?.kind === "offer" ? expandedOffers.page + 1 : 1,
                        )}
                        disabled={loadingKeys.has(offerKey)}
                        className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("retryButton")}
                      </button>
                    </div>
                  )}
                  {offers.length > 0 ? (
                    <ul className="flex flex-col gap-3">
                      {offers.map((offer) => (
                        <TradeOfferRow
                          key={offer.id}
                          offer={offer}
                          showStreamers={offer.isCrossChannel}
                          isLoggedIn
                          loginHref={tradeLoginHref("/trade")}
                          writeBlocked={writeBlocked}
                          onAccept={openAccept}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg bg-gray-800 p-4 text-center text-sm text-gray-400">
                      {t("collectionOffersEmpty")}
                    </p>
                  )}
                </div>
              )}

              {collection.auctionTotal > 0 && (
                <div>
                  <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                    <h4 className="shrink-0 whitespace-nowrap text-sm font-semibold text-purple-200">
                      {t("collectionAuctionsTitle")}
                    </h4>
                    <span className="shrink-0 whitespace-nowrap rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-200">
                      {t("collectionAuctionCount", { count: auctionTotal })}
                    </span>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {expandedAuctions?.kind !== "auction" && auctionHasMore && (
                        <button
                          type="button"
                          onClick={() => void loadExpanded("auction", streamerId, 1)}
                          disabled={loadingKeys.has(auctionKey)}
                          className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingKeys.has(auctionKey)
                            ? t("collectionExpanding")
                            : t("collectionExpand", { count: auctionTotal })}
                        </button>
                      )}
                      {expandedAuctions?.kind === "auction" && (
                        <>
                          <button
                            type="button"
                            onClick={() => collapse("auction", streamerId)}
                            className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600"
                          >
                            {t("collectionCollapse")}
                          </button>
                          {auctionHasMore && (
                            <button
                              type="button"
                              onClick={() => void loadExpanded("auction", streamerId, expandedAuctions.page + 1)}
                              disabled={loadingKeys.has(auctionKey)}
                              className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {loadingKeys.has(auctionKey)
                                ? t("collectionExpanding")
                                : t("collectionLoadMore")}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {errorKey === auctionKey && (
                    <div role="alert" className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-sm text-red-200">
                      <span>{t("collectionsLoadError")}</span>
                      <button
                        type="button"
                        onClick={() => void loadExpanded(
                          "auction",
                          streamerId,
                          expandedAuctions?.kind === "auction" ? expandedAuctions.page + 1 : 1,
                        )}
                        disabled={loadingKeys.has(auctionKey)}
                        className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("retryButton")}
                      </button>
                    </div>
                  )}
                  {auctions.length > 0 ? (
                    <ul className="flex flex-col gap-3">
                      {auctions.map((auction) => (
                        <TradeAuctionRow
                          key={auction.id}
                          auction={auction}
                          showStreamer={false}
                          detailHref={tradeAuctionDetailPath(streamerId, auction.id)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg bg-gray-800 p-4 text-center text-sm text-gray-400">
                      {t("collectionAuctionsEmpty")}
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {accepting && (
        <TradeAcceptModal
          offer={accepting.offer}
          requestId={accepting.requestId}
          writeBlocked={writeBlocked}
          onCompleted={() => {
            completedOfferId.current = accepting.offer.id;
          }}
          onClose={closeAccept}
        />
      )}
    </div>
  );
}
