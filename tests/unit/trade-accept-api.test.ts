import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  acceptTradeOffer: vi.fn(),
  getTradeOfferAuditParticipants: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  recordApiError: vi.fn(),
  validateCSRFToken: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade", () => ({
  // Mirrors the real constant (the real module pulls in the DB layer).
  TRADE_MAX_WANTED_QUANTITY: 10,
  acceptTradeOffer: mocks.acceptTradeOffer,
  getTradeOfferAuditParticipants: mocks.getTradeOfferAuditParticipants,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: vi.fn().mockResolvedValue("user:viewer-1"),
  rateLimits: { tradeWrite: {} },
}));
vi.mock("@/lib/csrf", () => ({ validateCSRFToken: mocks.validateCSRFToken }));
vi.mock("@/lib/request-validation", () => ({
  validateContentType: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/error-handler", () => ({ recordApiError: mocks.recordApiError }));
vi.mock("@/lib/logger.server", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

/** user_cards ids of the copies the acceptor gave (oldest first). */
const GIVEN_IDS = Array.from(
  { length: 10 },
  (_, index) => `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
);
const givenIds = (count: number) => GIVEN_IDS.slice(0, count);

function request(body: string | Record<string, unknown> = { requestId: REQUEST_ID }) {
  return new NextRequest(`http://localhost/api/trades/${OFFER_ID}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/trades/[id]/accept (#724)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      twitchUserId: "viewer-1",
      twitchUsername: "viewer",
      twitchDisplayName: "Viewer",
      twitchProfileImageUrl: null,
      broadcasterType: "",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
    mocks.getTradeOfferAuditParticipants.mockResolvedValue({
      offererTwitchUserId: "offerer-1",
      givenUserCardIds: givenIds(1),
    });
    mocks.validateCSRFToken.mockResolvedValue({ valid: true });
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mocks.recordApiError.mockResolvedValue(undefined);
  });

  it.each([
    ["TRADE_OFFER_NOT_FOUND", 404, "TRADE_OFFER_NOT_FOUND"],
    ["OFFER_NOT_OPEN", 409, "TRADE_OFFER_NOT_OPEN"],
    ["SELF_ACCEPT_FORBIDDEN", 400, "TRADE_SELF_ACCEPT"],
    ["OFFER_INVALID", 409, "TRADE_OFFER_INVALID"],
    ["TRADE_DISABLED", 403, "TRADE_DISABLED"],
    ["CARD_NOT_OWNED", 409, "TRADE_CARD_NOT_OWNED"],
    // #1789: stale quantity → the row is outdated, same code as the precheck.
    ["QUANTITY_MISMATCH", 409, "TRADE_OFFER_UNAVAILABLE"],
    // #1790: the wanted card became non-wantable after the precheck. The
    // board already hides such offers, so the client treats it as gone.
    ["WANTED_CARD_NOT_WANTABLE", 409, "TRADE_OFFER_UNAVAILABLE"],
    ["TRADE_OFFER_UNAVAILABLE", 409, "TRADE_OFFER_UNAVAILABLE"],
    ["TRADE_BUSY", 503, "TRADE_BUSY"],
  ])("maps service error %s to HTTP %d and code %s", async (error, status, code) => {
    mocks.acceptTradeOffer.mockResolvedValue({ success: false, error });
    const { POST } = await import("@/app/api/trades/[id]/accept/route");

    const response = await POST(request(), {
      params: Promise.resolve({ id: OFFER_ID }),
    });

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe("string");
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });

  it("gives every 409 a distinct code", async () => {
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const codes = new Set<string>();
    for (const error of ["OFFER_NOT_OPEN", "OFFER_INVALID", "CARD_NOT_OWNED", "TRADE_OFFER_UNAVAILABLE"]) {
      mocks.acceptTradeOffer.mockResolvedValueOnce({ success: false, error });
      const response = await POST(request(), { params: Promise.resolve({ id: OFFER_ID }) });
      expect(response.status).toBe(409);
      codes.add((await response.json()).code);
    }
    expect(codes.size).toBe(4);
  });

  it.each([
    ["CSRF failure", () => mocks.validateCSRFToken.mockResolvedValue({ valid: false }), 403, "CSRF_TOKEN_INVALID"],
    ["missing session", () => mocks.getSession.mockResolvedValue(null), 401, "UNAUTHORIZED"],
    [
      "rate limit",
      () => mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: 1 }),
      429,
      "RATE_LIMIT_EXCEEDED",
    ],
  ])("answers %s with a coded error before calling the service", async (_label, arrange, status, code) => {
    arrange();
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const response = await POST(request(), { params: Promise.resolve({ id: OFFER_ID }) });
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
    expect(mocks.acceptTradeOffer).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed path id", "bad", JSON.stringify({ requestId: REQUEST_ID })],
    ["malformed JSON", OFFER_ID, "{"],
    ["missing requestId", OFFER_ID, "{}"],
  ])("answers 400 INVALID_REQUEST for %s", async (_label, id, body) => {
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const response = await POST(request(body), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_REQUEST");
    expect(mocks.acceptTradeOffer).not.toHaveBeenCalled();
    expect(mocks.recordApiError).not.toHaveBeenCalled();
  });

  describe("wantedQuantity (expected quantity, #1789)", () => {
    const post = async (body: string | Record<string, unknown>) => {
      const { POST } = await import("@/app/api/trades/[id]/accept/route");
      return POST(request(body), { params: Promise.resolve({ id: OFFER_ID }) });
    };
    const ok = () =>
      mocks.acceptTradeOffer.mockResolvedValue({
        success: true,
        tradeOfferId: OFFER_ID,
        givenUserCardId: GIVEN_IDS[0],
        idempotentReplay: false,
      });

    it("defaults a missing wantedQuantity to 1 (bundles that predate the field)", async () => {
      ok();
      const response = await post({ requestId: REQUEST_ID });
      expect(response.status).toBe(200);
      expect(mocks.acceptTradeOffer).toHaveBeenCalledWith({
        twitchUserId: "viewer-1",
        tradeOfferId: OFFER_ID,
        requestId: REQUEST_ID,
        expectedQuantity: 1,
      });
    });

    it.each([1, 3, 10])("passes wantedQuantity %d as expectedQuantity and logs it", async (quantity) => {
      ok();
      mocks.getTradeOfferAuditParticipants.mockResolvedValue({
        offererTwitchUserId: "offerer-1",
        givenUserCardIds: givenIds(quantity),
      });
      const response = await post({ requestId: REQUEST_ID, wantedQuantity: quantity });
      expect(response.status).toBe(200);
      expect(mocks.acceptTradeOffer).toHaveBeenCalledWith(
        expect.objectContaining({ expectedQuantity: quantity }),
      );
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        "Card trade completed",
        expect.objectContaining({ wantedQuantity: quantity }),
      );
    });

    it.each([
      ["0", 0],
      ["-1", -1],
      ["11", 11],
      ["1.5", 1.5],
      ["a string", "2"],
      ["null", null],
      ["an array", [3]],
      ["a boolean", true],
    ])("answers 400 INVALID_REQUEST for wantedQuantity %s without calling the service", async (_label, value) => {
      const response = await post({ requestId: REQUEST_ID, wantedQuantity: value });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("INVALID_REQUEST");
      expect(mocks.acceptTradeOffer).not.toHaveBeenCalled();
      expect(mocks.recordApiError).not.toHaveBeenCalled();
    });

    it("answers 409 TRADE_OFFER_UNAVAILABLE when the service reports QUANTITY_MISMATCH and does not log a completion", async () => {
      mocks.acceptTradeOffer.mockResolvedValue({ success: false, error: "QUANTITY_MISMATCH" });
      const response = await post({ requestId: REQUEST_ID, wantedQuantity: 2 });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("TRADE_OFFER_UNAVAILABLE");
      expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["service throws", () => mocks.acceptTradeOffer.mockRejectedValue(new Error("boom"))],
    ["unmapped error value", () => mocks.acceptTradeOffer.mockResolvedValue({ success: false, error: "FUTURE" })],
  ])("answers 500 INTERNAL_ERROR when the %s", async (_label, arrange) => {
    arrange();
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const response = await POST(request(), { params: Promise.resolve({ id: OFFER_ID }) });
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("INTERNAL_ERROR");
    expect(mocks.recordApiError).toHaveBeenCalledTimes(1);
  });

  it("logs participant IDs and the actual rate-limit identifier after success", async () => {
    mocks.acceptTradeOffer.mockResolvedValue({
      success: true,
      tradeOfferId: OFFER_ID,
      givenUserCardId: GIVEN_IDS[0],
      idempotentReplay: false,
    });
    const { POST } = await import("@/app/api/trades/[id]/accept/route");

    const response = await POST(request(), {
      params: Promise.resolve({ id: OFFER_ID }),
    });

    expect(response.status).toBe(200);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Card trade completed",
      expect.objectContaining({
        tradeOfferId: OFFER_ID,
        offererTwitchUserId: "offerer-1",
        accepterTwitchUserId: "viewer-1",
        rateLimitIdentifier: "user:viewer-1",
        idempotentReplay: false,
      }),
    );
  });

  it("keeps a committed success response even if audit metadata lookup fails", async () => {
    mocks.acceptTradeOffer.mockResolvedValue({
      success: true,
      tradeOfferId: OFFER_ID,
      givenUserCardId: GIVEN_IDS[0],
      idempotentReplay: true,
    });
    mocks.getTradeOfferAuditParticipants.mockRejectedValue(new Error("audit read failed"));
    const { POST } = await import("@/app/api/trades/[id]/accept/route");

    const response = await POST(request(), {
      params: Promise.resolve({ id: OFFER_ID }),
    });

    expect(response.status).toBe(200);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Card trade completed",
      // The oldest copy reported by the RPC is still logged.
      expect.objectContaining({ offererTwitchUserId: null, givenUserCardIds: [GIVEN_IDS[0]] }),
    );
  });

  describe("givenUserCardIds (every transferred copy, #1792)", () => {
    const post = async (wantedQuantity: number) => {
      const { POST } = await import("@/app/api/trades/[id]/accept/route");
      return POST(request({ requestId: REQUEST_ID, wantedQuantity }), {
        params: Promise.resolve({ id: OFFER_ID }),
      });
    };
    const accepted = (idempotentReplay: boolean) =>
      mocks.acceptTradeOffer.mockResolvedValue({
        success: true,
        tradeOfferId: OFFER_ID,
        givenUserCardId: GIVEN_IDS[0],
        idempotentReplay,
      });

    it("returns all N ids next to the legacy givenUserCardId and logs them", async () => {
      accepted(false);
      mocks.getTradeOfferAuditParticipants.mockResolvedValue({
        offererTwitchUserId: "offerer-1",
        givenUserCardIds: givenIds(3),
      });

      const response = await post(3);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.givenUserCardId).toBe(GIVEN_IDS[0]);
      expect(body.givenUserCardIds).toEqual(givenIds(3));
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        "Card trade completed",
        expect.objectContaining({ givenUserCardIds: givenIds(3) }),
      );
      expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it.each([
      ["fewer ids than the agreed quantity", givenIds(2)],
      ["more ids than the agreed quantity", givenIds(4)],
      ["ids that do not include the RPC's oldest copy", [GIVEN_IDS[5], GIVEN_IDS[6], GIVEN_IDS[7]]],
    ])("falls back to the known oldest id and warns on a first acceptance when the lookup has %s", async (_label, looked) => {
      accepted(false);
      mocks.getTradeOfferAuditParticipants.mockResolvedValue({
        offererTwitchUserId: "offerer-1",
        givenUserCardIds: looked,
      });

      const response = await post(3);

      expect(response.status).toBe(200);
      expect((await response.json()).givenUserCardIds).toEqual([GIVEN_IDS[0]]);
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        "Trade given user card ids could not be fully reconstructed",
        expect.objectContaining({ tradeOfferId: OFFER_ID, wantedQuantity: 3, lookedUpCount: looked.length }),
      );
    });

    it("does not warn for an idempotent replay whose copies were traded on meanwhile", async () => {
      accepted(true);
      mocks.getTradeOfferAuditParticipants.mockResolvedValue({
        offererTwitchUserId: "offerer-1",
        givenUserCardIds: [],
      });

      const response = await post(3);

      expect(response.status).toBe(200);
      expect((await response.json()).givenUserCardIds).toEqual([GIVEN_IDS[0]]);
      expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });
  });
});
