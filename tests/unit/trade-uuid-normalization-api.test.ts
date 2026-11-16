import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Issue #2061: every UUID that arrives from the client at a /api/trades/**
// boundary must be handed to the service in the lowercase form the database
// returns. The services are mocked here: this file pins the API contract only
// (which argument each route passes). The service-side effects of uppercase
// input are covered in trade-service.test.ts / trade-auction-service.test.ts /
// trade-accept-service.test.ts.

const mocks = vi.hoisted(() => {
  class TradeAuctionUnavailableError extends Error {}
  return {
    TradeAuctionUnavailableError,
    getSession: vi.fn(),
    // src/lib/trade.ts
    acceptTradeOffer: vi.fn(),
    getTradeOfferAuditParticipants: vi.fn(),
    listTradeOffers: vi.fn(),
    createTradeOffer: vi.fn(),
    cancelTradeOffer: vi.fn(),
    // src/lib/trade-auction.ts
    listTradeAuctions: vi.fn(),
    getTradeAuction: vi.fn(),
    createTradeAuction: vi.fn(),
    placeTradeAuctionBid: vi.fn(),
    withdrawTradeAuctionBid: vi.fn(),
    cancelTradeAuction: vi.fn(),
    settleTradeAuction: vi.fn(),
    // shared request prelude
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    recordApiError: vi.fn(),
    validateCSRFToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade", () => ({
  // Mirror the real constants (the real module pulls in the DB layer).
  TRADE_MAX_WANTED_QUANTITY: 10,
  acceptTradeOffer: mocks.acceptTradeOffer,
  getTradeOfferAuditParticipants: mocks.getTradeOfferAuditParticipants,
  listTradeOffers: mocks.listTradeOffers,
  createTradeOffer: mocks.createTradeOffer,
  cancelTradeOffer: mocks.cancelTradeOffer,
}));
vi.mock("@/lib/trade-auction", () => ({
  TRADE_AUCTION_DURATIONS_HOURS: [24, 72, 168],
  TRADE_MAX_BID_QUANTITY: 10,
  TradeAuctionUnavailableError: mocks.TradeAuctionUnavailableError,
  listTradeAuctions: mocks.listTradeAuctions,
  getTradeAuction: mocks.getTradeAuction,
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
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

// Every id below contains hex letters, so toUpperCase() actually changes it.
const OFFER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const REQUEST_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const USER_CARD_ID = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const WANTED_CARD_ID = "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a";
const STREAMER_ID = "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b";
const AUCTION_ID = "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c";
const BID_ID = "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d";
const CARD_ID = "b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d1e";

const upper = (value: string) => value.toUpperCase();

const SESSION = { twitchUserId: "viewer-1" };

function postJson(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

const params = <T extends Record<string, string>>(value: T) => ({
  params: Promise.resolve(value),
});

function createOfferRow() {
  return {
    id: OFFER_ID,
    offered_user_card_id: USER_CARD_ID,
    offered_card_id: CARD_ID,
    offered_streamer_id: STREAMER_ID,
    wanted_card_id: WANTED_CARD_ID,
    wanted_streamer_id: STREAMER_ID,
    wanted_quantity: 1,
    offered_card_snapshot: {},
    wanted_card_snapshot: {},
    is_cross_channel: false,
    status: "open",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.validateCSRFToken.mockResolvedValue({ valid: true });
  mocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
  });
  mocks.recordApiError.mockResolvedValue(undefined);
  mocks.getTradeOfferAuditParticipants.mockResolvedValue({
    offererTwitchUserId: "offerer-1",
    givenUserCardIds: [USER_CARD_ID],
  });
  mocks.acceptTradeOffer.mockResolvedValue({
    success: true,
    tradeOfferId: OFFER_ID,
    givenUserCardId: USER_CARD_ID,
    idempotentReplay: false,
  });
  mocks.listTradeOffers.mockResolvedValue({ offers: [], page: 1, pageSize: 20, hasMore: false });
  mocks.createTradeOffer.mockResolvedValue({
    kind: "ok",
    offer: createOfferRow(),
    idempotentReplay: false,
  });
  mocks.cancelTradeOffer.mockResolvedValue({ kind: "ok", id: OFFER_ID });
  mocks.listTradeAuctions.mockResolvedValue({ auctions: [], page: 1, pageSize: 20, hasMore: false });
  mocks.getTradeAuction.mockResolvedValue({ auction: { id: AUCTION_ID } });
  mocks.createTradeAuction.mockResolvedValue({
    kind: "ok",
    auction: { id: AUCTION_ID, endsAt: "e", selectionDeadline: "s", status: "open" },
    idempotentReplay: false,
  });
  mocks.placeTradeAuctionBid.mockResolvedValue({
    kind: "ok",
    bid: { id: BID_ID, auctionId: AUCTION_ID, bidCardId: CARD_ID, quantity: 1, status: "active" },
    replacedBidId: null,
    idempotentReplay: false,
  });
  mocks.withdrawTradeAuctionBid.mockResolvedValue({
    kind: "ok",
    bidId: BID_ID,
    alreadyWithdrawn: false,
  });
  mocks.cancelTradeAuction.mockResolvedValue({
    kind: "ok",
    auctionId: AUCTION_ID,
    alreadyCancelled: false,
  });
  mocks.settleTradeAuction.mockResolvedValue({
    kind: "ok",
    auctionId: AUCTION_ID,
    bidId: BID_ID,
    givenUserCardId: USER_CARD_ID,
    receivedUserCardIds: [CARD_ID],
    quantity: 1,
    completedAt: "2026-01-01T00:00:00.000Z",
    idempotentReplay: false,
  });
});

describe("POST /api/trades/[id]/accept (#2061)", () => {
  it("normalizes the uppercase path id and requestId before the service call", async () => {
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const response = await POST(
      postJson(`/api/trades/${upper(OFFER_ID)}/accept`, { requestId: upper(REQUEST_ID) }),
      params({ id: upper(OFFER_ID) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.acceptTradeOffer).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      tradeOfferId: OFFER_ID,
      requestId: REQUEST_ID,
      expectedQuantity: 1,
    });
    // The post-commit audit lookup and the log use the same normalized id.
    expect(mocks.getTradeOfferAuditParticipants).toHaveBeenCalledWith(OFFER_ID);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Card trade completed",
      expect.objectContaining({ tradeOfferId: OFFER_ID }),
    );
  });

  it("still rejects a non-canonical value (braces are not an accepted notation)", async () => {
    const { POST } = await import("@/app/api/trades/[id]/accept/route");
    const response = await POST(
      postJson(`/api/trades/x/accept`, { requestId: REQUEST_ID }),
      params({ id: `{${upper(OFFER_ID)}}` }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_REQUEST");
    expect(mocks.acceptTradeOffer).not.toHaveBeenCalled();
  });
});

describe("POST /api/trades/[id]/cancel (#2061)", () => {
  it("normalizes the uppercase path id before the service call", async () => {
    const { POST } = await import("@/app/api/trades/[id]/cancel/route");
    const response = await POST(postJson(`/api/trades/${upper(OFFER_ID)}/cancel`), params({
      id: upper(OFFER_ID),
    }));

    expect(response.status).toBe(200);
    expect(mocks.cancelTradeOffer).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      tradeOfferId: OFFER_ID,
    });
  });
});

describe("GET /api/trades (#2061)", () => {
  it("normalizes the uppercase query UUIDs before the service call", async () => {
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(
      get(
        `/api/trades?streamerId=${upper(STREAMER_ID)}`
        + `&scope=cross_channel`
        + `&wantedCardId=${upper(WANTED_CARD_ID)}`
        + `&offeredCardId=${upper(USER_CARD_ID)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listTradeOffers).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      scope: "cross_channel",
      wantedCardId: WANTED_CARD_ID,
      offeredCardId: USER_CARD_ID,
      page: 1,
      twitchUserId: "viewer-1",
    });
  });
});

describe("POST /api/trades (#2061)", () => {
  it("normalizes the uppercase body UUIDs before the service call", async () => {
    const { POST } = await import("@/app/api/trades/route");
    const response = await POST(
      postJson("/api/trades", {
        offeredUserCardId: upper(USER_CARD_ID),
        wantedCardId: upper(WANTED_CARD_ID),
        wantedQuantity: 2,
        requestId: upper(REQUEST_ID),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createTradeOffer).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      offeredUserCardId: USER_CARD_ID,
      wantedCardId: WANTED_CARD_ID,
      wantedQuantity: 2,
      requestId: REQUEST_ID,
    });
  });
});

describe("GET /api/trades/auctions (#2061)", () => {
  it("normalizes the uppercase streamerId before the service call", async () => {
    const { GET } = await import("@/app/api/trades/auctions/route");
    const response = await GET(
      get(`/api/trades/auctions?streamerId=${upper(STREAMER_ID)}&scope=in_channel`),
    );

    expect(response.status).toBe(200);
    expect(mocks.listTradeAuctions).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-1",
    });
  });
});

describe("POST /api/trades/auctions (#2061)", () => {
  it("normalizes the uppercase body UUIDs before the service call", async () => {
    const { POST } = await import("@/app/api/trades/auctions/route");
    const response = await POST(
      postJson("/api/trades/auctions", {
        offeredUserCardId: upper(USER_CARD_ID),
        durationHours: 72,
        requestId: upper(REQUEST_ID),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createTradeAuction).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      offeredUserCardId: USER_CARD_ID,
      durationHours: 72,
      requestId: REQUEST_ID,
    });
  });
});

describe("GET /api/trades/auctions/[id] (#2061)", () => {
  it("normalizes the uppercase path id before the service call", async () => {
    const { GET } = await import("@/app/api/trades/auctions/[id]/route");
    const response = await GET(get(`/api/trades/auctions/${upper(AUCTION_ID)}`), params({
      id: upper(AUCTION_ID),
    }));

    expect(response.status).toBe(200);
    expect(mocks.getTradeAuction).toHaveBeenCalledWith({
      auctionId: AUCTION_ID,
      twitchUserId: "viewer-1",
    });
  });
});

describe("POST /api/trades/auctions/[id]/bids (#2061)", () => {
  it("normalizes the uppercase path and body UUIDs before the service call", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/bids/route");
    const response = await POST(
      postJson(`/api/trades/auctions/${upper(AUCTION_ID)}/bids`, {
        bidCardId: upper(CARD_ID),
        quantity: 1,
        requestId: upper(REQUEST_ID),
      }),
      params({ id: upper(AUCTION_ID) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.placeTradeAuctionBid).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      auctionId: AUCTION_ID,
      bidCardId: CARD_ID,
      quantity: 1,
      requestId: REQUEST_ID,
    });
  });
});

describe("POST /api/trades/auctions/[id]/bids/[bidId]/withdraw (#2061)", () => {
  it("normalizes the uppercase path ids before the service call", async () => {
    const { POST } = await import(
      "@/app/api/trades/auctions/[id]/bids/[bidId]/withdraw/route"
    );
    const response = await POST(
      postJson(`/api/trades/auctions/${upper(AUCTION_ID)}/bids/${upper(BID_ID)}/withdraw`),
      params({ id: upper(AUCTION_ID), bidId: upper(BID_ID) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.withdrawTradeAuctionBid).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      bidId: BID_ID,
      auctionId: AUCTION_ID,
    });
  });
});

describe("POST /api/trades/auctions/[id]/cancel (#2061)", () => {
  it("normalizes the uppercase path id before the service call", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/cancel/route");
    const response = await POST(
      postJson(`/api/trades/auctions/${upper(AUCTION_ID)}/cancel`),
      params({ id: upper(AUCTION_ID) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.cancelTradeAuction).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      auctionId: AUCTION_ID,
    });
  });
});

describe("POST /api/trades/auctions/[id]/settle (#2061)", () => {
  it("normalizes the uppercase path and body UUIDs before the service call", async () => {
    const { POST } = await import("@/app/api/trades/auctions/[id]/settle/route");
    const response = await POST(
      postJson(`/api/trades/auctions/${upper(AUCTION_ID)}/settle`, {
        bidId: upper(BID_ID),
        requestId: upper(REQUEST_ID),
      }),
      params({ id: upper(AUCTION_ID) }),
    );

    expect(response.status).toBe(200);
    expect(mocks.settleTradeAuction).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      auctionId: AUCTION_ID,
      bidId: BID_ID,
      requestId: REQUEST_ID,
    });
  });
});
