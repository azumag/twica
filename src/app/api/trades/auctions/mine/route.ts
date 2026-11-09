import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  listMyTradeAuctions,
  TradeAuctionUnavailableError,
  type TradeAuctionMineRole,
} from "@/lib/trade-auction";
import {
  limitTradeRead,
  parseTradePage,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";

const MINE_ROLES: ReadonlySet<string> = new Set<TradeAuctionMineRole>(["selling", "bidding"]);

/**
 * GET /api/trades/auctions/mine?role=selling|bidding&page=N
 *
 * Separate from GET /api/trades/mine on purpose (design §4.6): that endpoint
 * is not extended, so the existing "my trades" page keeps working while the
 * auction schema is missing (this one answers 503 TRADE_AUCTION_UNAVAILABLE).
 * `role` defaults to selling.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return tradeErrorResponse("UNAUTHORIZED", 401);
  }

  const limited = await limitTradeRead(request, session.twitchUserId);
  if (limited) return limited;

  const { searchParams } = request.nextUrl;
  const rawRole = searchParams.get("role") ?? "selling";
  if (!MINE_ROLES.has(rawRole)) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }
  const page = parseTradePage(searchParams.get("page"));
  if (page === null) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    return NextResponse.json(
      await listMyTradeAuctions(session.twitchUserId, {
        role: rawRole as TradeAuctionMineRole,
        page,
      }),
    );
  } catch (error) {
    if (error instanceof TradeAuctionUnavailableError) {
      return tradeAuctionErrorResponse("TRADE_AUCTION_UNAVAILABLE");
    }
    return tradeInternalErrorResponse(error, "Trade auctions mine");
  }
}
