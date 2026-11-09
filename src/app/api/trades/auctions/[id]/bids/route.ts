import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { placeTradeAuctionBid, TRADE_MAX_BID_QUANTITY } from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  readTradeJsonBody,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/**
 * POST /api/trades/auctions/[id]/bids  { bidCardId, quantity: 1..10, requestId }
 *
 * Places a bid, or changes the viewer's active bid on this auction (the
 * previous bid is withdrawn in the same transaction and its copies may be
 * reused). `requestId` makes a retried POST an idempotent replay.
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
    const parsed = await readTradeJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { body } = parsed;
    const bidCardId = typeof body.bidCardId === "string" ? body.bidCardId : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const quantity = body.quantity;
    if (
      !isCanonicalUuid(bidCardId)
      || !isCanonicalUuid(requestId)
      || typeof quantity !== "number"
      || !Number.isInteger(quantity)
      || quantity < 1
      || quantity > TRADE_MAX_BID_QUANTITY
    ) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const result = await placeTradeAuctionBid({
      twitchUserId: auth.session.twitchUserId,
      auctionId: id,
      bidCardId,
      quantity,
      requestId,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    logger.info("Trade auction bid placed", {
      auctionId: id,
      bidId: result.bid.id,
      replacedBidId: result.replacedBidId,
      bidderTwitchUserId: auth.session.twitchUserId,
      bidCardId: result.bid.bidCardId,
      quantity: result.bid.quantity,
      rateLimitIdentifier: auth.rateLimitIdentifier,
      idempotentReplay: result.idempotentReplay,
    });
    return NextResponse.json({
      bid: result.bid,
      replacedBidId: result.replacedBidId,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade auction bid");
  }
}
