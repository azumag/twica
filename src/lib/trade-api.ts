import { type NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { recordApiError } from "@/lib/error-handler";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { validateContentType } from "@/lib/request-validation";
import { getSession, type Session } from "@/lib/session";
import type { TradeAcceptPrecheckError, TradeServiceErrorCode } from "@/lib/trade";

// -----------------------------------------------------------------------------
// Shared HTTP contract for /api/trades/** (#726/#727)
//
// Every error response of the trade API has the shape
//   { error: <human readable message, kept for existing clients>, code: <TradeApiErrorCode> }
// so the viewer UI can choose localized copy from `code` alone (design doc §5
// error table / §11 i18n table). HTTP statuses of pre-existing errors are
// unchanged from #723/#724, with two deliberate exceptions: malformed JSON is
// now 400 INVALID_REQUEST (was an unhandled 500), and PR-C adds new errors
// (409 TRADE_OFFERED_CARD_INACTIVE / 409 TRADE_OFFER_UNAVAILABLE). `code`
// separates cases that share a status (e.g. 403 CSRF vs 403 TRADE_DISABLED,
// the 409s of accept).
//
// Error codes are stable API surface: rename only together with the UI map.
// -----------------------------------------------------------------------------

/** Codes produced by the accept route (RPC codes are normalized to TRADE_*). */
export type TradeAcceptApiErrorCode =
  | "TRADE_OFFER_NOT_FOUND"
  | "TRADE_OFFER_NOT_OPEN"
  | "TRADE_SELF_ACCEPT"
  | "TRADE_OFFER_INVALID"
  | "TRADE_DISABLED"
  | "TRADE_CARD_NOT_OWNED"
  | "TRADE_BUSY"
  | TradeAcceptPrecheckError;

/** Request-level (non-business) failures shared by every trade route. */
export type TradeRequestErrorCode =
  | "UNAUTHORIZED"
  | "CSRF_TOKEN_INVALID"
  | "RATE_LIMIT_EXCEEDED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL_ERROR";

export type TradeApiErrorCode =
  | TradeRequestErrorCode
  | TradeServiceErrorCode
  | TradeAcceptApiErrorCode;

/**
 * Message per code. CSRF keeps the historical "Forbidden" text so existing
 * clients that match on `error` see no change. UNSUPPORTED_MEDIA_TYPE keeps
 * the detailed message produced by validateContentType (see below).
 */
const TRADE_API_ERROR_MESSAGES: Record<TradeApiErrorCode, string> = {
  UNAUTHORIZED: ERROR_MESSAGES.UNAUTHORIZED,
  CSRF_TOKEN_INVALID: ERROR_MESSAGES.FORBIDDEN,
  RATE_LIMIT_EXCEEDED: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
  INVALID_REQUEST: ERROR_MESSAGES.INVALID_REQUEST,
  UNSUPPORTED_MEDIA_TYPE: ERROR_MESSAGES.CONTENT_TYPE_MISSING,
  INTERNAL_ERROR: ERROR_MESSAGES.INTERNAL_ERROR,
  TRADE_DISABLED: ERROR_MESSAGES.TRADE_DISABLED,
  TRADE_OFFER_NOT_FOUND: ERROR_MESSAGES.TRADE_OFFER_NOT_FOUND,
  TRADE_OFFER_NOT_OPEN: ERROR_MESSAGES.TRADE_OFFER_NOT_OPEN,
  TRADE_OFFER_INVALID: ERROR_MESSAGES.TRADE_OFFER_INVALID,
  TRADE_SELF_ACCEPT: ERROR_MESSAGES.TRADE_SELF_ACCEPT,
  TRADE_CARD_NOT_OWNED: ERROR_MESSAGES.TRADE_CARD_NOT_OWNED,
  TRADE_CARD_ALREADY_LISTED: ERROR_MESSAGES.TRADE_CARD_ALREADY_LISTED,
  TRADE_OFFER_LIMIT: ERROR_MESSAGES.TRADE_OFFER_LIMIT,
  TRADE_BUSY: ERROR_MESSAGES.TRADE_BUSY,
  TRADE_SAME_CARD: ERROR_MESSAGES.TRADE_SAME_CARD,
  TRADE_WANTED_CARD_UNAVAILABLE: ERROR_MESSAGES.TRADE_WANTED_CARD_UNAVAILABLE,
  TRADE_OFFERED_CARD_INACTIVE: ERROR_MESSAGES.TRADE_OFFERED_CARD_INACTIVE,
  TRADE_OFFER_UNAVAILABLE: ERROR_MESSAGES.TRADE_OFFER_UNAVAILABLE,
};

export function tradeErrorResponse(
  code: TradeApiErrorCode,
  status: number,
  init: { headers?: Record<string, string>; message?: string } = {},
) {
  return NextResponse.json(
    { error: init.message ?? TRADE_API_ERROR_MESSAGES[code], code },
    { status, headers: init.headers },
  );
}

/**
 * Log/record an unexpected failure (same sink as handleApiError) and answer
 * with the coded 500 body.
 */
export async function tradeInternalErrorResponse(error: unknown, context: string) {
  await recordApiError(error, context);
  return tradeErrorResponse("INTERNAL_ERROR", 500);
}

function tradeRateLimitResponse(rate: {
  limit?: number;
  remaining?: number;
  reset?: number;
}) {
  return tradeErrorResponse("RATE_LIMIT_EXCEEDED", 429, {
    headers: {
      "X-RateLimit-Limit": String(rate.limit ?? 0),
      "X-RateLimit-Remaining": String(rate.remaining ?? 0),
      "X-RateLimit-Reset": String(rate.reset ?? Date.now() + 60_000),
    },
  });
}

/**
 * Rate limit a read endpoint. `twitchUserId` is optional because the public
 * board is readable without login (bucket falls back to the client IP).
 */
export async function limitTradeRead(
  request: NextRequest,
  twitchUserId: string | undefined,
): Promise<NextResponse | null> {
  const identifier = await getRateLimitIdentifier(request, twitchUserId);
  const rate = await checkRateLimit(rateLimits.tradeRead, identifier);
  return rate.success ? null : tradeRateLimitResponse(rate);
}

/**
 * Common prelude of every mutating trade route, in the established order
 * (Content-Type → CSRF → session → rate limit; design doc §5). Returns either
 * the error response to send, or the authenticated session plus the
 * rate-limit identifier (the accept route logs it for abuse forensics).
 */
export async function authorizeTradeWrite(
  request: NextRequest,
): Promise<
  | { ok: false; response: NextResponse }
  | { ok: true; session: Session; rateLimitIdentifier: string }
> {
  const contentTypeError = validateContentType(request, "application/json");
  if (contentTypeError) {
    // Reuse the detailed message (expected/received type) of the shared
    // validator and only attach the machine-readable code.
    const body = (await contentTypeError.json().catch(() => null)) as
      | { error?: unknown }
      | null;
    return {
      ok: false,
      response: tradeErrorResponse("UNSUPPORTED_MEDIA_TYPE", contentTypeError.status, {
        message: typeof body?.error === "string" ? body.error : undefined,
      }),
    };
  }

  const csrf = await validateCSRFToken(request);
  if (!csrf.valid) {
    return { ok: false, response: tradeErrorResponse("CSRF_TOKEN_INVALID", 403) };
  }

  const session = await getSession();
  if (!session) {
    return { ok: false, response: tradeErrorResponse("UNAUTHORIZED", 401) };
  }

  const rateLimitIdentifier = await getRateLimitIdentifier(request, session.twitchUserId);
  const rate = await checkRateLimit(rateLimits.tradeWrite, rateLimitIdentifier);
  if (!rate.success) {
    return { ok: false, response: tradeRateLimitResponse(rate) };
  }

  return { ok: true, session, rateLimitIdentifier };
}

/**
 * Parse a JSON body. Malformed JSON is a client error (400 INVALID_REQUEST),
 * not an internal error, so it must not reach the 500 path / error recorder.
 */
export async function readTradeJsonBody(
  request: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: tradeErrorResponse("INVALID_REQUEST", 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: tradeErrorResponse("INVALID_REQUEST", 400) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/** Strict `page` query parsing shared by the board and /mine (1..100000). */
export function parseTradePage(raw: string | null): number | null {
  const value = raw ?? "1";
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page > 100_000) return null;
  return page;
}
