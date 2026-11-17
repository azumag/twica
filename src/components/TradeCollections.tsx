"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeCollectionSort, TradeOfferDto } from "@/lib/trade";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import type { TradeCollectionSection } from "@/lib/trade-collections";
import {
  tradeAuctionBoardPath,
  tradeAuctionDetailPath,
  tradeBoardPath,
  tradeLoginHref,
} from "@/lib/trade-client";
import { clearTradeListCache } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeAcceptModal from "./TradeAcceptModal";
import TradeAuctionRow from "./TradeAuctionRow";
import TradeOfferRow from "./TradeOfferRow";

type ExpandedKind =
  | { kind: "offer"; offers: TradeOfferDto[]; total: number; hasMore: boolean }
  | { kind: "auction"; auctions: TradeAuctionDto[]; total: number; hasMore: boolean };

function expandKey(kind: "offer" | "auction", streamerId: string) {
  return `${kind}:${streamerId}`;
}

function boardHref(kind: "offer" | "auction", streamerId: string) {
  return kind === "offer"
    ? tradeBoardPath(streamerId, "in_channel")
    : tradeAuctionBoardPath(streamerId, "in_channel");
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
 * GET /api/trades/collections/[streamerId] を展開時に1ページだけ取得する。
 * この API は折りたたみ時と同じサービス関数を配信者1件・TRADE_PAGE_SIZE 件で
 * 呼ぶので、条件・並び・DTO がずれない。TRADE_PAGE_SIZE を超える分は
 * 既存の /trade/[streamerId] ボードへのリンクにする（この画面で無限に
 * ページングしない）。
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
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const changeSort = (value: string) => {
    const next = new URLSearchParams();
    if (value === "ending_soon") next.set("sort", "ending_soon");
    const query = next.toString();
    router.push(query ? `/trade?${query}` : "/trade");
  };

  const loadExpanded = async (kind: "offer" | "auction", streamerId: string) => {
    const key = expandKey(kind, streamerId);
    setLoadingKey(key);
    setErrorKey(null);
    try {
      const query = new URLSearchParams({ kind, sort, page: "1" });
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
      setExpanded((current) => ({
        ...current,
        [key]: kind === "offer"
          ? {
            kind: "offer",
            offers: Array.isArray(data.offers) ? data.offers : [],
            total: Number(data.total ?? 0),
            hasMore: data.hasMore === true,
          }
          : {
            kind: "auction",
            auctions: Array.isArray(data.auctions) ? data.auctions : [],
            total: Number(data.total ?? 0),
            hasMore: data.hasMore === true,
          },
      }));
    } catch {
      if (mounted.current) setErrorKey(key);
    } finally {
      if (mounted.current) setLoadingKey(null);
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
      // The trade lists rendered elsewhere on this page (the "my trades"
      // panel) share the useTradeList browser cache. An accept changes those
      // rows too, so drop the cache exactly like the board's accept path.
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
                          onClick={() => void loadExpanded("offer", streamerId)}
                          disabled={loadingKey === offerKey}
                          className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingKey === offerKey
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
                            <Link
                              href={boardHref("offer", streamerId)}
                              className="shrink-0 whitespace-nowrap text-xs text-purple-300 hover:text-purple-200"
                            >
                              {t("collectionMoreLink")}
                            </Link>
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
                        onClick={() => void loadExpanded("offer", streamerId)}
                        className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600"
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
                          onClick={() => void loadExpanded("auction", streamerId)}
                          disabled={loadingKey === auctionKey}
                          className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingKey === auctionKey
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
                            <Link
                              href={boardHref("auction", streamerId)}
                              className="shrink-0 whitespace-nowrap text-xs text-purple-300 hover:text-purple-200"
                            >
                              {t("collectionMoreLink")}
                            </Link>
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
                        onClick={() => void loadExpanded("auction", streamerId)}
                        className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-600"
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
