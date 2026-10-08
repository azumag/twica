import { type NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger.server";
import {
  acceptTradeOffer,
  getTradeOfferAuditParticipants,
  type TradeAcceptPrecheckError,
  type TradeAcceptRpcError,
} from "@/lib/trade";
import {
  authorizeTradeWrite,
  readTradeJsonBody,
  tradeErrorResponse,
  tradeInternalErrorResponse,
  type TradeAcceptApiErrorCode,
} from "@/lib/trade-api";
import { isCanonicalUuid } from "@/lib/uuid-validation";

type AcceptError = TradeAcceptRpcError | TradeAcceptPrecheckError | "TRADE_BUSY";

/**
 * RPC/service error → { API code, HTTP status }. The RPC's internal names
 * (OFFER_NOT_OPEN, CARD_NOT_OWNED, ...) are normalized to the TRADE_* codes
 * used by every other trade endpoint so the UI keeps one code table. Statuses
 * are unchanged from #724.
 *
 * Recorded limitation (#1749 item 7, no behavior change): for a known
 * trade-offer UUID the status code distinguishes "an open offer exists that
 * this viewer may not see" (409 TRADE_OFFER_UNAVAILABLE, decided by
 * precheckTradeAccept) from "no open offer with that id" (404
 * TRADE_OFFER_NOT_FOUND, decided by the RPC). Nothing about the offer leaks
 * beyond that bit — no card name, no offerer — and the same bit was already
 * inferable from the pre-existing accept endpoint before the visibility
 * precheck existed, so it is accepted rather than remapped to a single code.
 */
const ACCEPT_ERRORS: Record<AcceptError, { code: TradeAcceptApiErrorCode; status: number }> = {
  TRADE_OFFER_NOT_FOUND: { code: "TRADE_OFFER_NOT_FOUND", status: 404 },
  OFFER_NOT_OPEN: { code: "TRADE_OFFER_NOT_OPEN", status: 409 },
  SELF_ACCEPT_FORBIDDEN: { code: "TRADE_SELF_ACCEPT", status: 400 },
  OFFER_INVALID: { code: "TRADE_OFFER_INVALID", status: 409 },
  TRADE_DISABLED: { code: "TRADE_DISABLED", status: 403 },
  CARD_NOT_OWNED: { code: "TRADE_CARD_NOT_OWNED", status: 409 },
  // Card retired or offered card hidden from this acceptor (API precheck).
  TRADE_OFFER_UNAVAILABLE: { code: "TRADE_OFFER_UNAVAILABLE", status: 409 },
  TRADE_BUSY: { code: "TRADE_BUSY", status: 503 },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeTradeWrite(request);
  if (!auth.ok) return auth.response;
  const { session, rateLimitIdentifier: identifier } = auth;

  const { id } = await params;
  if (!isCanonicalUuid(id)) {
    return tradeErrorResponse("INVALID_REQUEST", 400);
  }

  try {
    const parsed = await readTradeJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const requestId =
      typeof parsed.body.requestId === "string" ? parsed.body.requestId : "";
    if (!isCanonicalUuid(requestId)) {
      return tradeErrorResponse("INVALID_REQUEST", 400);
    }

    const result = await acceptTradeOffer({
      twitchUserId: session.twitchUserId,
      tradeOfferId: id,
      requestId,
    });

    if (!result.success) {
      const mapped = ACCEPT_ERRORS[result.error as AcceptError];
      // acceptTradeOffer validates RPC payloads (unknown codes throw), so an
      // unmapped value here is a programming error: fail as 500, not 200.
      if (!mapped) throw new Error(`Unmapped trade accept error: ${String(result.error)}`);
      return tradeErrorResponse(mapped.code, mapped.status);
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
    return tradeInternalErrorResponse(error, "Trade offer accept");
  }
}
