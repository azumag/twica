import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/gacha-history/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
} from "@/lib/dashboard-data";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/dashboard-data");
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/constants")>();
  return { ...actual };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetGachaHistoryForStreamer = vi.mocked(getGachaHistoryForStreamer);
const mockGetGachaHistoryForUser = vi.mocked(getGachaHistoryForUser);

function primeStreamerLookup(rows: Array<{ id: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never);
  return { select, from, where, limit };
}

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/gacha-history");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe("GET /api/gacha-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(createRequest());
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "user1",
      twitchUsername: "user1",
      twitchDisplayName: "User 1",
      twitchProfileImageUrl: "",
      broadcasterType: "",
      expiresAt: Date.now() + 100000,
      version: 1,
    });
    mockCanUseStreamerFeatures.mockReturnValue(false);
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 60000,
    });

    const res = await GET(createRequest());
    expect(res.status).toBe(429);
  });

  it("returns viewer gacha history for non-streamers", async () => {
    const session = {
      twitchUserId: "viewer1",
      twitchUsername: "viewer1",
      twitchDisplayName: "Viewer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "",
      expiresAt: Date.now() + 100000,
      version: 1,
    };
    mockGetSession.mockResolvedValue(session);
    mockCanUseStreamerFeatures.mockReturnValue(false);

    const historyData = [
      {
        id: "h1",
        user_twitch_id: "viewer1",
        user_twitch_username: "viewer1",
        card_id: "c1",
        streamer_id: "s1",
        redeemed_at: "2026-01-01T00:00:00Z",
        cards: { id: "c1", name: "Card1", rarity: "common", image_url: null },
      },
    ];
    mockGetGachaHistoryForUser.mockResolvedValue({
      history: historyData,
      pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
    } as never);

    const res = await GET(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.history).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
    expect(mockGetGachaHistoryForUser).toHaveBeenCalledWith("viewer1", {
      page: 1,
      perPage: 20,
    });
  });

  it("returns streamer gacha history with filters", async () => {
    const session = {
      twitchUserId: "streamer1",
      twitchUsername: "streamer1",
      twitchDisplayName: "Streamer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 100000,
      version: 1,
    };
    mockGetSession.mockResolvedValue(session);
    mockCanUseStreamerFeatures.mockReturnValue(true);

    primeStreamerLookup([{ id: "streamer-id-1" }]);
    mockGetGachaHistoryForStreamer.mockResolvedValue({
      history: [],
      pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
    } as never);

    const res = await GET(
      createRequest({ username: "test", rarity: "epic", page: "1" })
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.history).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
    expect(mockGetGachaHistoryForStreamer).toHaveBeenCalledWith(
      "streamer-id-1",
      expect.objectContaining({ username: "test", rarity: "epic", page: 1 }),
    );
  });

  it("returns personal history for streamer with view=personal", async () => {
    const session = {
      twitchUserId: "streamer1",
      twitchUsername: "streamer1",
      twitchDisplayName: "Streamer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 100000,
      version: 1,
    };
    mockGetSession.mockResolvedValue(session);
    mockCanUseStreamerFeatures.mockReturnValue(true);

    mockGetGachaHistoryForUser.mockResolvedValue({
      history: [
        {
          id: "h1",
          user_twitch_id: "streamer1",
          user_twitch_username: "streamer1",
          card_id: "c1",
          streamer_id: "other-streamer",
          redeemed_at: "2026-01-01T00:00:00Z",
          cards: { id: "c1", name: "Card1", rarity: "rare", image_url: null },
        },
      ],
      pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
    } as never);

    const res = await GET(createRequest({ view: "personal" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.history).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns 404 when streamer not found", async () => {
    const session = {
      twitchUserId: "streamer1",
      twitchUsername: "streamer1",
      twitchDisplayName: "Streamer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 100000,
      version: 1,
    };
    mockGetSession.mockResolvedValue(session);
    mockCanUseStreamerFeatures.mockReturnValue(true);

    primeStreamerLookup([]);

    const res = await GET(createRequest());
    expect(res.status).toBe(404);
  });
});
