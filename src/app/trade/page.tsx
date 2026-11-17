import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { parseTradeCollectionSort } from "@/lib/trade";
import { tradeLoginHref } from "@/lib/trade-client";
import {
  loadInitialOpenTradePage,
  loadInitialTradeCollections,
} from "@/lib/trade-page-data";
import MyTrades from "@/components/MyTrades";
import TradeCollections from "@/components/TradeCollections";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /trade hub (#2078, collections #2079).
 *
 * The parent issue (#2076) splits the trade flow into a hub, per-collection
 * listings (#2079) and a unified listing flow (#2080). This page gathers the
 * viewer's current trades (open listings, accepted offers waiting to complete,
 * active bids) and, below them, one section per collection the viewer owns a
 * card of, with that collection's open offers and auctions.
 *
 * Login is required because every panel on this page is viewer-specific. The
 * redirect uses the same tradeLoginHref()/returnTo contract as the old
 * /trade/mine page, so after OAuth the viewer lands on the hub instead of
 * being sent to the dashboard.
 *
 * The trade layout deliberately allows anonymous visitors on /trade/[streamerId]
 * (browse public, act after login); this page opts into the stricter rule by
 * redirecting itself, like the listing flow does.
 *
 * `?sort=newest|ending_soon` is parsed with an allowlist and applied on the
 * server. The per-collection first pages are ranked in SQL, so the first paint
 * already has the requested order; the client only fetches rows 6+ when the
 * viewer expands a section.
 */
export default async function TradeHubPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [session, query] = await Promise.all([getSession(), searchParams]);
  if (!session) {
    redirect(tradeLoginHref("/trade"));
  }
  const sort = parseTradeCollectionSort(query.sort);

  // The heading, the "my trades" first page and the collection summaries are
  // independent, so start all three after the auth decision and before
  // rendering.
  const [t, initialOpen, initialCollections] = await Promise.all([
    getTranslations("trade"),
    loadInitialOpenTradePage(session.twitchUserId),
    loadInitialTradeCollections(session.twitchUserId, sort),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">{t("hubTitle")}</h1>
        <div className="flex flex-col items-end gap-1">
          {/*
           * #2080 will turn this into a link to the unified listing flow. Until
           * that route exists, a disabled button keeps the primary action
           * visible without creating a dead link. aria-disabled is explicit for
           * assistive technology, and aria-describedby exposes the reason even
           * though a native disabled button is not focusable.
           */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-describedby="trade-create-unavailable"
            className="shrink-0 cursor-not-allowed whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white opacity-50"
          >
            {t("hubCreateButton")}
          </button>
          <p id="trade-create-unavailable" className="text-xs text-gray-400">
            {t("hubCreateUnavailable")}
          </p>
        </div>
      </div>

      <section aria-labelledby="trade-my-trades-heading">
        <h2
          id="trade-my-trades-heading"
          className="mb-4 text-xl font-semibold text-white"
        >
          {t("myTradesTitle")}
        </h2>
        {/* Server-rendered first page; other tabs/pages are fetched by the
            client component, exactly as on the former /trade/mine page. */}
        <MyTrades initialOpen={initialOpen} />
      </section>

      {/* #2079: below "my trades", one section per owned collection that has
          at least one open offer/auction. The server already applied the
          sort and the first-five ranking. */}
      <section aria-labelledby="trade-collections-heading" className="mt-10">
        <h2
          id="trade-collections-heading"
          className="mb-4 text-xl font-semibold text-white"
        >
          {t("collectionsTitle")}
        </h2>
        <TradeCollections
          key={sort}
          initialCollections={initialCollections}
          sort={sort}
        />
      </section>
    </div>
  );
}
