import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import { getSession } from "@/lib/session";
import type { TradeScope } from "@/lib/trade";
import {
  createTradeAuction,
  listTradeAuctions,
  TRADE_AUCTION_DURATIONS_HOURS,
  TradeAuctionUnavailableError,
  type TradeAuctionDurationHours,
} from "@/lib/trade-auction";
import {
  authorizeTradeWrite,
  limitTradeRead,
  parseTradePage,
  readTradeJsonBody,
  tradeAuctionErrorResponse,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/**
 * GET /api/trades/auctions?streamerId=&scope=in_channel|cross_channel&page=N
 *
 * Board of auctions that still hold their card (bidding / selecting), with
 * the active bid count and the viewer's own bid. Readable without login like
 * GET /api/trades. 503 TRADE_AUCTION_UNAVAILABLE during the migration deploy
 * window (the UI hides the auction tab).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    const limited = await limitTradeRead(request, session?.twitchUserId);
    if (limited) return limited;

    const { searchParams } = request.nextUrl;
    const streamerId = searchParams.get("streamerId") ?? "";
    if (!isCanonicalUuid(streamerId)) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }
    const rawScope = searchParams.get("scope") ?? "in_channel";
    if (rawScope !== "in_channel" && rawScope !== "cross_channel") {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }
    const page = parseTradePage(searchParams.get("page"));
    if (page === null) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    return NextResponse.json(
      await listTradeAuctions({
        streamerId,
        scope: rawScope as TradeScope,
        page,
        twitchUserId: session?.twitchUserId,
      }),
    );
  } catch (error) {
    if (error instanceof TradeAuctionUnavailableError) {
      return tradeAuctionErrorResponse("TRADE_AUCTION_UNAVAILABLE");
    }
    return tradeInternalErrorResponse(error, "Trade auctions list");
  }
}

function isDurationHours(value: unknown): value is TradeAuctionDurationHours {
  return (TRADE_AUCTION_DURATIONS_HOURS as readonly unknown[]).includes(value);
}

/**
 * POST /api/trades/auctions  { offeredUserCardId, durationHours: 24|72|168, requestId }
 *
 * `requestId` is required (idempotent replay of a retried create, same as
 * POST /api/trades). The RPC repeats every check under row locks.
 */
export async function POST(request: NextRequest) {
  const auth = await authorizeTradeWrite(request);
  if (!auth.ok) return auth.response;

  try {
    const parsed = await readTradeJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { body } = parsed;
    const offeredUserCardId =
      typeof body.offeredUserCardId === "string" ? body.offeredUserCardId : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (
      !isCanonicalUuid(offeredUserCardId)
      || !isCanonicalUuid(requestId)
      || !isDurationHours(body.durationHours)
    ) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const result = await createTradeAuction({
      twitchUserId: auth.session.twitchUserId,
      offeredUserCardId,
      durationHours: body.durationHours,
      requestId,
    });
    if (result.kind === "error") return tradeAuctionErrorResponse(result.code);

    // Audit log (design §7): create / bid / withdraw / cancel / settle.
    logger.info("Trade auction created", {
      auctionId: result.auction.id,
      sellerTwitchUserId: auth.session.twitchUserId,
      durationHours: body.durationHours,
      idempotentReplay: result.idempotentReplay,
    });
    return NextResponse.json({ auction: result.auction, idempotentReplay: result.idempotentReplay });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade auction creation");
  }
}
