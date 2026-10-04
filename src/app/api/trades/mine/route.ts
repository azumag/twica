import { type NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";
import { listMyTradeOffers } from "@/lib/trade";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
  const rate = await checkRateLimit(rateLimits.tradeRead, identifier);
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

  try {
    return NextResponse.json({ offers: await listMyTradeOffers(session.twitchUserId) });
  } catch (error) {
    return handleApiError(error, "Trade offers mine");
  }
}
