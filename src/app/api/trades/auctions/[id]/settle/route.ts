import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { settleTradeAuction } from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  readTradeJsonBody,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/**
 * POST /api/trades/auctions/[id]/settle  { bidId, requestId }
 *
 * The seller picks the winning bid after the deadline and within the 72-hour
 * selection window. Ownership moves in one transaction; a retried POST with
 * the same requestId and bidId is an idempotent replay. A bid that can no
 * longer be completed (settings off, card retired/deleted, not wantable,
 * copies gone) is refused without side effects so another bid can be chosen.
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
    const bidId = typeof parsed.body.bidId === "string" ? parsed.body.bidId : "";
    const requestId = typeof parsed.body.requestId === "string" ? parsed.body.requestId : "";
    if (!isCanonicalUuid(bidId) || !isCanonicalUuid(requestId)) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const result = await settleTradeAuction({
      twitchUserId: auth.session.twitchUserId,
      auctionId: id,
      bidId,
      requestId,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    logger.info("Trade auction settled", {
      auctionId: result.auctionId,
      bidId: result.bidId,
      sellerTwitchUserId: auth.session.twitchUserId,
      // Copy ids that moved: the seller's listed copy and the bid copies.
      givenUserCardId: result.givenUserCardId,
      receivedUserCardIds: result.receivedUserCardIds,
      quantity: result.quantity,
      rateLimitIdentifier: auth.rateLimitIdentifier,
      idempotentReplay: result.idempotentReplay,
    });
    return NextResponse.json({
      success: true,
      auctionId: result.auctionId,
      bidId: result.bidId,
      givenUserCardId: result.givenUserCardId,
      receivedUserCardIds: result.receivedUserCardIds,
      quantity: result.quantity,
      completedAt: result.completedAt,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade auction settle");
  }
}
