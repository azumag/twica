import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listTradeOffers: vi.fn(),
  createTradeOffer: vi.fn(),
  listMyTradeOffers: vi.fn(),
  cancelTradeOffer: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade", () => ({
  listTradeOffers: mocks.listTradeOffers,
  createTradeOffer: mocks.createTradeOffer,
  listMyTradeOffers: mocks.listMyTradeOffers,
  cancelTradeOffer: mocks.cancelTradeOffer,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
  getRateLimitIdentifier: vi.fn().mockResolvedValue("ip:test"),
  rateLimits: { tradeRead: {}, tradeWrite: {} },
}));
vi.mock("@/lib/csrf", () => ({
  validateCSRFToken: vi.fn().mockResolvedValue({ valid: true }),
}));
vi.mock("@/lib/request-validation", () => ({
  validateContentType: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/error-handler", () => ({
  handleApiError: vi.fn(() => new Response("error", { status: 500 })),
}));

const STREAMER_ID = "11111111-1111-4111-8111-111111111111";
const USER_CARD_ID = "22222222-2222-4222-8222-222222222222";
const WANTED_CARD_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const OFFER_ID = "55555555-5555-4555-8555-555555555555";

describe("trade API routes (#723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
    mocks.listTradeOffers.mockResolvedValue({
      offers: [],
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });

  it("GET /api/trades is publicly readable and passes filters to the service", async () => {
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

  it("GET /api/trades rejects malformed IDs before the data layer", async () => {
    const { GET } = await import("@/app/api/trades/route");
    const response = await GET(
      new NextRequest("http://localhost/api/trades?streamerId=not-a-uuid"),
    );

    expect(response.status).toBe(400);
    expect(mocks.listTradeOffers).not.toHaveBeenCalled();
  });

  it("POST /api/trades requires login and canonical UUID input", async () => {
    const { POST } = await import("@/app/api/trades/route");

    const unauthenticated = await POST(
      new NextRequest("http://localhost/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offeredUserCardId: USER_CARD_ID,
          wantedCardId: WANTED_CARD_ID,
          requestId: REQUEST_ID,
        }),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    mocks.getSession.mockResolvedValue({
      twitchUserId: "viewer-1",
      twitchUsername: "viewer",
      twitchDisplayName: "Viewer",
      twitchProfileImageUrl: null,
      broadcasterType: "",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
    const invalid = await POST(
      new NextRequest("http://localhost/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offeredUserCardId: "bad",
          wantedCardId: WANTED_CARD_ID,
          requestId: REQUEST_ID,
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(mocks.createTradeOffer).not.toHaveBeenCalled();
  });

  it("POST /api/trades forwards valid create input and returns replay marker", async () => {
    mocks.getSession.mockResolvedValue({
      twitchUserId: "viewer-1",
      twitchUsername: "viewer",
      twitchDisplayName: "Viewer",
      twitchProfileImageUrl: null,
      broadcasterType: "",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
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
    const response = await POST(
      new NextRequest("http://localhost/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offeredUserCardId: USER_CARD_ID,
          wantedCardId: WANTED_CARD_ID,
          requestId: REQUEST_ID,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      idempotentReplay: true,
      tradeOffer: { id: OFFER_ID },
    });
    expect(mocks.createTradeOffer).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      offeredUserCardId: USER_CARD_ID,
      wantedCardId: WANTED_CARD_ID,
      requestId: REQUEST_ID,
    });
  });

  it("cancel route validates path UUID and maps a non-open owned offer to 409", async () => {
    mocks.getSession.mockResolvedValue({
      twitchUserId: "viewer-1",
      twitchUsername: "viewer",
      twitchDisplayName: "Viewer",
      twitchProfileImageUrl: null,
      broadcasterType: "",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
    mocks.cancelTradeOffer.mockResolvedValue({
      kind: "error",
      code: "TRADE_OFFER_NOT_OPEN",
    });

    const { POST } = await import("@/app/api/trades/[id]/cancel/route");
    const response = await POST(
      new NextRequest(`http://localhost/api/trades/${OFFER_ID}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: OFFER_ID }) },
    );

    expect(response.status).toBe(409);
  });
});
