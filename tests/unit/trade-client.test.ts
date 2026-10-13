import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradeApiErrorCode } from "@/lib/trade-api";
import type { TradeOfferDto } from "@/lib/trade";
import {
  TRADE_ERROR_MESSAGE_KEYS,
  isOfferGoneCode,
  postTradeJson,
  tradeBoardPath,
  tradeCreatePath,
  tradeErrorMessageKey,
  tradeLoginHref,
  tradeViewerKey,
  viewerSides,
} from "@/lib/trade-client";
import jaMessages from "../../messages/ja.json";
import enMessages from "../../messages/en.json";

/**
 * Every API error code, listed once more on purpose. `Record<TradeApiErrorCode, true>`
 * makes this list fail typecheck when a code is added/removed on the API side,
 * so the runtime assertions below always cover the complete code set.
 */
const ALL_CODES: Record<TradeApiErrorCode, true> = {
  UNAUTHORIZED: true,
  CSRF_TOKEN_INVALID: true,
  RATE_LIMIT_EXCEEDED: true,
  INVALID_REQUEST: true,
  UNSUPPORTED_MEDIA_TYPE: true,
  INTERNAL_ERROR: true,
  TRADE_DISABLED: true,
  TRADE_OFFER_NOT_FOUND: true,
  TRADE_OFFER_NOT_OPEN: true,
  TRADE_OFFER_INVALID: true,
  TRADE_SELF_ACCEPT: true,
  TRADE_CARD_NOT_OWNED: true,
  TRADE_CARD_ALREADY_LISTED: true,
  TRADE_OFFER_LIMIT: true,
  TRADE_BUSY: true,
  TRADE_SAME_CARD: true,
  TRADE_WANTED_CARD_UNAVAILABLE: true,
  TRADE_WANTED_CARD_NOT_WANTABLE: true,
  TRADE_OFFERED_CARD_INACTIVE: true,
  TRADE_OFFER_UNAVAILABLE: true,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("trade error code → i18n key", () => {
  it("maps every API code to a key that exists in both ja and en", () => {
    for (const code of Object.keys(ALL_CODES) as TradeApiErrorCode[]) {
      const key = TRADE_ERROR_MESSAGE_KEYS[code];
      expect(key, code).toBeTruthy();
      expect(jaMessages.trade, `${code} → ${key} (ja)`).toHaveProperty(key);
      expect(enMessages.trade, `${code} → ${key} (en)`).toHaveProperty(key);
    }
    expect(Object.keys(TRADE_ERROR_MESSAGE_KEYS).sort()).toEqual(Object.keys(ALL_CODES).sort());
  });

  it("uses the specific copy for business errors (design doc §11.1)", () => {
    expect(tradeErrorMessageKey("TRADE_OFFER_NOT_OPEN")).toBe("errorTradeAlreadyCompletedOrInvalid");
    expect(tradeErrorMessageKey("TRADE_OFFER_INVALID")).toBe("errorTradeAlreadyCompletedOrInvalid");
    expect(tradeErrorMessageKey("TRADE_OFFER_UNAVAILABLE")).toBe("errorTradeOfferUnavailable");
    expect(tradeErrorMessageKey("TRADE_BUSY")).toBe("errorTradeBusy");
    expect(tradeErrorMessageKey("TRADE_OFFER_LIMIT")).toBe("errorTradeOfferLimit");
    expect(tradeErrorMessageKey("TRADE_DISABLED")).toBe("errorTradeDisabled");
    expect(tradeErrorMessageKey("RATE_LIMIT_EXCEEDED")).toBe("errorRateLimited");
  });

  it("falls back to the generic copy for unknown or missing codes", () => {
    expect(tradeErrorMessageKey("SOMETHING_NEW")).toBe("errorGeneric");
    expect(tradeErrorMessageKey(undefined)).toBe("errorGeneric");
    // Prototype keys must not be treated as known codes.
    expect(tradeErrorMessageKey("toString")).toBe("errorGeneric");
  });

  it("flags offers that are gone so the board refetches", () => {
    expect(isOfferGoneCode("TRADE_OFFER_NOT_OPEN")).toBe(true);
    expect(isOfferGoneCode("TRADE_OFFER_INVALID")).toBe(true);
    expect(isOfferGoneCode("TRADE_OFFER_UNAVAILABLE")).toBe(true);
    expect(isOfferGoneCode("TRADE_BUSY")).toBe(false);
    expect(isOfferGoneCode("TRADE_CARD_NOT_OWNED")).toBe(false);
    expect(isOfferGoneCode(undefined)).toBe(false);
  });
});

describe("postTradeJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues the CSRF cookie and retries once with the same body (same requestId)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { error: "Forbidden", code: "CSRF_TOKEN_INVALID" }))
      .mockResolvedValueOnce(jsonResponse(200, { authenticated: true }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postTradeJson("/api/trades/o1/accept", { requestId: "req-1" });

    expect(result).toEqual({ ok: true, data: { success: true } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/session");
    const firstBody = (fetchMock.mock.calls[0][1] as RequestInit).body;
    const retryBody = (fetchMock.mock.calls[2][1] as RequestInit).body;
    expect(retryBody).toBe(firstBody);
    expect(JSON.parse(retryBody as string)).toEqual({ requestId: "req-1" });
  });

  it("does not retry when the CSRF retry is impossible and reports the code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { code: "CSRF_TOKEN_INVALID" }))
      .mockResolvedValueOnce(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postTradeJson("/api/trades", {});
    expect(result).toEqual({ ok: false, code: "CSRF_TOKEN_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a business 403 (TRADE_DISABLED)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(403, { code: "TRADE_DISABLED" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postTradeJson("/api/trades", {});
    expect(result).toEqual({ ok: false, code: "TRADE_DISABLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the maintenance guard message instead of TRADE_BUSY copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(503, {
          error: { code: "maintenance_read_only", message: "maintenance now", retryable: true },
        }),
      ),
    );
    const result = await postTradeJson("/api/trades", {});
    expect(result).toEqual({ ok: false, maintenanceMessage: "maintenance now" });
  });

  it("reports network failures separately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")));
    expect(await postTradeJson("/api/trades", {})).toEqual({ ok: false, networkError: true });
  });
});

describe("trade URLs", () => {
  it("encodes the whole returnTo including ?scope=cross as one parameter", () => {
    const href = tradeLoginHref(tradeBoardPath("s-1", "cross_channel"));
    expect(href).toBe("/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%3Fscope%3Dcross");
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("returnTo")).toBe("/trade/s-1?scope=cross");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("builds board/create paths per scope", () => {
    expect(tradeBoardPath("s-1", "in_channel")).toBe("/trade/s-1");
    expect(tradeCreatePath("s-1", "in_channel")).toBe("/trade/s-1/new");
    expect(tradeCreatePath("s-1", "cross_channel")).toBe("/trade/s-1/new?scope=cross");
  });
});

describe("tradeViewerKey (#1754 browser cache namespace)", () => {
  it("is 'anon' without a session", async () => {
    await expect(tradeViewerKey(null)).resolves.toBe("anon");
  });

  it("is stable per user, differs between users and does not contain the raw id", async () => {
    const a = await tradeViewerKey("123456789");
    expect(a).toMatch(/^u:[0-9a-f]{16}$/);
    expect(a).not.toContain("123456789");
    await expect(tradeViewerKey("123456789")).resolves.toBe(a);
    expect(await tradeViewerKey("987654321")).not.toBe(a);
    // A logged-in viewer can never collide with the anonymous namespace.
    expect(a).not.toBe("anon");
  });
});

describe("viewerSides (#1789)", () => {
  const card = (name: string) => ({ name, rarity: "rare", imageUrl: null }) as TradeOfferDto["offeredCard"];
  const offer = (overrides: Partial<TradeOfferDto>) =>
    ({
      offeredCard: card("Offered"),
      wantedCard: card("Wanted"),
      offeredCardId: "card-offered",
      wantedCardId: "card-wanted",
      wantedQuantity: 3,
      offerer: { twitchUsername: "offerer" },
      acceptedBy: { twitchUsername: "acceptor" },
      mineRole: "offerer",
      ...overrides,
    }) as unknown as TradeOfferDto;

  it("offerer gives the offered card (always 1) and gets wantedQuantity copies of the wanted card", () => {
    const sides = viewerSides(offer({ mineRole: "offerer" }));
    expect(sides.give).toMatchObject({ card: card("Offered"), deleted: false, quantity: 1 });
    expect(sides.get).toMatchObject({ card: card("Wanted"), deleted: false, quantity: 3 });
  });

  it("acceptor gives wantedQuantity copies of the wanted card and gets the offered card (always 1)", () => {
    const sides = viewerSides(offer({ mineRole: "acceptor" }));
    expect(sides.give).toMatchObject({ card: card("Wanted"), deleted: false, quantity: 3 });
    expect(sides.get).toMatchObject({ card: card("Offered"), deleted: false, quantity: 1 });
  });

  it("keeps quantity 1 on both sides for a classic 1:1 offer", () => {
    for (const mineRole of ["offerer", "acceptor"] as const) {
      const sides = viewerSides(offer({ mineRole, wantedQuantity: 1 }));
      expect(sides.give.quantity).toBe(1);
      expect(sides.get.quantity).toBe(1);
    }
  });
});
