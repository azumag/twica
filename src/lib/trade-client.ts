/**
 * Client-side helpers for the viewer trade UI (#726/#727).
 *
 * This module is imported by client components, so it must stay free of
 * server-only dependencies. Everything imported from the server modules
 * (`@/lib/trade`, `@/lib/trade-api`) is `import type` and erased at build time.
 */
import type { TradeApiErrorCode } from "@/lib/trade-api";
import { parseMaintenanceError } from "@/lib/maintenance/client";

/** i18n keys (in the `trade` namespace) used for API error copy. */
export type TradeErrorMessageKey =
  | "errorTradeDisabled"
  | "errorTradeOfferNotFound"
  | "errorTradeAlreadyCompletedOrInvalid"
  | "errorTradeBusy"
  | "errorTradeCardNotOwned"
  | "errorTradeSelfAccept"
  | "errorTradeOfferLimit"
  | "errorTradeOfferedCardInactive"
  | "errorTradeWantedCardUnavailable"
  | "errorTradeOfferUnavailable"
  | "errorTradeSameCard"
  | "errorTradeCardAlreadyListed"
  | "errorUnauthorized"
  | "errorRateLimited"
  | "errorGeneric"
  | "errorNetwork";

/**
 * API error code → i18n key (design doc §5 error table / §11.1).
 *
 * Typed as `Record<TradeApiErrorCode, ...>` so that adding a code on the API
 * side (src/lib/trade-api.ts) without choosing its copy here is a compile
 * error instead of silently falling back to the generic message. Request-level
 * failures the viewer cannot act on (CSRF after the retry, malformed request,
 * content type, 500) intentionally share the generic copy.
 */
export const TRADE_ERROR_MESSAGE_KEYS: Record<TradeApiErrorCode, TradeErrorMessageKey> = {
  UNAUTHORIZED: "errorUnauthorized",
  CSRF_TOKEN_INVALID: "errorGeneric",
  RATE_LIMIT_EXCEEDED: "errorRateLimited",
  INVALID_REQUEST: "errorGeneric",
  UNSUPPORTED_MEDIA_TYPE: "errorGeneric",
  INTERNAL_ERROR: "errorGeneric",
  TRADE_DISABLED: "errorTradeDisabled",
  TRADE_OFFER_NOT_FOUND: "errorTradeOfferNotFound",
  TRADE_OFFER_NOT_OPEN: "errorTradeAlreadyCompletedOrInvalid",
  TRADE_OFFER_INVALID: "errorTradeAlreadyCompletedOrInvalid",
  TRADE_SELF_ACCEPT: "errorTradeSelfAccept",
  TRADE_CARD_NOT_OWNED: "errorTradeCardNotOwned",
  TRADE_CARD_ALREADY_LISTED: "errorTradeCardAlreadyListed",
  TRADE_OFFER_LIMIT: "errorTradeOfferLimit",
  TRADE_BUSY: "errorTradeBusy",
  TRADE_SAME_CARD: "errorTradeSameCard",
  TRADE_WANTED_CARD_UNAVAILABLE: "errorTradeWantedCardUnavailable",
  TRADE_OFFERED_CARD_INACTIVE: "errorTradeOfferedCardInactive",
  TRADE_OFFER_UNAVAILABLE: "errorTradeOfferUnavailable",
};

function isKnownTradeErrorCode(code: unknown): code is TradeApiErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(TRADE_ERROR_MESSAGE_KEYS, code);
}

/** Unknown / missing codes (e.g. a newer server) fall back to the generic copy. */
export function tradeErrorMessageKey(code: unknown): TradeErrorMessageKey {
  return isKnownTradeErrorCode(code) ? TRADE_ERROR_MESSAGE_KEYS[code] : "errorGeneric";
}

/**
 * Codes meaning "this offer is gone or can no longer be accepted". The board
 * refetches after the dialog is closed so the stale row disappears (§6.4).
 */
const OFFER_GONE_CODES: ReadonlySet<TradeApiErrorCode> = new Set<TradeApiErrorCode>([
  "TRADE_OFFER_NOT_OPEN",
  "TRADE_OFFER_INVALID",
  "TRADE_OFFER_UNAVAILABLE",
  "TRADE_OFFER_NOT_FOUND",
]);

export function isOfferGoneCode(code: unknown): boolean {
  return isKnownTradeErrorCode(code) && OFFER_GONE_CODES.has(code);
}

/**
 * Codes after which the row's displayed state (offer itself, or the viewer's
 * canAccept / the channel gate) is stale, so the board refetches on close.
 * Transient failures (TRADE_BUSY, rate limit, 5xx, network) keep the list as
 * is: the same offer can simply be retried.
 */
const LIST_STALE_CODES: ReadonlySet<TradeApiErrorCode> = new Set<TradeApiErrorCode>([
  ...OFFER_GONE_CODES,
  "TRADE_DISABLED",
  "TRADE_CARD_NOT_OWNED",
]);

export function isListStaleCode(code: unknown): boolean {
  return isKnownTradeErrorCode(code) && LIST_STALE_CODES.has(code);
}

export type TradePostResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** Machine-readable API code (undefined for network/maintenance errors). */
      code?: string;
      /** Server-provided maintenance copy (already localized by the guard). */
      maintenanceMessage?: string;
      networkError?: boolean;
    };

/**
 * POST JSON to a trade endpoint with the repository's CSRF recovery pattern.
 *
 * The CSRF cookie is HttpOnly and issued lazily (src/lib/csrf.ts): when the
 * first write of a session gets 403 CSRF_TOKEN_INVALID, GET /api/session sets
 * the cookie and the request is retried exactly once (same as
 * InquiryForm/LogoutButton). The retry re-sends the *same* body, so the
 * idempotency `requestId` inside it is reused and a create/accept that the
 * server did commit cannot be duplicated by the retry.
 *
 * Only a 403 carrying the CSRF code triggers the refresh: a 403
 * TRADE_DISABLED is a business answer and must not be retried.
 */
export async function postTradeJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<TradePostResult<T>> {
  const init = (): RequestInit => ({
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    let res = await fetch(url, init());
    let data: unknown = await res.json().catch(() => null);

    if (res.status === 403 && (data as { code?: unknown } | null)?.code === "CSRF_TOKEN_INVALID") {
      const refresh = await fetch("/api/session", { credentials: "include", cache: "no-store" });
      if (refresh.ok) {
        res = await fetch(url, init());
        data = await res.json().catch(() => null);
      }
    }

    if (res.ok) {
      return { ok: true, data: data as T };
    }

    // Maintenance guard answers 503 with a nested { error: { code, message } }
    // body (src/lib/maintenance/guard.ts), unlike trade's top-level `code`.
    const maintenance = parseMaintenanceError(res, data);
    if (maintenance) {
      return { ok: false, maintenanceMessage: maintenance.message };
    }
    const code = (data as { code?: unknown } | null)?.code;
    return { ok: false, code: typeof code === "string" ? code : undefined };
  } catch {
    return { ok: false, networkError: true };
  }
}

/**
 * Login link that returns to `returnTo` after OAuth.
 *
 * Same contract as the server-side redirects in /collection/[streamerId]
 * (login route stores `returnTo` in a cookie when it is a same-origin path).
 * The whole path INCLUDING its query string (e.g. `?scope=cross`) is encoded
 * as one parameter value; otherwise `&`/`?` inside returnTo would be parsed as
 * parameters of the login URL itself.
 */
export function tradeLoginHref(returnTo: string): string {
  return `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(returnTo)}`;
}

/** `?scope=cross` selects the cross-channel tab/flow; anything else is in-channel. */
export function parseTradeScope(raw: string | string[] | undefined): "in_channel" | "cross_channel" {
  return raw === "cross" ? "cross_channel" : "in_channel";
}

/** Board URL for a channel/scope (in-channel is the default, no query). */
export function tradeBoardPath(streamerId: string, scope: "in_channel" | "cross_channel"): string {
  return scope === "cross_channel" ? `/trade/${streamerId}?scope=cross` : `/trade/${streamerId}`;
}

/** Listing-flow URL for a channel/scope. */
export function tradeCreatePath(streamerId: string, scope: "in_channel" | "cross_channel"): string {
  return scope === "cross_channel"
    ? `/trade/${streamerId}/new?scope=cross`
    : `/trade/${streamerId}/new`;
}

/**
 * Localized date-time for trade rows, in the viewer's local time zone.
 *
 * Trade lists are fetched and rendered on the client only, so there is no
 * SSR/hydration time-zone mismatch to guard against (unlike
 * CollectionProgress). Plain Intl is used (same as CollectionProgress)
 * instead of next-intl's formatter, which warns without a configured timeZone.
 */
export function formatTradeDateTime(value: string | null, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
