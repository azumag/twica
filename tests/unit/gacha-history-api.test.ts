import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/gacha-history/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  createMockQueryBuilder,
  createMockResponse,
} from "../utils/supabase-mock";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});
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
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

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

    // Mock gacha_history query for viewer
    // 視聴者向けガチャ履歴クエリのモック
    const historyQuery = createMockQueryBuilder();
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
    const historyResponse = {
      data: historyData,
      error: null,
      count: 1,
    };
    // Make query thenable for implicit await
    // 暗黙のawait用にthenableに設定
    (historyQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(historyResponse);
      return historyQuery;
    };

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.history).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
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

    // Streamer lookup + history query
    // 配信者検索 + 履歴クエリ
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse({ id: "streamer-id-1" })
    );

    const historyQuery = createMockQueryBuilder();
    const historyResponse = {
      data: [],
      error: null,
      count: 0,
    };
    (historyQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(historyResponse);
      return historyQuery;
    };

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        return historyQuery;
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest({ username: "test", rarity: "epic", page: "1" })
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.history).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
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

    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse(null)
    );

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => streamerQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest());
    expect(res.status).toBe(404);
  });
});
