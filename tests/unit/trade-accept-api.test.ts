import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  acceptTradeOffer: vi.fn(),
  getTradeOfferAuditParticipants: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/trade", () => ({
  acceptTradeOffer: mocks.acceptTradeOffer,
  getTradeOfferAuditParticipants: mocks.getTradeOfferAuditParticipants,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
  }),
  getRateLimitIdentifier: vi.fn().mockResolvedValue("user:viewer-1"),
  getClientIp: vi.fn().mockReturnValue("203.0.113.10"),
  rateLimits: { tradeWrite: {} },
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
vi.mock("@/lib/logger.server", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function request() {
  return new NextRequest(`http://localhost/api/trades/${OFFER_ID}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: REQUEST_ID }),
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
    });
  });

  it.each([
    ["TRADE_OFFER_NOT_FOUND", 404],
    ["OFFER_NOT_OPEN", 409],
    ["SELF_ACCEPT_FORBIDDEN", 400],
    ["OFFER_INVALID", 409],
    ["TRADE_DISABLED", 403],
    ["CARD_NOT_OWNED", 409],
    ["TRADE_BUSY", 503],
  ])("maps RPC error %s to HTTP %d", async (error, status) => {
    mocks.acceptTradeOffer.mockResolvedValue({ success: false, error });
    const { POST } = await import("@/app/api/trades/[id]/accept/route");

    const response = await POST(request(), {
      params: Promise.resolve({ id: OFFER_ID }),
    });

    expect(response.status).toBe(status);
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });

  it("logs participant IDs and the IP-derived identifier after success", async () => {
    mocks.acceptTradeOffer.mockResolvedValue({
      success: true,
      tradeOfferId: OFFER_ID,
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
        rateLimitIdentifier: "ip:203.0.113.10",
        idempotentReplay: false,
      }),
    );
  });

  it("keeps a committed success response even if audit metadata lookup fails", async () => {
    mocks.acceptTradeOffer.mockResolvedValue({
      success: true,
      tradeOfferId: OFFER_ID,
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
      expect.objectContaining({ offererTwitchUserId: null }),
    );
  });
});
