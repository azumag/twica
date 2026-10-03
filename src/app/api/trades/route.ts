import { type NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { validateContentType } from "@/lib/request-validation";
import { getSession } from "@/lib/session";
import {
  createTradeOffer,
  listTradeOffers,
  type TradeServiceErrorCode,
  type TradeScope,
} from "@/lib/trade";
import { isCanonicalUuid } from "@/lib/uuid-validation";

function rateLimitResponse(result: {
  limit: number;
  remaining: number;
  reset: number;
}) {
  return NextResponse.json(
    { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
    {
      status: 429,
      headers: {
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.reset),
      },
    },
  );
}

function tradeErrorResponse(code: TradeServiceErrorCode) {
  const status =
    code === "TRADE_DISABLED"
      ? 403
      : code === "TRADE_CARD_ALREADY_LISTED" || code === "TRADE_OFFER_LIMIT"
        ? 409
        : 400;
  return NextResponse.json({ error: ERROR_MESSAGES[code] }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rate = await checkRateLimit(rateLimits.tradeRead, identifier);
    if (!rate.success) return rateLimitResponse(rate);

    const { searchParams } = request.nextUrl;
    const streamerId = searchParams.get("streamerId") ?? "";
    if (!isCanonicalUuid(streamerId)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const rawScope = searchParams.get("scope") ?? "in_channel";
    if (rawScope !== "in_channel" && rawScope !== "cross_channel") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    const scope = rawScope as TradeScope;

    const wantedCardId = searchParams.get("wantedCardId") ?? undefined;
    const offeredCardId = searchParams.get("offeredCardId") ?? undefined;
    if (
      (wantedCardId !== undefined && !isCanonicalUuid(wantedCardId))
      || (offeredCardId !== undefined && !isCanonicalUuid(offeredCardId))
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const rawPage = searchParams.get("page") ?? "1";
    if (!/^[1-9]\d*$/.test(rawPage)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    const page = Number(rawPage);
    if (!Number.isSafeInteger(page) || page > 100_000) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
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
    return handleApiError(error, "Trade offers list");
  }
}

export async function POST(request: NextRequest) {
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
  if (!rate.success) return rateLimitResponse(rate);

  try {
    const body = await request.json();
    const offeredUserCardId =
      typeof body?.offeredUserCardId === "string" ? body.offeredUserCardId : "";
    const wantedCardId = typeof body?.wantedCardId === "string" ? body.wantedCardId : "";
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";

    if (
      !isCanonicalUuid(offeredUserCardId)
      || !isCanonicalUuid(wantedCardId)
      || !isCanonicalUuid(requestId)
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const result = await createTradeOffer({
      twitchUserId: session.twitchUserId,
      offeredUserCardId,
      wantedCardId,
      requestId,
    });
    if (result.kind === "error") return tradeErrorResponse(result.code);

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
    return handleApiError(error, "Trade offer creation");
  }
}
