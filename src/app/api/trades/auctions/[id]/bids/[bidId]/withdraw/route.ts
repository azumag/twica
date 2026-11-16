import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { withdrawTradeAuctionBid } from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid, normalizeUuid } from "@/lib/uuid-validation";

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

  const { id, bidId } = await params;
  if (!isCanonicalUuid(id) || !isCanonicalUuid(bidId)) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }
  // #2061: サービス層はbidの実auction_idとパスの[id]を===比較する。DBは
  // 小文字を返すため、大文字表記は不一致→404になる。境界で小文字へ揃える。
  const auctionId = normalizeUuid(id);
  const normalizedBidId = normalizeUuid(bidId);

  try {
    const result = await withdrawTradeAuctionBid({
      twitchUserId: auth.session.twitchUserId,
      bidId: normalizedBidId,
      auctionId,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    logger.info("Trade auction bid withdrawn", {
      auctionId,
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
