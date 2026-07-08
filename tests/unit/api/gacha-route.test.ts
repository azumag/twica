import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/gacha/route";
import { GachaService } from "@/lib/services/gacha";
import { getSession } from "@/lib/session";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { broadcastGachaResult } from "@/lib/realtime";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/realtime");
vi.mock("@/lib/services/gacha");

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockBroadcastGachaResult = vi.mocked(broadcastGachaResult);
const MockGachaService = vi.mocked(GachaService);

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/gacha", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sampleCard = {
  id: "card-1",
  name: "Test Card",
  description: "desc",
  image_url: "https://example.com/card.png",
  rarity: "common",
};

describe("POST /api/gacha", () => {
  let executeGachaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetRateLimitIdentifier.mockResolvedValue("identifier");
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockValidateContentType.mockReturnValue(null);
    mockBroadcastGachaResult.mockResolvedValue(undefined);

    executeGachaMock = vi.fn().mockResolvedValue({
      success: true,
      data: { card: sampleCard, userTwitchUsername: "user1" },
    });
    MockGachaService.mockImplementation(() => ({
      executeGacha: executeGachaMock,
    }) as unknown as GachaService);
  });

  // Issue #661: execute_gacha_transaction RPC (migration 00073) now rejects
  // p_event_id = NULL. This route previously called executeGacha without an
  // eventId at all, which propagated as NULL all the way to the RPC. It must
  // now always supply a non-null, per-request-unique synthetic event id so
  // the manual "draw a real gacha" flow keeps working.
  it("passes a non-null, non-empty eventId to GachaService.executeGacha", async () => {
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));

    expect(res.status).toBe(200);
    expect(executeGachaMock).toHaveBeenCalledTimes(1);
    const eventIdArg = executeGachaMock.mock.calls[0][3];
    expect(eventIdArg).toBeTruthy();
    expect(typeof eventIdArg).toBe("string");
  });

  it("generates a distinct eventId on every call (no accidental dedup across separate draws)", async () => {
    await POST(makeRequest({ streamerId: "streamer-1" }));
    await POST(makeRequest({ streamerId: "streamer-1" }));

    const firstEventId = executeGachaMock.mock.calls[0][3];
    const secondEventId = executeGachaMock.mock.calls[1][3];
    expect(firstEventId).not.toBe(secondEventId);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(401);
    expect(executeGachaMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the CSRF token is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(403);
    expect(executeGachaMock).not.toHaveBeenCalled();
  });

  it("returns 500 when GachaService.executeGacha fails (e.g. the RPC rejects a NULL event_id)", async () => {
    executeGachaMock.mockResolvedValue({
      success: false,
      error: "Failed to execute gacha transaction: event_id must not be null",
    });
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(500);
  });
});
