import Link from "next/link";
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

  /*
   * Remount <MyTrades> on every server render (#2079 review).
   *
   * The panel's open/completed/cancelled pages live in a per-mount
   * useTradeList cache. That cache intentionally ignores a changed `initial`
   * prop after mount, so router.refresh() alone would update the server props
   * (`initialOpen`) but leave the rows on screen unchanged. A key that changes
   * per request makes the refresh replace the component instance as well, so
   * the new props seed a fresh cache. The page reads the session, so it is
   * dynamic and every refresh is a new render/request.
   *
   * Tradeoff: remounting resets the panel's local UI state, i.e. the selected
   * tab returns to "open" (and the page to 1) after a refresh caused by a
   * mutation elsewhere on the page. That is preferable to showing a completed
   * trade as still open, and it matches the previous /trade/mine behaviour of
   * loading the open tab first.
   *
   * A random nonce is used instead of Date.now() because two refreshes can
   * share the same millisecond; the key only needs to differ from the previous
   * render (it is never persisted or sent to the browser as data).
   */
  const myTradesKey = crypto.randomUUID();

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">{t("hubTitle")}</h1>
        {/*
         * #2080: the primary action is a real link into the unified listing
         * flow. It is a <Link> (not a button with a router call) so it is
         * keyboard/middle-click friendly and can be prefetched.
         */}
        <Link
          href="/trade/new"
          className="shrink-0 whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-purple-700"
        >
          {t("hubCreateButton")}
        </Link>
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
        <MyTrades key={myTradesKey} initialOpen={initialOpen} />
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
