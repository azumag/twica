import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listTradeOffers: vi.fn(),
  createTradeOffer: vi.fn(),
  listMyTradeOffers: vi.fn(),
  cancelTradeOffer: vi.fn(),
  checkRateLimit: vi.fn(),
  validateCSRFToken: vi.fn(),
  validateContentType: vi.fn(),
  recordApiError: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade", () => ({
  listTradeOffers: mocks.listTradeOffers,
  createTradeOffer: mocks.createTradeOffer,
  listMyTradeOffers: mocks.listMyTradeOffers,
  cancelTradeOffer: mocks.cancelTradeOffer,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: vi.fn().mockResolvedValue("ip:test"),
  rateLimits: { tradeRead: {}, tradeWrite: {} },
}));
vi.mock("@/lib/csrf", () => ({ validateCSRFToken: mocks.validateCSRFToken }));
vi.mock("@/lib/request-validation", () => ({
  validateContentType: mocks.validateContentType,
}));
vi.mock("@/lib/error-handler", () => ({ recordApiError: mocks.recordApiError }));

const STREAMER_ID = "11111111-1111-4111-8111-111111111111";
const USER_CARD_ID = "22222222-2222-4222-8222-222222222222";
const WANTED_CARD_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const OFFER_ID = "55555555-5555-4555-8555-555555555555";

const SESSION = {
  twitchUserId: "viewer-1",
  twitchUsername: "viewer",
  twitchDisplayName: "Viewer",
  twitchProfileImageUrl: null,
  broadcasterType: "",
  expiresAt: Date.now() + 60_000,
  version: 1,
};

function postJson(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_CREATE_BODY = {
  offeredUserCardId: USER_CARD_ID,
  wantedCardId: WANTED_CARD_ID,
  requestId: REQUEST_ID,
};

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.code).toBe(code);
  // `error` is kept for existing clients.
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  });
  mocks.validateCSRFToken.mockResolvedValue({ valid: true });
  mocks.validateContentType.mockReturnValue(null);
  mocks.recordApiError.mockResolvedValue(undefined);
  mocks.listTradeOffers.mockResolvedValue({
    offers: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
  mocks.listMyTradeOffers.mockResolvedValue({
    offers: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
});

describe("GET /api/trades (#723, #715 PR-C)", () => {
  it("is publicly readable and passes filters to the service", async () => {
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(
      new NextRequest(
        `http://localhost/api/trades?streamerId=${STREAMER_ID}&scope=cross_channel&page=2`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listTradeOffers).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      scope: "cross_channel",
      wantedCardId: undefined,
      offeredCardId: undefined,
      page: 2,
      twitchUserId: undefined,
    });
  });

  it.each([
    ["malformed streamerId", "streamerId=not-a-uuid"],
    ["unknown scope", `streamerId=${STREAMER_ID}&scope=global`],
    ["malformed wantedCardId", `streamerId=${STREAMER_ID}&wantedCardId=x`],
    ["malformed offeredCardId", `streamerId=${STREAMER_ID}&offeredCardId=x`],
    ["page 0", `streamerId=${STREAMER_ID}&page=0`],
    ["page too large", `streamerId=${STREAMER_ID}&page=100001`],
  ])("rejects %s with 400 INVALID_REQUEST before the data layer", async (_label, query) => {
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(new NextRequest(`http://localhost/api/trades?${query}`));
    await expectError(response, 400, "INVALID_REQUEST");
    expect(mocks.listTradeOffers).not.toHaveBeenCalled();
  });

  it("answers 429 RATE_LIMIT_EXCEEDED with rate-limit headers", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 100, remaining: 0, reset: 123 });
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(
      new NextRequest(`http://localhost/api/trades?streamerId=${STREAMER_ID}`),
    );
    await expectError(response, 429, "RATE_LIMIT_EXCEEDED");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe("123");
  });

  it("records unexpected failures and answers 500 INTERNAL_ERROR", async () => {
    const failure = new Error("db down");
    mocks.listTradeOffers.mockRejectedValue(failure);
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(
      new NextRequest(`http://localhost/api/trades?streamerId=${STREAMER_ID}`),
    );
    await expectError(response, 500, "INTERNAL_ERROR");
    expect(mocks.recordApiError).toHaveBeenCalledWith(failure, "Trade offers list");
  });
});

describe("POST /api/trades (#723, #715 PR-C)", () => {
  it("answers 415 UNSUPPORTED_MEDIA_TYPE keeping the validator's message", async () => {
    mocks.validateContentType.mockReturnValue(
      NextResponse.json({ error: "Content-Type header is required" }, { status: 415 }),
    );
    const { POST } = await import("@/app/api/trades/route");
    const body = await expectError(
      await POST(postJson("/api/trades", VALID_CREATE_BODY)),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(body.error).toBe("Content-Type header is required");
    expect(mocks.createTradeOffer).not.toHaveBeenCalled();
  });

  it("answers 403 CSRF_TOKEN_INVALID (distinct from 403 TRADE_DISABLED)", async () => {
    mocks.validateCSRFToken.mockResolvedValue({ valid: false });
    const { POST } = await import("@/app/api/trades/route");
    const body = await expectError(
      await POST(postJson("/api/trades", VALID_CREATE_BODY)),
      403,
      "CSRF_TOKEN_INVALID",
    );
    expect(body.error).toBe("Forbidden");
  });

  it("answers 401 UNAUTHORIZED without a session", async () => {
    const { POST } = await import("@/app/api/trades/route");
    await expectError(await POST(postJson("/api/trades", VALID_CREATE_BODY)), 401, "UNAUTHORIZED");
  });

  it("answers 429 RATE_LIMIT_EXCEEDED for write bursts", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: 1 });
    const { POST } = await import("@/app/api/trades/route");
    await expectError(
      await POST(postJson("/api/trades", VALID_CREATE_BODY)),
      429,
      "RATE_LIMIT_EXCEEDED",
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["array body", "[]"],
    ["bad offeredUserCardId", { ...VALID_CREATE_BODY, offeredUserCardId: "bad" }],
    ["missing requestId", { ...VALID_CREATE_BODY, requestId: undefined }],
  ])("answers 400 INVALID_REQUEST for %s", async (_label, body) => {
    mocks.getSession.mockResolvedValue(SESSION);
    const { POST } = await import("@/app/api/trades/route");
    await expectError(await POST(postJson("/api/trades", body)), 400, "INVALID_REQUEST");
    expect(mocks.createTradeOffer).not.toHaveBeenCalled();
    expect(mocks.recordApiError).not.toHaveBeenCalled();
  });

  it.each([
    ["TRADE_DISABLED", 403],
    ["TRADE_CARD_NOT_OWNED", 400],
    ["TRADE_CARD_ALREADY_LISTED", 409],
    ["TRADE_OFFER_LIMIT", 409],
    ["TRADE_SAME_CARD", 400],
    ["TRADE_WANTED_CARD_UNAVAILABLE", 400],
    ["TRADE_OFFERED_CARD_INACTIVE", 409],
  ])("maps service error %s to HTTP %d with the same code", async (code, status) => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.createTradeOffer.mockResolvedValue({ kind: "error", code });
    const { POST } = await import("@/app/api/trades/route");
    await expectError(await POST(postJson("/api/trades", VALID_CREATE_BODY)), status, code);
  });

  it("records unexpected failures and answers 500 INTERNAL_ERROR", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.createTradeOffer.mockRejectedValue(new Error("boom"));
    const { POST } = await import("@/app/api/trades/route");
    await expectError(
      await POST(postJson("/api/trades", VALID_CREATE_BODY)),
      500,
      "INTERNAL_ERROR",
    );
    expect(mocks.recordApiError).toHaveBeenCalledTimes(1);
  });

  it("forwards valid create input and returns replay marker", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.createTradeOffer.mockResolvedValue({
      kind: "ok",
      idempotentReplay: true,
      offer: {
        id: OFFER_ID,
        offered_user_card_id: USER_CARD_ID,
        offered_card_id: "66666666-6666-4666-8666-666666666666",
        offered_streamer_id: STREAMER_ID,
        wanted_card_id: WANTED_CARD_ID,
        wanted_streamer_id: STREAMER_ID,
        offered_card_snapshot: { name: "A" },
        wanted_card_snapshot: { name: "B" },
        is_cross_channel: false,
        status: "open",
        created_at: "2026-10-04T00:00:00.000Z",
      },
    });

    const { POST } = await import("@/app/api/trades/route");
    const response = await POST(postJson("/api/trades", VALID_CREATE_BODY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      idempotentReplay: true,
      tradeOffer: { id: OFFER_ID },
    });
    expect(mocks.createTradeOffer).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      ...VALID_CREATE_BODY,
    });
  });
});

describe("GET /api/trades/mine (#715 PR-C)", () => {
  const mineRequest = (query = "") =>
    new NextRequest(`http://localhost/api/trades/mine${query ? `?${query}` : ""}`);

  it("answers 401 UNAUTHORIZED without a session", async () => {
    const { GET } = await import("@/app/api/trades/mine/route");
    await expectError(await GET(mineRequest()), 401, "UNAUTHORIZED");
  });

  it("answers 429 RATE_LIMIT_EXCEEDED", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 100, remaining: 0, reset: 1 });
    const { GET } = await import("@/app/api/trades/mine/route");
    await expectError(await GET(mineRequest()), 429, "RATE_LIMIT_EXCEEDED");
  });

  it.each(["status=pending", "status=", "page=0", "page=abc"])(
    "rejects %s with 400 INVALID_REQUEST",
    async (query) => {
      mocks.getSession.mockResolvedValue(SESSION);
      const { GET } = await import("@/app/api/trades/mine/route");
      await expectError(await GET(mineRequest(query)), 400, "INVALID_REQUEST");
      expect(mocks.listMyTradeOffers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", { status: undefined, page: 1 }],
    ["status=open", { status: "open", page: 1 }],
    ["status=completed&page=3", { status: "completed", page: 3 }],
    ["status=cancelled", { status: "cancelled", page: 1 }],
  ])("passes ?%s to the service and returns its page", async (query, expected) => {
    mocks.getSession.mockResolvedValue(SESSION);
    const page = { offers: [{ id: OFFER_ID }], page: expected.page, pageSize: 20, hasMore: true };
    mocks.listMyTradeOffers.mockResolvedValue(page);
    const { GET } = await import("@/app/api/trades/mine/route");
    const response = await GET(mineRequest(query));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(page);
    expect(mocks.listMyTradeOffers).toHaveBeenCalledWith("viewer-1", expected);
  });

  it("answers 500 INTERNAL_ERROR on unexpected failure", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listMyTradeOffers.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/trades/mine/route");
    await expectError(await GET(mineRequest()), 500, "INTERNAL_ERROR");
  });
});

describe("POST /api/trades/[id]/cancel (#723, #715 PR-C)", () => {
  const cancel = async (id = OFFER_ID) => {
    const { POST } = await import("@/app/api/trades/[id]/cancel/route");
    return POST(postJson(`/api/trades/${id}/cancel`), {
      params: Promise.resolve({ id }),
    });
  };

  it("answers 403 CSRF_TOKEN_INVALID / 401 UNAUTHORIZED / 400 INVALID_REQUEST", async () => {
    mocks.validateCSRFToken.mockResolvedValueOnce({ valid: false });
    await expectError(await cancel(), 403, "CSRF_TOKEN_INVALID");
    await expectError(await cancel(), 401, "UNAUTHORIZED");
    mocks.getSession.mockResolvedValue(SESSION);
    await expectError(await cancel("bad"), 400, "INVALID_REQUEST");
  });

  it.each([
    ["TRADE_OFFER_NOT_FOUND", 404],
    ["TRADE_OFFER_NOT_OPEN", 409],
  ])("maps %s to HTTP %d with code", async (code, status) => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.cancelTradeOffer.mockResolvedValue({ kind: "error", code });
    await expectError(await cancel(), status, code);
  });

  it("answers 500 INTERNAL_ERROR on unexpected failure", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.cancelTradeOffer.mockRejectedValue(new Error("boom"));
    await expectError(await cancel(), 500, "INTERNAL_ERROR");
  });
});
