import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { getTradeAuction, TradeAuctionUnavailableError } from "@/lib/trade-auction";
import {
  limitTradeRead,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/**
 * GET /api/trades/auctions/[id]
 *
 * Bid contents are only returned to the seller (`bids`) and, for their own
 * bid, to a bidder (`auction.myBid`); everyone else gets `bidCount` only.
 * A hidden or missing auction is 404 for non-participants (same answer).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    const limited = await limitTradeRead(request, session?.twitchUserId);
    if (limited) return limited;

    const { id } = await params;
    if (!isCanonicalUuid(id)) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const detail = await getTradeAuction({ auctionId: id, twitchUserId: session?.twitchUserId });
    if (!detail) return tradeAuctionErrorResponse("TRADE_AUCTION_NOT_FOUND");
    return NextResponse.json(detail);
  } catch (error) {
    if (error instanceof TradeAuctionUnavailableError) {
      return tradeAuctionErrorResponse("TRADE_AUCTION_UNAVAILABLE");
    }
    return tradeInternalErrorResponse(error, "Trade auction detail");
  }
}
