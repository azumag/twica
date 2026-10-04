import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { listMyTradeOffers, type TradeOfferStatus } from "@/lib/trade";
import {
  limitTradeRead,
  parseTradePage,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";

const MINE_STATUSES: ReadonlySet<string> = new Set<TradeOfferStatus>([
  "open",
  "completed",
  "cancelled",
]);

/**
 * GET /api/trades/mine?status=open|completed|cancelled&page=N
 *
 * `status` is optional (omitted = all statuses, as before) and maps 1:1 to
 * the three tabs of /trade/mine. Results are now paged at TRADE_PAGE_SIZE
 * with `hasMore` (previously the full, unbounded history was returned as a
 * bare `offers` array), same contract as GET /api/trades.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return tradeErrorResponse("UNAUTHORIZED", 401);
  }

  const limited = await limitTradeRead(request, session.twitchUserId);
  if (limited) return limited;

  const { searchParams } = request.nextUrl;
  const rawStatus = searchParams.get("status");
  if (rawStatus !== null && !MINE_STATUSES.has(rawStatus)) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }
  const page = parseTradePage(searchParams.get("page"));
  if (page === null) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    return NextResponse.json(
      await listMyTradeOffers(session.twitchUserId, {
        status: (rawStatus ?? undefined) as TradeOfferStatus | undefined,
        page,
      }),
    );
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade offers mine");
  }
}
