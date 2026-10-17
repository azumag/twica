import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Issue #1791: HTTP contract of /api/trades/auctions/**. The service layer is
// mocked; its SQL/RPC behaviour is covered by tests/unit/trade-auction-service.test.ts
// and on real PostgreSQL by tests/integration/trade-auction-pg.test.ts.

const mocks = vi.hoisted(() => {
  class TradeAuctionUnavailableError extends Error {}
  return {
    TradeAuctionUnavailableError,
    getSession: vi.fn(),
    listTradeAuctions: vi.fn(),
    getTradeAuction: vi.fn(),
    listMyTradeAuctions: vi.fn(),
    createTradeAuction: vi.fn(),
    placeTradeAuctionBid: vi.fn(),
    withdrawTradeAuctionBid: vi.fn(),
    cancelTradeAuction: vi.fn(),
    settleTradeAuction: vi.fn(),
    loggerInfo: vi.fn(),
    recordApiError: vi.fn(),
    validateCSRFToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade-auction", () => ({
  // Mirror the real constants (the real module pulls in the DB layer).
  TRADE_AUCTION_DURATIONS_HOURS: [24, 72, 168],
  TRADE_MAX_BID_QUANTITY: 10,
  TradeAuctionUnavailableError: mocks.TradeAuctionUnavailableError,
  listTradeAuctions: mocks.listTradeAuctions,
  getTradeAuction: mocks.getTradeAuction,
  listMyTradeAuctions: mocks.listMyTradeAuctions,
  createTradeAuction: mocks.createTradeAuction,
  placeTradeAuctionBid: mocks.placeTradeAuctionBid,
  withdrawTradeAuctionBid: mocks.withdrawTradeAuctionBid,
  cancelTradeAuction: mocks.cancelTradeAuction,
  settleTradeAuction: mocks.settleTradeAuction,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: vi.fn().mockResolvedValue("user:viewer-1"),
  rateLimits: { tradeWrite: { name: "tradeWrite" }, tradeRead: { name: "tradeRead" } },
}));
vi.mock("@/lib/csrf", () => ({ validateCSRFToken: mocks.validateCSRFToken }));
vi.mock("@/lib/request-validation", () => ({
  validateContentType: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/error-handler", () => ({ recordApiError: mocks.recordApiError }));
vi.mock("@/lib/logger.server", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

const AUCTION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const BID_ID = "44444444-4444-4444-8444-444444444444";
const STREAMER_ID = "55555555-5555-4555-8555-555555555555";
const COPY_ID = "66666666-6666-4666-8666-666666666666";

function post(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function get(path: string) {
  return new NextRequest(`http://localhost${path}`);
}
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
  mocks.validateCSRFToken.mockResolvedValue({ valid: true });
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 });
  mocks.recordApiError.mockResolvedValue(undefined);
});

describe("TRADE_AUCTION_ERROR_STATUS", () => {
  it("assigns the documented statuses", async () => {
    const { TRADE_AUCTION_ERROR_STATUS } = await import("@/lib/trade-api");
    expect(TRADE_AUCTION_ERROR_STATUS).toMatchObject({
      UNAUTHORIZED: 401,
      INVALID_REQUEST: 400,
      TRADE_BUSY: 503,
      TRADE_AUCTION_UNAVAILABLE: 503,
      TRADE_DISABLED: 403,
      TRADE_AUCTION_NOT_FOUND: 404,
      TRADE_AUCTION_BID_NOT_FOUND: 404,
      TRADE_AUCTION_SELF_BID: 400,
      TRADE_SAME_CARD: 400,
      TRADE_BID_CARD_UNAVAILABLE: 400,
      TRADE_CARD_NOT_OWNED: 400,
      TRADE_AUCTION_HAS_BIDS: 409,
      TRADE_AUCTION_BID_LOCKED: 409,
      TRADE_NOT_ENOUGH_CARDS: 409,
      TRADE_CARD_ALREADY_LISTED: 409,
      TRADE_OFFER_LIMIT: 409,
    });
  });
});

describe("POST /api/trades/auctions (create)", () => {
  const body = { offeredUserCardId: COPY_ID, durationHours: 72, requestId: REQUEST_ID };

  it("creates with the session user and logs an audit line", async () => {
    mocks.createTradeAuction.mockResolvedValue({
      kind: "ok",
      auction: { id: AUCTION_ID, endsAt: "e", selectionDeadline: "s", status: "open" },
      idempotentReplay: false,
    });
    const { POST } = await import("@/app/api/trades/auctions/route");
    const response = await POST(post("/api/trades/auctions", body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      auction: { id: AUCTION_ID, endsAt: "e", selectionDeadline: "s", status: "open" },
      idempotentReplay: false,
    });
    expect(mocks.createTradeAuction).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      offeredUserCardId: COPY_ID,
      durationHours: 72,
      requestId: REQUEST_ID,
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith("Trade auction created", expect.objectContaining({ auctionId: AUCTION_ID }));
  });

  it.each([
    ["duration not in 24/72/168", { ...body, durationHours: 48 }],
    ["duration as a string", { ...body, durationHours: "72" }],
    ["missing requestId", { offeredUserCardId: COPY_ID, durationHours: 24 }],
    ["malformed copy id", { ...body, offeredUserCardId: "x" }],
  ])("rejects %s with 400 INVALID_REQUEST", async (_label, invalid) => {
    const { POST } = await import("@/app/api/trades/auctions/route");
    const response = await POST(post("/api/trades/auctions", invalid));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.createTradeAuction).not.toHaveBeenCalled();
  });

  it.each([
    ["TRADE_CARD_ALREADY_LISTED", 409],
    ["TRADE_OFFER_LIMIT", 409],
    ["TRADE_DISABLED", 403],
    ["TRADE_AUCTION_UNAVAILABLE", 503],
    ["TRADE_BUSY", 503],
  ])("maps %s to %d", async (code, status) => {
    mocks.createTradeAuction.mockResolvedValue({ kind: "error", code });
    const { POST } = await import("@/app/api/trades/auctions/route");
    const response = await POST(post("/api/trades/auctions", body));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("requires a session and a valid CSRF token", async () => {
    const { POST } = await import("@/app/api/trades/auctions/route");
    mocks.validateCSRFToken.mockResolvedValueOnce({ valid: false });
    expect((await POST(post("/api/trades/auctions", body))).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(post("/api/trades/auctions", body))).status).toBe(401);
    expect(mocks.createTradeAuction).not.toHaveBeenCalled();
  });
});

describe("GET /api/trades/auctions (board)", () => {
  it("validates the query and passes the optional viewer", async () => {
    mocks.listTradeAuctions.mockResolvedValue({ auctions: [], page: 2, pageSize: 20, hasMore: false });
    const { GET } = await import("@/app/api/trades/auctions/route");
    const response = await GET(get(`/api/trades/auctions?streamerId=${STREAMER_ID}&scope=cross_channel&page=2`));
    expect(response.status).toBe(200);
    expect(mocks.listTradeAuctions).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      scope: "cross_channel",
      page: 2,
      twitchUserId: "viewer-1",
    });

    for (const query of ["streamerId=x", `streamerId=${STREAMER_ID}&scope=all`, `streamerId=${STREAMER_ID}&page=0`]) {
      expect((await GET(get(`/api/trades/auctions?${query}`))).status).toBe(400);
    }
  });

  it("answers 503 TRADE_AUCTION_UNAVAILABLE during the deploy window", async () => {
    mocks.listTradeAuctions.mockRejectedValue(new mocks.TradeAuctionUnavailableError());
    const { GET } = await import("@/app/api/trades/auctions/route");
    const response = await GET(get(`/api/trades/auctions?streamerId=${STREAMER_ID}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "TRADE_AUCTION_UNAVAILABLE" });
    expect(mocks.recordApiError).not.toHaveBeenCalled();
  });

  it("other failures are 500 and recorded", async () => {
    mocks.listTradeAuctions.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/trades/auctions/route");
    expect((await GET(get(`/api/trades/auctions?streamerId=${STREAMER_ID}`))).status).toBe(500);
    expect(mocks.recordApiError).toHaveBeenCalled();
  });
});

describe("GET /api/trades/auctions/[id] (detail)", () => {
  it("returns the detail, 404 when hidden/missing, 503 in the deploy window", async () => {
    const { GET } = await import("@/app/api/trades/auctions/[id]/route");
    mocks.getTradeAuction.mockResolvedValueOnce({ auction: { id: AUCTION_ID }, bids: null });
    const ok = await GET(get(`/api/trades/auctions/${AUCTION_ID}`), params({ id: AUCTION_ID }));
    expect(ok.status).toBe(200);
    expect(mocks.getTradeAuction).toHaveBeenCalledWith({ auctionId: AUCTION_ID, twitchUserId: "viewer-1" });

    mocks.getTradeAuction.mockResolvedValueOnce(null);
    const missing = await GET(get(`/api/trades/auctions/${AUCTION_ID}`), params({ id: AUCTION_ID }));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "TRADE_AUCTION_NOT_FOUND" });

    mocks.getTradeAuction.mockRejectedValueOnce(new mocks.TradeAuctionUnavailableError());
    expect((await GET(get(`/api/trades/auctions/${AUCTION_ID}`), params({ id: AUCTION_ID }))).status).toBe(503);

    expect((await GET(get("/api/trades/auctions/x"), params({ id: "x" }))).status).toBe(400);
  });
});

describe("POST /api/trades/auctions/[id]/bids", () => {
  const body = { bidCardId: CARD_ID, quantity: 3, requestId: REQUEST_ID };

  it("places a bid and logs it", async () => {
    mocks.placeTradeAuctionBid.mockResolvedValue({
      kind: "ok",
      bid: { id: BID_ID, auctionId: AUCTION_ID, bidCardId: CARD_ID, quantity: 3, status: "active" },
      replacedBidId: null,
      idempotentReplay: false,
    });
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/route");
    const response = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids`, body), params({ id: AUCTION_ID }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bid: { id: BID_ID }, replacedBidId: null });
    expect(mocks.placeTradeAuctionBid).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      auctionId: AUCTION_ID,
      bidCardId: CARD_ID,
      quantity: 3,
      requestId: REQUEST_ID,
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith("Trade auction bid placed", expect.objectContaining({ bidId: BID_ID }));
  });

  it.each([0, 11, 1.5, "2", null])("rejects quantity %s", async (quantity) => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/route");
    const response = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids`, { ...body, quantity }), params({ id: AUCTION_ID }));
    expect(response.status).toBe(400);
    expect(mocks.placeTradeAuctionBid).not.toHaveBeenCalled();
  });

  it.each([
    ["TRADE_AUCTION_SELF_BID", 400],
    ["TRADE_SAME_CARD", 400],
    ["TRADE_BID_CARD_UNAVAILABLE", 400],
    ["TRADE_AUCTION_NOT_FOUND", 404],
    ["TRADE_AUCTION_NOT_OPEN", 409],
    ["TRADE_BID_CARD_NOT_WANTABLE", 409],
    ["TRADE_AUCTION_BID_LIMIT", 409],
    ["TRADE_NOT_ENOUGH_CARDS", 409],
    ["TRADE_DISABLED", 403],
    ["TRADE_BUSY", 503],
  ])("maps %s to %d", async (code, status) => {
    mocks.placeTradeAuctionBid.mockResolvedValue({ kind: "error", code });
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/route");
    const response = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids`, body), params({ id: AUCTION_ID }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("rejects malformed JSON as 400", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/route");
    const response = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids`, "{"), params({ id: AUCTION_ID }));
    expect(response.status).toBe(400);
  });
});

describe("POST withdraw / cancel / settle", () => {
  it("withdraw passes the bid id and maps TRADE_AUCTION_BID_LOCKED to 409", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/[bidId]/withdraw/route");
    mocks.withdrawTradeAuctionBid.mockResolvedValueOnce({ kind: "ok", bidId: BID_ID, alreadyWithdrawn: false });
    const ok = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids/${BID_ID}/withdraw`), params({ id: AUCTION_ID, bidId: BID_ID }));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ success: true, bidId: BID_ID, alreadyWithdrawn: false });
    expect(mocks.withdrawTradeAuctionBid).toHaveBeenCalledWith({ twitchUserId: "viewer-1", bidId: BID_ID });

    mocks.withdrawTradeAuctionBid.mockResolvedValueOnce({ kind: "error", code: "TRADE_AUCTION_BID_LOCKED" });
    const locked = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids/${BID_ID}/withdraw`), params({ id: AUCTION_ID, bidId: BID_ID }));
    expect(locked.status).toBe(409);

    const bad = await POST(post(`/api/trades/auctions/${AUCTION_ID}/bids/x/withdraw`), params({ id: AUCTION_ID, bidId: "x" }));
    expect(bad.status).toBe(400);
  });

  it("cancel maps TRADE_AUCTION_HAS_BIDS to 409 and returns alreadyCancelled", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/cancel/route");
    mocks.cancelTradeAuction.mockResolvedValueOnce({ kind: "ok", auctionId: AUCTION_ID, alreadyCancelled: true });
    const ok = await POST(post(`/api/trades/auctions/${AUCTION_ID}/cancel`), params({ id: AUCTION_ID }));
    await expect(ok.json()).resolves.toEqual({ success: true, auctionId: AUCTION_ID, alreadyCancelled: true });
    mocks.cancelTradeAuction.mockResolvedValueOnce({ kind: "error", code: "TRADE_AUCTION_HAS_BIDS" });
    const conflict = await POST(post(`/api/trades/auctions/${AUCTION_ID}/cancel`), params({ id: AUCTION_ID }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "TRADE_AUCTION_HAS_BIDS" });
  });

  it("settle validates bidId/requestId, returns the transfer and logs every moved copy", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/settle/route");
    expect((await POST(post(`/api/trades/auctions/${AUCTION_ID}/settle`, { bidId: BID_ID }), params({ id: AUCTION_ID }))).status).toBe(400);
    expect(mocks.settleTradeAuction).not.toHaveBeenCalled();

    const settled = {
      kind: "ok",
      auctionId: AUCTION_ID,
      bidId: BID_ID,
      givenUserCardId: COPY_ID,
      receivedUserCardIds: [CARD_ID],
      quantity: 1,
      completedAt: "2026-10-17T00:00:00Z",
      idempotentReplay: false,
    };
    mocks.settleTradeAuction.mockResolvedValueOnce(settled);
    const ok = await POST(post(`/api/trades/auctions/${AUCTION_ID}/settle`, { bidId: BID_ID, requestId: REQUEST_ID }), params({ id: AUCTION_ID }));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      success: true,
      auctionId: AUCTION_ID,
      bidId: BID_ID,
      givenUserCardId: COPY_ID,
      receivedUserCardIds: [CARD_ID],
      quantity: 1,
      completedAt: "2026-10-17T00:00:00Z",
      idempotentReplay: false,
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Trade auction settled",
      expect.objectContaining({ givenUserCardId: COPY_ID, receivedUserCardIds: [CARD_ID] }),
    );

    for (const [code, status] of [
      ["TRADE_AUCTION_STILL_BIDDING", 409],
      ["TRADE_AUCTION_EXPIRED", 409],
      ["TRADE_AUCTION_BID_INVALID", 409],
      ["TRADE_AUCTION_BID_NOT_ACTIVE", 409],
      ["TRADE_AUCTION_BID_NOT_FOUND", 404],
    ] as const) {
      mocks.settleTradeAuction.mockResolvedValueOnce({ kind: "error", code });
      const response = await POST(post(`/api/trades/auctions/${AUCTION_ID}/settle`, { bidId: BID_ID, requestId: REQUEST_ID }), params({ id: AUCTION_ID }));
      expect(response.status, code).toBe(status);
    }
  });
});

describe("GET /api/trades/auctions/mine", () => {
  it("requires login, validates role and defaults to selling", async () => {
    const { GET } = await import("@/app/api/trades/auctions/mine/route");
    mocks.listMyTradeAuctions.mockResolvedValue({ auctions: [], page: 1, pageSize: 20, hasMore: false });
    expect((await GET(get("/api/trades/auctions/mine"))).status).toBe(200);
    expect(mocks.listMyTradeAuctions).toHaveBeenCalledWith("viewer-1", { role: "selling", page: 1 });
    await GET(get("/api/trades/auctions/mine?role=bidding&page=3"));
    expect(mocks.listMyTradeAuctions).toHaveBeenLastCalledWith("viewer-1", { role: "bidding", page: 3 });
    expect((await GET(get("/api/trades/auctions/mine?role=all"))).status).toBe(400);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await GET(get("/api/trades/auctions/mine"))).status).toBe(401);
  });

  it("answers 503 during the deploy window (the existing /api/trades/mine is unaffected)", async () => {
    const { GET } = await import("@/app/api/trades/auctions/mine/route");
    mocks.listMyTradeAuctions.mockRejectedValueOnce(new mocks.TradeAuctionUnavailableError());
    const response = await GET(get("/api/trades/auctions/mine"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "TRADE_AUCTION_UNAVAILABLE" });
  });
});
