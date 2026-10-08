import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { logger } from "@/lib/logger";
import { getSession } from "@/lib/session";
import { listMyTradeOffers } from "@/lib/trade";
import { tradeLoginHref } from "@/lib/trade-client";
import type { TradeListPage } from "@/lib/use-trade-list";
import MyTrades from "@/components/MyTrades";

/**
 * /trade/mine (§6.6). Login required.
 *
 * The first page of the default "open" tab is rendered on the server and
 * handed to <MyTrades>, so the list is visible without the post-hydration
 * GET /api/trades/mine round trip (the API call used to start ~1.6–1.9 s after
 * the navigation on preview). Other tabs/pages are fetched by <MyTrades>
 * through the API as before.
 *
 * Rate limiting: this direct service call bypasses the API's tradeRead
 * limiter (and the middleware's global limit, which only covers /api). That
 * is acceptable here, unlike the public, login-optional board (see
 * <TradeBoard>): the page requires a session, reads only the signed-in
 * viewer's own history, costs one bounded statement (one 20-row page) per
 * page render — the same work every other authenticated server page (e.g. the
 * collection) does without an extra limiter — and returns nothing the API
 * would not return to the same viewer.
 *
 * This static segment takes precedence over /trade/[streamerId], so "mine"
 * is never interpreted as a streamer id.
 */
export default async function MyTradesPage() {
  const session = await getSession();
  if (!session) {
    redirect(tradeLoginHref("/trade/mine"));
  }
  const [t, initialOpen] = await Promise.all([
    getTranslations("trade"),
    loadInitialOpenPage(session.twitchUserId),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold text-white">{t("myTradesTitle")}</h1>
      <MyTrades initialOpen={initialOpen} />
    </div>
  );
}

/**
 * Server prefetch of the open tab. A failure must not break the page: the
 * client then loads the tab itself (with the usual error/retry UI).
 */
async function loadInitialOpenPage(twitchUserId: string): Promise<TradeListPage | null> {
  try {
    const { offers, hasMore } = await listMyTradeOffers(twitchUserId, { status: "open", page: 1 });
    return { offers, hasMore };
  } catch (error) {
    logger.warn("Trade mine SSR prefetch failed; falling back to the client fetch", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
