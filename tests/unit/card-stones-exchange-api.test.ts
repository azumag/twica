import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/card-stones/exchange/route";
import { validateCSRFToken } from "@/lib/csrf";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

vi.mock("@/lib/csrf");
vi.mock("@/lib/session");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: Date.now() + 60_000,
  }),
  getRateLimitIdentifier: vi.fn().mockResolvedValue("user:user-1"),
  rateLimits: { cardsPost: {} },
}));

const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockGetSession = vi.mocked(getSession);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

const cardId = "11111111-1111-4111-8111-111111111111";

function createRequest(body: unknown = { cardId }) {
  return new NextRequest("http://localhost:3000/api/card-stones/exchange", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/card-stones/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockGetSession.mockResolvedValue({
      twitchUserId: "viewer-1",
      twitchUsername: "viewer",
      twitchDisplayName: "Viewer",
      twitchProfileImageUrl: "",
      broadcasterType: "",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
  });

  it("exchanges one duplicate card through the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        cardId,
        stonesGained: 3,
        balance: 12,
        remainingCount: 2,
      },
      error: null,
    });
    mockGetSupabaseAdmin.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cardId,
      stonesGained: 3,
      balance: 12,
      remainingCount: 2,
    });
    expect(rpc).toHaveBeenCalledWith("exchange_duplicate_card_for_stones", {
      p_twitch_user_id: "viewer-1",
      p_card_id: cardId,
    });
  });

  it("returns 409 when the card has no duplicate copy", async () => {
    mockGetSupabaseAdmin.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "NO_DUPLICATE_CARD" },
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const response = await POST(createRequest());
    expect(response.status).toBe(409);
  });

  it("rejects invalid card ids", async () => {
    const response = await POST(createRequest({ cardId: "not-a-uuid" }));
    expect(response.status).toBe(400);
  });
});
