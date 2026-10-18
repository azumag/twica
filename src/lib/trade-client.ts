/**
 * Client-side helpers for the viewer trade UI (#726/#727).
 *
 * This module is imported by client components, so it must stay free of
 * server-only dependencies. Everything imported from the server modules
 * (`@/lib/trade`, `@/lib/trade-api`) is `import type` and erased at build time.
 */
import type { TradeApiErrorCode } from "@/lib/trade-api";
import type { TradeOfferDto } from "@/lib/trade";
import type { TradeAuctionBidState, TradeAuctionPhase } from "@/lib/trade-auction";
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
  | "errorTradeWantedCardNotWantable"
  | "errorTradeOfferUnavailable"
  | "errorTradeSameCard"
  | "errorTradeCardAlreadyListed"
  | "errorTradeAuctionUnavailable"
  | "errorTradeAuctionNotFound"
  | "errorTradeAuctionNotOpen"
  | "errorTradeAuctionStillBidding"
  | "errorTradeAuctionExpired"
  | "errorTradeAuctionHasBids"
  | "errorTradeAuctionSelfBid"
  | "errorTradeAuctionBidNotFound"
  | "errorTradeAuctionBidNotActive"
  | "errorTradeAuctionBidLocked"
  | "errorTradeAuctionBidLimit"
  | "errorTradeAuctionBidInvalid"
  | "errorTradeBidCardUnavailable"
  | "errorTradeBidCardNotWantable"
  | "errorTradeNotEnoughCards"
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
  TRADE_WANTED_CARD_NOT_WANTABLE: "errorTradeWantedCardNotWantable",
  TRADE_OFFERED_CARD_INACTIVE: "errorTradeOfferedCardInactive",
  TRADE_OFFER_UNAVAILABLE: "errorTradeOfferUnavailable",
  // Auctions (#1791). Copy exists now; the auction UI itself is PR-2.
  TRADE_AUCTION_UNAVAILABLE: "errorTradeAuctionUnavailable",
  TRADE_AUCTION_NOT_FOUND: "errorTradeAuctionNotFound",
  TRADE_AUCTION_NOT_OPEN: "errorTradeAuctionNotOpen",
  TRADE_AUCTION_STILL_BIDDING: "errorTradeAuctionStillBidding",
  TRADE_AUCTION_EXPIRED: "errorTradeAuctionExpired",
  TRADE_AUCTION_HAS_BIDS: "errorTradeAuctionHasBids",
  TRADE_AUCTION_SELF_BID: "errorTradeAuctionSelfBid",
  TRADE_AUCTION_BID_NOT_FOUND: "errorTradeAuctionBidNotFound",
  TRADE_AUCTION_BID_NOT_ACTIVE: "errorTradeAuctionBidNotActive",
  TRADE_AUCTION_BID_LOCKED: "errorTradeAuctionBidLocked",
  TRADE_AUCTION_BID_LIMIT: "errorTradeAuctionBidLimit",
  TRADE_AUCTION_BID_INVALID: "errorTradeAuctionBidInvalid",
  TRADE_BID_CARD_UNAVAILABLE: "errorTradeBidCardUnavailable",
  TRADE_BID_CARD_NOT_WANTABLE: "errorTradeBidCardNotWantable",
  TRADE_NOT_ENOUGH_CARDS: "errorTradeNotEnoughCards",
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

/**
 * Opaque, stable identifier of the signed-in viewer for the browser-side trade
 * list cache (useTradeList, #1754 follow-up); "anon" for anonymous viewers.
 *
 * Why: trade rows carry viewer-specific fields (isOwnOffer, canAccept,
 * offeredUserCardId). Logging in as another account in a second tab of the
 * same browser does not reload an already open tab, so a module-level cache
 * keyed by URL alone could show the previous account's rows after a
 * client-side navigation. The server component computes this key from the
 * session on every render and passes it down, so a navigation after an
 * account switch gets a different namespace.
 *
 * It is a truncated SHA-256 (64 bits) of the Twitch user id with a fixed
 * context prefix instead of the raw id: it only has to differ between
 * accounts, and the page payload then does not carry the raw identifier a
 * second time. It is not a secret or an authorization token (the server
 * re-checks the session on every API call), so no salt is needed. Web Crypto
 * is available in Workers, browsers and Node.
 */
export async function tradeViewerKey(twitchUserId: string | null): Promise<string> {
  if (!twitchUserId) return "anon";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`twica-trade-viewer:${twitchUserId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `u:${hex.slice(0, 16)}`;
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

/** One side of a trade row as the viewer sees it (card + deleted snapshot). */
/** `quantity`: copies on this side (the offered side is always 1, #1789). */
type ViewerTradeSide = { card: TradeOfferDto["offeredCard"]; deleted: boolean; quantity: number };

/**
 * The viewer's side of one trade row, for /trade/mine rows (and the cancel
 * confirmation dialog).
 *
 * /api/trades/mine returns the offer as stored (offerer → offeredCard,
 * requested → wantedCard); `mineRole` tells whether the viewer listed it or
 * accepted it, so the cards are swapped for offers the viewer accepted. A
 * side whose card definition was deleted (id NULL) is marked so the caller can
 * render the snapshot as deleted.
 */
export function viewerSides(offer: TradeOfferDto): {
  give: ViewerTradeSide;
  get: ViewerTradeSide;
  partner: TradeOfferDto["offerer"];
} {
  const offeredSide = { card: offer.offeredCard, deleted: offer.offeredCardId === null, quantity: 1 };
  const wantedSide = {
    card: offer.wantedCard,
    deleted: offer.wantedCardId === null,
    quantity: offer.wantedQuantity,
  };
  return offer.mineRole === "acceptor"
    ? { give: wantedSide, get: offeredSide, partner: offer.offerer }
    : { give: offeredSide, get: wantedSide, partner: offer.acceptedBy };
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

// -----------------------------------------------------------------------------
// Auctions (#1791 PR-2)
// -----------------------------------------------------------------------------

/**
 * Board tab: `?tab=auction` selects the auction list. It is orthogonal to
 * `?scope=cross`, so the auction tab has the same in-channel / cross-channel
 * split as the offer tabs (GET /api/trades/auctions takes the same scope).
 */
export type TradeBoardTab = "offers" | "auction";

export function parseTradeBoardTab(raw: string | string[] | undefined): TradeBoardTab {
  return raw === "auction" ? "auction" : "offers";
}

/** Auction tab URL of a board (in-channel is the default, no scope query). */
export function tradeAuctionBoardPath(streamerId: string, scope: "in_channel" | "cross_channel"): string {
  return scope === "cross_channel"
    ? `/trade/${streamerId}?tab=auction&scope=cross`
    : `/trade/${streamerId}?tab=auction`;
}

/**
 * Auction detail URL. `streamerId` is the board the viewer bids from: the
 * bid card candidates are that channel's cards (in-channel: the auction's own
 * channel; cross tab: the board's channel, matching how the cross tab lists
 * auctions of other channels for this channel's cards, design §12).
 * `scope` only decides which auction sub-tab the "back" link returns to.
 */
export function tradeAuctionDetailPath(
  streamerId: string,
  auctionId: string,
  scope: "in_channel" | "cross_channel" = "in_channel",
): string {
  const path = `/trade/${streamerId}/auctions/${auctionId}`;
  return scope === "cross_channel" ? `${path}?scope=cross` : path;
}

/** Listing flow URL with the auction kind preselected. */
export function tradeAuctionCreatePath(streamerId: string): string {
  return `/trade/${streamerId}/new?kind=auction`;
}

/**
 * Durations offered by the listing flow (hours). Mirrors
 * TRADE_AUCTION_DURATIONS_HOURS of the server module, which this client
 * module must not import at runtime; the API rejects any other value with
 * INVALID_REQUEST, so a drift cannot create an auction of an unknown length.
 */
export const TRADE_AUCTION_DURATION_OPTIONS = [24, 72, 168] as const;

/** i18n key (trade namespace) of an auction's effective phase. */
export function auctionPhaseLabelKey(phase: TradeAuctionPhase): string {
  switch (phase) {
    case "bidding":
      return "auctionPhaseBidding";
    case "selecting":
      return "auctionPhaseSelecting";
    case "completed":
      return "auctionPhaseCompleted";
    case "cancelled":
      return "auctionPhaseCancelled";
    default:
      return "auctionPhaseExpired";
  }
}

/**
 * i18n key of the viewer's own bid as the bidder sees it (/trade/mine
 * "my bids": 入札中 / 選択待ち / 落札 / 落選 / 解放). An `active` bid is
 * "waiting for the seller" once the auction is selecting; `released` means
 * the auction expired or was cancelled and the bid's copies are free again.
 */
export function auctionBidStateLabelKey(
  state: TradeAuctionBidState,
  phase: TradeAuctionPhase,
): string {
  switch (state) {
    case "won":
      return "auctionBidStateWon";
    case "lost":
      return "auctionBidStateLost";
    case "released":
    case "withdrawn":
      return "auctionBidStateReleased";
    default:
      return phase === "selecting" ? "auctionBidStateSelecting" : "auctionBidStateActive";
  }
}

/**
 * Time left until `iso`, computed on the client from the ISO time the server
 * returned (design §6). Display only: whether a deadline has passed is
 * decided by the server (clock_timestamp() in SQL), so a skewed client clock
 * can at worst show a stale countdown, never allow an operation the server
 * refuses (the failure is then explained by the API error copy).
 *
 * Days are shown with hours (a fresh 7-day auction reads "6 days 23 hours",
 * not a rounded-down "6 days"), hours with minutes, and the last minute as
 * "ending soon". `passed` means the client clock is past the deadline while
 * the data on screen still predates it (a refresh is pending).
 */
export type TradeAuctionTimeLeft =
  | { kind: "daysHours"; days: number; hours: number }
  | { kind: "hoursMinutes"; hours: number; minutes: number }
  | { kind: "minutes"; minutes: number }
  | { kind: "soon" }
  | { kind: "passed" };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function tradeAuctionTimeLeft(iso: string, nowMs: number): TradeAuctionTimeLeft {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return { kind: "passed" };
  const diff = target - nowMs;
  if (diff <= 0) return { kind: "passed" };
  if (diff < MINUTE_MS) return { kind: "soon" };
  if (diff < HOUR_MS) return { kind: "minutes", minutes: Math.floor(diff / MINUTE_MS) };
  if (diff < DAY_MS) {
    return {
      kind: "hoursMinutes",
      hours: Math.floor(diff / HOUR_MS),
      minutes: Math.floor((diff % HOUR_MS) / MINUTE_MS),
    };
  }
  return {
    kind: "daysHours",
    days: Math.floor(diff / DAY_MS),
    hours: Math.floor((diff % DAY_MS) / HOUR_MS),
  };
}
