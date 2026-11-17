import { logger } from "@/lib/logger";
import { listMyTradeOffers, type TradeCollectionSort } from "@/lib/trade";
import {
  listTradeCollections,
  type TradeCollectionSection,
} from "@/lib/trade-collections";
import type { TradeListPage } from "@/lib/use-trade-list";

/**
 * Server prefetch of the "open" tab that <MyTrades> shows first (#2078).
 *
 * The /trade hub renders the same "my trades" panel that /trade/mine used to
 * render, so the query and its fallback must live in one place as that page
 * becomes a redirect alias.
 *
 * A failure must not break the page: returning null hands the tab to the
 * client, which fetches it through GET /api/trades/mine and shows the usual
 * error/retry UI. The log stays a warning (not an error) because the page is
 * still usable without the prefetch.
 *
 * Rate limiting: this direct service call bypasses the API's tradeRead limiter
 * (and the middleware's global limit, which only covers /api). That is
 * acceptable, as it was on /trade/mine: the page requires a session, reads
 * only the signed-in viewer's own history, costs one bounded statement (one
 * 20-row page) per page render — the same work every other authenticated
 * server page (e.g. the collection) does without an extra limiter — and
 * returns nothing the API would not return to the same viewer.
 *
 * Kept in src/lib (not in the page) so the auth/redirect decision and the
 * data-loading step are independently testable, and so the page file stays a
 * thin composition of the guard and the reusable <MyTrades> component.
 */
export async function loadInitialOpenTradePage(
  twitchUserId: string,
): Promise<TradeListPage | null> {
  try {
    const { offers, hasMore } = await listMyTradeOffers(twitchUserId, {
      status: "open",
      page: 1,
    });
    return { offers, hasMore };
  } catch (error) {
    logger.warn("Trade hub SSR prefetch failed; falling back to the client fetch", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Server prefetch of the hub's per-collection lists (#2079).
 *
 * The ranking (one statement each for offers and auctions) is server-side, so
 * the first paint already contains the correct order and the first five rows.
 * On failure we return null instead of pretending there are no listings: the
 * client shows an error notice with a retry, and the "my trades" panel remains
 * usable. The failure is a warning for the same reason as the /mine prefetch:
 * the hub is still usable without this section.
 */
export async function loadInitialTradeCollections(
  twitchUserId: string,
  sort: TradeCollectionSort,
): Promise<TradeCollectionSection[] | null> {
  try {
    return await listTradeCollections({ twitchUserId, sort });
  } catch (error) {
    logger.warn("Trade hub collection prefetch failed; showing the retry state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
