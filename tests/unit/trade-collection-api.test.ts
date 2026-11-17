import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2079: GET /api/trades/collections/[streamerId]
 *
 * The endpoint is login-only and rate-limited like the existing /api/trades
 * lists. A collection the viewer does not own is answered as 404 (the same
 * "hidden and missing are indistinguishable" rule as the rest of the trade
 * API), never 403, so it cannot confirm that a channel exists.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  listTradeCollectionPage: vi.fn(),
  recordApiError: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { tradeRead: { name: "tradeRead" } },
}));
vi.mock("@/lib/error-handler", () => ({ recordApiError: mocks.recordApiError }));
vi.mock("@/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/trade-collections", () => ({
  listTradeCollectionPage: mocks.listTradeCollectionPage,
  TRADE_COLLECTION_PAGE_SIZE: 20,
}));

const STREAMER_ID = "11111111-1111-4111-8111-111111111111";

function request(query = "kind=offer&sort=newest") {
  return new NextRequest(
    `http://localhost/api/trades/collections/${STREAMER_ID}?${query}`,
  );
}

function call(query = "kind=offer&sort=newest") {
  return {
    request: request(query),
    params: Promise.resolve({ streamerId: STREAMER_ID }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
  mocks.getRateLimitIdentifier.mockResolvedValue("user:viewer-1");
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.listTradeCollectionPage.mockResolvedValue({
    kind: "offer",
    streamer: { id: STREAMER_ID, twitchUsername: "ch", twitchDisplayName: "Ch", twitchProfileImageUrl: null },
    offers: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
});

describe("GET /api/trades/collections/[streamerId]", () => {
  it("returns 401 before the rate limit or service for anonymous viewers", async () => {
    mocks.getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const res = await GET(call().request, call());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.listTradeCollectionPage).not.toHaveBeenCalled();
  });

  it("returns the tradeRead rate-limit response without reading the collection", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: 123,
    });
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const res = await GET(call().request, call());

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(mocks.listTradeCollectionPage).not.toHaveBeenCalled();
  });

  it("rejects an invalid streamer id and an unknown kind", async () => {
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const badId = await GET(
      request(),
      { params: Promise.resolve({ streamerId: "not-a-uuid" }) },
    );
    expect(badId.status).toBe(400);

    const badKind = await GET(call("kind=items&sort=newest").request, call("kind=items&sort=newest"));
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.listTradeCollectionPage).not.toHaveBeenCalled();
  });

  it("falls back to newest for an unknown sort and validates the page", async () => {
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const unknownSort = await GET(
      call("kind=auction&sort=rarity").request,
      call("kind=auction&sort=rarity"),
    );
    expect(unknownSort.status).toBe(200);
    expect(mocks.listTradeCollectionPage).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      streamerId: STREAMER_ID,
      kind: "auction",
      sort: "newest",
      page: 1,
    });

    const badPage = await GET(
      call("kind=offer&page=0").request,
      call("kind=offer&page=0"),
    );
    expect(badPage.status).toBe(400);
  });

  it("answers 404 for a collection the viewer does not own (service returns null)", async () => {
    mocks.listTradeCollectionPage.mockResolvedValue(null);
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const res = await GET(call().request, call());

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "TRADE_COLLECTION_NOT_FOUND" });
  });

  it("returns the offer/auction page from the shared service", async () => {
    const { GET } = await import("@/app/api/trades/collections/[streamerId]/route");

    const res = await GET(call().request, call());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "offer", total: 0, hasMore: false });
    expect(mocks.listTradeCollectionPage).toHaveBeenCalledWith({
      twitchUserId: "viewer-1",
      streamerId: STREAMER_ID,
      kind: "offer",
      sort: "newest",
      page: 1,
    });
  });
});
