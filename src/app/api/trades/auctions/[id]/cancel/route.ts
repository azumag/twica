import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { cancelTradeAuction } from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/**
 * POST /api/trades/auctions/[id]/cancel
 *
 * Seller only. Allowed whenever the auction has no active bid, before or
 * after the deadline (planning review M7); 409 TRADE_AUCTION_HAS_BIDS
 * otherwise. Idempotent in state (`alreadyCancelled`).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeTradeWrite(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isCanonicalUuid(id)) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    const result = await cancelTradeAuction({
      twitchUserId: auth.session.twitchUserId,
      auctionId: id,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    logger.info("Trade auction cancelled", {
      auctionId: result.auctionId,
      sellerTwitchUserId: auth.session.twitchUserId,
      alreadyCancelled: result.alreadyCancelled,
    });
    return NextResponse.json({
      success: true,
      auctionId: result.auctionId,
      alreadyCancelled: result.alreadyCancelled,
    });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade auction cancel");
  }
}
