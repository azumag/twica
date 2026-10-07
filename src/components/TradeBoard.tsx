"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import type { TradeOfferDto, TradeScope } from "@/lib/trade";
import TradeOfferRow from "./TradeOfferRow";
import TradeAcceptModal from "./TradeAcceptModal";

type ListResponse = {
  offers: TradeOfferDto[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

const FILTER_PAGE_BUDGET = 5;

async function fetchOfferPage(
  streamerId: string,
  scope: TradeScope,
  page: number,
): Promise<ListResponse> {
  const params = new URLSearchParams({
    streamerId,
    scope,
    page: String(page),
  });
  const response = await fetch(`/api/trades?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`list failed: ${response.status}`);
  }
  return (await response.json()) as ListResponse;
}

/**
 * トレードボード (#726, §6.3)。
 * - 「チャンネル内」「クロスチャンネル」2タブ (?scope=cross)。
 * - フィルタ: 欲しいカード名 / 出ているカード名 / レアリティ。20件/頁。
 *   フィルタ指定時は最大5頁まで逐次取得してクライアント側で絞り込む
 *   (一覧APIはカードID指定のみのため、名前・レアリティの絞り込みは
 *   クライアント側で行う。MVPの暫定方式)。
 * - 一覧取得エラーは一覧上部のインラインバナー (setMessage 方式、トースト新設なし)。
 * - 未ログインでも閲覧可。
 */
export default function TradeBoard({
  streamerId,
  initialScope,
  crossChannelEnabled,
}: {
  streamerId: string;
  initialScope: TradeScope;
  crossChannelEnabled: boolean;
}) {
  const t = useTranslations("trade");
  const router = useRouter();
  const [scope, setScope] = useState<TradeScope>(initialScope);
  const [page, setPage] = useState(1);
  const [offers, setOffers] = useState<TradeOfferDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [wantedName, setWantedName] = useState("");
  const [offeredName, setOfferedName] = useState("");
  const [rarity, setRarity] = useState("");
  const [acceptTarget, setAcceptTarget] = useState<TradeOfferDto | null>(null);

  const filtersActive = wantedName.trim() !== "" || offeredName.trim() !== "" || rarity !== "";

  const loadPage = useCallback(
    async (nextScope: TradeScope, nextPage: number) => {
      setLoading(true);
      setListError(false);
      try {
        const data = await fetchOfferPage(streamerId, nextScope, nextPage);
        setOffers(data.offers);
        setHasMore(data.hasMore);
        setPage(data.page);
      } catch {
        setListError(true);
      } finally {
        setLoading(false);
      }
    },
    [streamerId],
  );

  // フィルタ指定時は全頁 (上限5頁) を取得してクライアント側で絞り込む
  const loadFiltered = useCallback(async () => {
    setLoading(true);
    setListError(false);
    try {
      const all: TradeOfferDto[] = [];
      for (let p = 1; p <= FILTER_PAGE_BUDGET; p += 1) {
        const data = await fetchOfferPage(streamerId, scope, p);
        all.push(...data.offers);
        if (!data.hasMore) break;
      }
      setOffers(all);
      setHasMore(false);
      setPage(1);
    } catch {
      setListError(true);
    } finally {
      setLoading(false);
    }
  }, [streamerId, scope]);

  useEffect(() => {
    if (filtersActive) {
      void loadFiltered();
    } else {
      void loadPage(scope, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, filtersActive]);

  const switchScope = useCallback(
    (next: TradeScope) => {
      setScope(next);
      setWantedName("");
      setOfferedName("");
      setRarity("");
      router.replace(next === "cross_channel" ? `/trade/${streamerId}?scope=cross` : `/trade/${streamerId}`);
    },
    [router, streamerId],
  );

  const refetch = useCallback(() => {
    if (filtersActive) {
      void loadFiltered();
    } else {
      void loadPage(scope, page);
    }
  }, [filtersActive, loadFiltered, loadPage, scope, page]);

  const visibleOffers = useMemo(() => {
    if (!filtersActive) return offers;
    const wanted = wantedName.trim().toLowerCase();
    const offered = offeredName.trim().toLowerCase();
    return offers.filter((offer) => {
      if (wanted !== "" && !offer.wantedCard.name.toLowerCase().includes(wanted)) return false;
      if (offered !== "" && !offer.offeredCard.name.toLowerCase().includes(offered)) return false;
      if (rarity !== "" && offer.wantedCard.rarity !== rarity && offer.offeredCard.rarity !== rarity) {
        return false;
      }
      return true;
    });
  }, [offers, filtersActive, wantedName, offeredName, rarity]);

  const rarityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const offer of offers) {
      if (offer.wantedCard.rarity) seen.add(offer.wantedCard.rarity);
      if (offer.offeredCard.rarity) seen.add(offer.offeredCard.rarity);
    }
    return [...seen].sort();
  }, [offers]);

  return (
    <div>
      <div role="tablist" className="flex gap-2">
        <button
          type="button"
          role="tab"
          aria-selected={scope === "in_channel"}
          onClick={() => switchScope("in_channel")}
          className={`rounded-lg px-4 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 ${
            scope === "in_channel" ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
          }`}
        >
          {t("tabInChannel")}
        </button>
        {crossChannelEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={scope === "cross_channel"}
            onClick={() => switchScope("cross_channel")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 ${
              scope === "cross_channel" ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {t("tabCrossChannel")}
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2 rounded-xl bg-gray-800 p-4 sm:flex-row">
        <label className="flex flex-1 flex-col gap-1 text-sm text-gray-300">
          {t("filterWantedCard")}
          <input
            type="text"
            value={wantedName}
            onChange={(event) => setWantedName(event.target.value)}
            placeholder={t("filterWantedPlaceholder")}
            className="rounded-lg bg-gray-900 px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-gray-300">
          {t("filterOfferedCard")}
          <input
            type="text"
            value={offeredName}
            onChange={(event) => setOfferedName(event.target.value)}
            placeholder={t("filterOfferedPlaceholder")}
            className="rounded-lg bg-gray-900 px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-gray-300">
          {t("filterRarity")}
          <select
            value={rarity}
            onChange={(event) => setRarity(event.target.value)}
            className="rounded-lg bg-gray-900 px-3 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            <option value="">{t("filterAllRarities")}</option>
            {rarityOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      {listError && (
        <div role="alert" className="mt-4 rounded-xl bg-red-900/60 p-4 text-sm text-red-200">
          <p>{t("errorLoadFailed")}</p>
          <button
            type="button"
            onClick={refetch}
            className="mt-2 rounded-lg bg-red-700 px-3 py-1 font-semibold text-white hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            {t("retryButton")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-4 space-y-3" aria-hidden="true">
          {[0, 1].map((index) => (
            <div key={index} className="h-40 animate-pulse rounded-xl bg-gray-800" />
          ))}
        </div>
      ) : visibleOffers.length === 0 ? (
        <div className="mt-4 rounded-xl bg-gray-800 p-8 text-center">
          <p className="text-gray-300">{t("emptyStateMessage")}</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {visibleOffers.map((offer) => (
            <TradeOfferRow
              key={offer.id}
              offer={offer}
              streamerId={streamerId}
              showStreamerBadges={scope === "cross_channel"}
              onAccept={setAcceptTarget}
              onCancelled={refetch}
              onListError={(messageKey) => {
                if (messageKey === "errorRateLimited" || messageKey === "errorGeneric") {
                  setListError(true);
                }
              }}
            />
          ))}
        </ul>
      )}

      {!filtersActive && !loading && visibleOffers.length > 0 && (
        <div className="mt-4 flex items-center justify-center gap-4">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => void loadPage(scope, page - 1)}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("paginationPrev")}
          </button>
          <span className="text-sm text-gray-400">{t("paginationPage", { page })}</span>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => void loadPage(scope, page + 1)}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("paginationNext")}
          </button>
        </div>
      )}

      {acceptTarget && (
        <TradeAcceptModal
          offer={acceptTarget}
          onClose={() => setAcceptTarget(null)}
          onSettled={refetch}
        />
      )}
    </div>
  );
}
