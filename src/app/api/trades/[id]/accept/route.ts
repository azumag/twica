import { type NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { handleApiError } from "@/lib/error-handler";
import { logger } from "@/lib/logger.server";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
} from "@/lib/rate-limit";
import { validateContentType } from "@/lib/request-validation";
import { getSession } from "@/lib/session";
import {
  acceptTradeOffer,
  getTradeOfferAuditParticipants,
  type TradeAcceptRpcError,
} from "@/lib/trade";
import { isCanonicalUuid } from "@/lib/uuid-validation";

type AcceptError = TradeAcceptRpcError | "TRADE_BUSY";

function errorResponse(code: AcceptError) {
  switch (code) {
    case "TRADE_OFFER_NOT_FOUND":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_OFFER_NOT_FOUND },
        { status: 404 },
      );
    case "OFFER_NOT_OPEN":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_OFFER_NOT_OPEN },
        { status: 409 },
      );
    case "SELF_ACCEPT_FORBIDDEN":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_SELF_ACCEPT },
        { status: 400 },
      );
    case "OFFER_INVALID":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_OFFER_INVALID },
        { status: 409 },
      );
    case "TRADE_DISABLED":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_DISABLED },
        { status: 403 },
      );
    case "CARD_NOT_OWNED":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_CARD_NOT_OWNED },
        { status: 409 },
      );
    case "TRADE_BUSY":
      return NextResponse.json(
        { error: ERROR_MESSAGES.TRADE_BUSY },
        { status: 503 },
      );
  }
}

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
    const body = await request.json();
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    if (!isCanonicalUuid(requestId)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const result = await acceptTradeOffer({
      twitchUserId: session.twitchUserId,
      tradeOfferId: id,
      requestId,
    });

    if (!result.success) {
      return errorResponse(result.error as AcceptError);
    }

    // Audit-only lookup must never make a committed ownership transfer appear
    // failed. If participant metadata cannot be read, keep the success response
    // and leave a warning for operators.
    let offererTwitchUserId: string | null = null;
    try {
      const participants = await getTradeOfferAuditParticipants(id);
      offererTwitchUserId = participants.offererTwitchUserId;
    } catch (auditError) {
      logger.warn("Trade completion audit participant lookup failed", {
        tradeOfferId: id,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }

    logger.info("Card trade completed", {
      tradeOfferId: id,
      offererTwitchUserId,
      accepterTwitchUserId: session.twitchUserId,
      // Reuse the identifier that actually keyed this authenticated request's
      // rate-limit bucket. Avoid separately retaining the raw client IP.
      rateLimitIdentifier: identifier,
      idempotentReplay: result.idempotentReplay === true,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error, "Trade offer accept");
  }
}
