import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/gacha-stats/route";
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
  const url = new URL("http://localhost/api/gacha-stats");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe("GET /api/gacha-stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60000,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-streamers", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "viewer1",
      twitchUsername: "viewer1",
      twitchDisplayName: "Viewer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "",
      expiresAt: Date.now() + 100000,
      version: 1,
    });
    mockCanUseStreamerFeatures.mockReturnValue(false);

    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid period", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "streamer1",
      twitchUsername: "streamer1",
      twitchDisplayName: "Streamer 1",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 100000,
      version: 1,
    });
    mockCanUseStreamerFeatures.mockReturnValue(true);

    const res = await GET(createRequest({ period: "invalid" }));
    expect(res.status).toBe(400);
  });

  it("returns stats for valid streamer request", async () => {
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

    // Streamer lookup
    // 配信者検索
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse({ id: "streamer-id-1" })
    );

    const rpc = vi.fn((functionName: string) => {
      if (functionName === "get_gacha_drop_stats") {
        return Promise.resolve({
          data: {
            total_draws: 1001,
            card_stats: [
              {
                card_id: "c1",
                card_name: "Card1",
                rarity: "common",
                image_url: null,
                configured_rate: 100,
                actual_count: 1001,
                actual_rate: 100,
              },
            ],
            rarity_stats: [
              { rarity: "legendary", count: 0, rate: 0 },
              { rarity: "epic", count: 0, rate: 0 },
              { rarity: "rare", count: 0, rate: 0 },
              { rarity: "common", count: 1001, rate: 100 },
            ],
          },
          error: null,
        });
      }

      return Promise.resolve({
        data: {
          total_points: 250,
          ranking: [
            {
              user_twitch_id: "viewer1",
              username: "ViewerOne",
              total_points: 250,
              redemption_count: 2,
              last_redeemed_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
        error: null,
      });
    });

    const ownersQuery = createMockQueryBuilder();
    const ownersResponse = {
      data: [
        {
          card_id: "c1",
          obtained_at: "2026-01-01T00:00:00Z",
          users: {
            twitch_user_id: "viewer1",
            twitch_username: "alice",
            twitch_display_name: "Alice",
          },
        },
        {
          card_id: "c1",
          obtained_at: "2026-01-02T00:00:00Z",
          users: {
            twitch_user_id: "viewer1",
            twitch_username: "alice",
            twitch_display_name: "Alice",
          },
        },
      ],
      error: null,
    };
    (ownersQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(ownersResponse);
      return ownersQuery;
    };

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "user_cards") return ownersQuery;
        return createMockQueryBuilder();
      }),
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalDraws).toBe(1001);
    expect(body.cardStats).toHaveLength(1);
    expect(body.cardStats[0].cardName).toBe("Card1");
    expect(body.cardStats[0].actualCount).toBe(1001);
    expect(body.cardStats[0].actualRate).toBe(100);
    expect(body.cardStats[0].ownerCount).toBe(1);
    expect(body.cardStats[0].owners).toEqual([
      {
        userTwitchId: "viewer1",
        username: "alice",
        displayName: "Alice",
        ownedCount: 2,
        lastObtainedAt: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(body.rarityStats).toHaveLength(4);
    expect(body.channelPointStats.totalPoints).toBe(250);
    expect(body.channelPointStats.ranking).toEqual([
      {
        userTwitchId: "viewer1",
        username: "ViewerOne",
        totalPoints: 250,
        redemptionCount: 2,
        lastRedeemedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("get_channel_point_usage_stats", {
      p_streamer_id: "streamer-id-1",
      p_from_date: null,
      p_limit: 10,
    });
    expect(rpc).toHaveBeenCalledWith("get_gacha_drop_stats", {
      p_streamer_id: "streamer-id-1",
      p_from_date: expect.any(String),
    });
  });

  it("falls back to history aggregation when the channel point stats RPC is not deployed", async () => {
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
      createMockResponse({ id: "streamer-id-1" })
    );

    const historyRows = [
      {
        user_twitch_id: "viewer2",
        user_twitch_username: "ViewerTwo",
        reward_cost: 100,
        redeemed_at: "2026-01-03T00:00:00Z",
      },
      {
        user_twitch_id: "viewer1",
        user_twitch_username: "ViewerOne",
        reward_cost: 200,
        redeemed_at: "2026-01-02T00:00:00Z",
      },
      {
        user_twitch_id: "viewer2",
        user_twitch_username: "ViewerTwo",
        reward_cost: 100,
        redeemed_at: "2026-01-01T00:00:00Z",
      },
    ];
    const historyQuery = createMockQueryBuilder();
    Object.assign(historyQuery, {
      then: Promise.resolve({ data: historyRows, error: null }).then.bind(
        Promise.resolve({ data: historyRows, error: null })
      ),
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "gacha_history") return historyQuery;
        return createMockQueryBuilder();
      }),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42883", message: "function not found" },
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "30d" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalDraws).toBe(0);
    expect(body.cardStats).toEqual([]);
    expect(body.channelPointStats).toEqual({
      totalPoints: 400,
      ranking: [
        {
          userTwitchId: "viewer2",
          username: "ViewerTwo",
          totalPoints: 200,
          redemptionCount: 2,
          lastRedeemedAt: "2026-01-03T00:00:00Z",
        },
        {
          userTwitchId: "viewer1",
          username: "ViewerOne",
          totalPoints: 200,
          redemptionCount: 1,
          lastRedeemedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
  });
});
