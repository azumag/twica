import { type NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  createTradeOffer,
  listTradeOffers,
  type TradeServiceErrorCode,
  type TradeScope,
} from "@/lib/trade";
import {
  authorizeTradeWrite,
  limitTradeRead,
  parseTradePage,
  readTradeJsonBody,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/** HTTP status per create-path service code (unchanged since #723). */
function createErrorStatus(code: TradeServiceErrorCode): number {
  switch (code) {
    case "TRADE_DISABLED":
      return 403;
    case "TRADE_CARD_ALREADY_LISTED":
    case "TRADE_OFFER_LIMIT":
    // The offerer's own copy exists but its card was retired: a state
    // conflict, not a malformed request.
    case "TRADE_OFFERED_CARD_INACTIVE":
      return 409;
    default:
      return 400;
  }
}

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
    const scope = rawScope as TradeScope;

    const wantedCardId = searchParams.get("wantedCardId") ?? undefined;
    const offeredCardId = searchParams.get("offeredCardId") ?? undefined;
    if (
      (wantedCardId !== undefined && !isCanonicalUuid(wantedCardId))
      || (offeredCardId !== undefined && !isCanonicalUuid(offeredCardId))
    ) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const page = parseTradePage(searchParams.get("page"));
    if (page === null) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    return NextResponse.json(
      await listTradeOffers({
        streamerId,
        scope,
        wantedCardId,
        offeredCardId,
        page,
        twitchUserId: session?.twitchUserId,
      }),
    );
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade offers list");
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeTradeWrite(request);
  if (!auth.ok) return auth.response;

  try {
    const parsed = await readTradeJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { body } = parsed;
    const offeredUserCardId =
      typeof body.offeredUserCardId === "string" ? body.offeredUserCardId : "";
    const wantedCardId = typeof body.wantedCardId === "string" ? body.wantedCardId : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";

    if (
      !isCanonicalUuid(offeredUserCardId)
      || !isCanonicalUuid(wantedCardId)
      || !isCanonicalUuid(requestId)
    ) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const result = await createTradeOffer({
      twitchUserId: auth.session.twitchUserId,
      offeredUserCardId,
      wantedCardId,
      requestId,
    });
    if (result.kind === "error") {
      return tradeErrorResponse(result.code, createErrorStatus(result.code));
    }

    return NextResponse.json({
      tradeOffer: {
        id: result.offer.id,
        offeredUserCardId: result.offer.offered_user_card_id,
        offeredCardId: result.offer.offered_card_id,
        offeredStreamerId: result.offer.offered_streamer_id,
        wantedCardId: result.offer.wanted_card_id,
        wantedStreamerId: result.offer.wanted_streamer_id,
        offeredCard: result.offer.offered_card_snapshot,
        wantedCard: result.offer.wanted_card_snapshot,
        isCrossChannel: Boolean(result.offer.is_cross_channel),
        status: result.offer.status,
        createdAt: result.offer.created_at,
      },
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade offer creation");
  }
}
