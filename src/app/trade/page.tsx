import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { tradeLoginHref } from "@/lib/trade-client";
import { loadInitialOpenTradePage } from "@/lib/trade-page-data";
import MyTrades from "@/components/MyTrades";

/**
 * /trade hub (#2078).
 *
 * The parent issue (#2076) splits the trade flow into a hub, per-collection
 * listings (#2079) and a unified listing flow (#2080). This page is only the
 * skeleton: it gathers the viewer's current trades (open listings, accepted
 * offers waiting to complete, active bids). The collection-specific listing
 * section (#2079) is intentionally not rendered yet: no collection query and no
 * placeholder data are created in this change.
 *
 * Login is required because every panel on this page is viewer-specific. The
 * redirect uses the same tradeLoginHref()/returnTo contract as the old
 * /trade/mine page, so after OAuth the viewer lands on the hub instead of
 * being sent to the dashboard.
 *
 * The trade layout deliberately allows anonymous visitors on /trade/[streamerId]
 * (browse public, act after login); this page opts into the stricter rule by
 * redirecting itself, like the listing flow does.
 */
export default async function TradeHubPage() {
  const session = await getSession();
  if (!session) {
    redirect(tradeLoginHref("/trade"));
  }

  // The heading and the list's first page are independent, so start both
  // requests after the auth decision and before rendering.
  const [t, initialOpen] = await Promise.all([
    getTranslations("trade"),
    loadInitialOpenTradePage(session.twitchUserId),
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
            className="cursor-not-allowed rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white opacity-50"
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
    </div>
  );
}
