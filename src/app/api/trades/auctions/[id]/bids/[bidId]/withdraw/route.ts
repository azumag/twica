import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { withdrawTradeAuctionBid } from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { normalizeCanonicalUuid } from "@/lib/uuid-validation";

/**
 * POST /api/trades/auctions/[id]/bids/[bidId]/withdraw
 *
 * Idempotent in state (an already withdrawn bid answers success with
 * `alreadyWithdrawn: true`), so no requestId. The RPC resolves the auction
 * from the bid and checks that the viewer is its bidder; `[id]` only gives
 * the URL its shape. Allowed before the deadline, or after it when the bid
 * can no longer be settled (spec); otherwise 409 TRADE_AUCTION_BID_LOCKED.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; bidId: string }> },
) {
  const auth = await authorizeTradeWrite(request);
  if (!auth.ok) return auth.response;

  // #2061: the service compares the [id] path value with bids.auction_id as an
  // exact JS string. PostgreSQL returns uuid values in lowercase, so the
  // boundary must normalize both path ids or an uppercase URL answers 404
  // TRADE_AUCTION_BID_NOT_FOUND for a bid that exists.
  const { id: rawId, bidId: rawBidId } = await params;
  const id = normalizeCanonicalUuid(rawId);
  const bidId = normalizeCanonicalUuid(rawBidId);
  if (!id || !bidId) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    const result = await withdrawTradeAuctionBid({
      twitchUserId: auth.session.twitchUserId,
      bidId,
      auctionId: id,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    logger.info("Trade auction bid withdrawn", {
      auctionId: id,
      bidId: result.bidId,
      bidderTwitchUserId: auth.session.twitchUserId,
      alreadyWithdrawn: result.alreadyWithdrawn,
    });
    return NextResponse.json({
      success: true,
      bidId: result.bidId,
      alreadyWithdrawn: result.alreadyWithdrawn,
    });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade auction bid withdraw");
  }
}
