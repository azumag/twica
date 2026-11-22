import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { CARD_TRADE_UI_VISIBLE } from "@/lib/constants";
import { parseTradeCollectionSort } from "@/lib/trade";
import { tradeLoginHref } from "@/lib/trade-client";
import {
  loadInitialOpenTradePage,
  loadInitialTradeCollections,
} from "@/lib/trade-page-data";
import MyTrades from "@/components/MyTrades";
import TradeCollections from "@/components/TradeCollections";
import TradeGuideLink from "@/components/TradeGuideLink";
import TradeListedNotice, {
  type TradeListedKind,
} from "@/components/TradeListedNotice";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Allowlist of the post-create `?listed` values (#2080).
 *
 * Only the unified create form produces `offer` / `auction`; anything else
 * (including a repeated parameter, which Next hands over as an array) is
 * ignored rather than rendered, so an arbitrary query string can never inject
 * a notice. The old board used `?listed=1` and is intentionally not accepted:
 * it has no kind, so the hub could not choose the right copy.
 */
function parseTradeListed(
  value: string | string[] | undefined,
): TradeListedKind | null {
  return value === "offer" || value === "auction" ? value : null;
}

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
 *
 * `?listed=offer|auction` is the one-shot confirmation the unified create form
 * adds to its redirect (#2080). It is shown below the heading, above "my
 * trades", and stripped from the URL by <TradeListedNotice> after paint, the
 * same contract the old boards used for `?listed=1`.
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
  const listed = parseTradeListed(query.listed);

  // The heading, the "my trades" first page and the collection summaries are
  // independent, so start all three after the auth decision and before
  // rendering.
  const [t, tGuide, initialOpen, initialCollections] = await Promise.all([
    getTranslations("trade"),
    getTranslations("tradeGuidePage"),
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
    <>
      <div className={`mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${
        CARD_TRADE_UI_VISIBLE ? "lg:justify-end" : ""
      }`}>
        {/* Direct visits to the hub remain possible while the nav item is hidden. */}
        <h1 className={`text-2xl font-bold text-white ${CARD_TRADE_UI_VISIBLE ? "lg:sr-only" : ""}`}>
          {t("hubTitle")}
        </h1>
        {/*
         * #2080: the primary action is a real link into the unified listing
         * flow. It is a <Link> (not a button with a router call) so it is
         * keyboard/middle-click friendly and can be prefetched.
         * Help and the primary action share the title row when there is room,
         * and wrap below it for longer translations or narrower viewports.
         */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <TradeGuideLink label={tGuide("entryLink")} />
          <Link
            href="/trade/new"
            className="shrink-0 whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-purple-700"
          >
            {t("hubCreateButton")}
          </Link>
        </div>
      </div>

      {/*
       * #2080: the create form's post-success destination. Rendered above "my
       * trades", where the viewer looks for the listing they just created.
       *
       * The component is intentionally not keyed: a router.refresh() (e.g.
       * after a mutation in MyTrades) re-renders this server page, but by then
       * the component's replaceState has already removed `listed` from the
       * URL, so the next render omits the notice. A one-shot confirmation
       * disappearing on refresh is acceptable; showing it again is not.
       */}
      {listed && <TradeListedNotice kind={listed} />}

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
    </>
  );
}
