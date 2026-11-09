import { type NextRequest, NextResponse } from "next/server";

import { cancelTradeOffer } from "@/lib/trade";
import {
  authorizeTradeWrite,
  tradeErrorResponse,
  tradeInternalErrorResponse,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

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
    const result = await cancelTradeOffer({
      twitchUserId: auth.session.twitchUserId,
      tradeOfferId: id,
    });
    if (result.kind === "error") {
      return tradeErrorResponse(
        result.code,
        result.code === "TRADE_OFFER_NOT_FOUND" ? 404 : 409,
      );
    }
    return NextResponse.json({ success: true, id: result.id });
  } catch (error) {
    return tradeInternalErrorResponse(error, "Trade offer cancel");
  }
}
