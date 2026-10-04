import { type NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { validateContentType } from "@/lib/request-validation";
import { getSession } from "@/lib/session";
import { cancelTradeOffer } from "@/lib/trade";
import { isCanonicalUuid } from "@/lib/uuid-validation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) return contentTypeValidation;

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
  const rate = await checkRateLimit(rateLimits.tradeWrite, identifier);
  if (!rate.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
          "X-RateLimit-Reset": String(rate.reset),
        },
      },
    );
  }

  const { id } = await params;
  if (!isCanonicalUuid(id)) {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
  }

  try {
    const result = await cancelTradeOffer({
      twitchUserId: session.twitchUserId,
      tradeOfferId: id,
    });
    if (result.kind === "error") {
      return NextResponse.json(
        { error: ERROR_MESSAGES[result.code] },
        { status: result.code === "TRADE_OFFER_NOT_FOUND" ? 404 : 409 },
      );
    }
    return NextResponse.json({ success: true, id: result.id });
  } catch (error) {
    return handleApiError(error, "Trade offer cancel");
  }
}
