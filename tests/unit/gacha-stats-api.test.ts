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

    // getGachaStats accesses gacha_history twice:
    // 1st: count-only query (select("id", { count: "exact", head: true }))
    // 2nd: data query (draw/card/point data for aggregation)
    // getGachaStats は gacha_history に2回アクセスする:
    // 1回目: count-only クエリ、2回目: データ取得クエリ
    const countQuery = createMockQueryBuilder();
    const countResponse = { data: null, error: null, count: 1 };
    (countQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(countResponse);
      return countQuery;
    };

    const historyQuery = createMockQueryBuilder();
    const historyResponse = {
      data: [
        {
          card_id: "c1",
          user_twitch_id: "viewer1",
          user_twitch_username: "ViewerOne",
          reward_cost: 100,
          redeemed_at: "2026-01-01T00:00:00Z",
          cards: { rarity: "common" },
        },
      ],
      error: null,
    };
    (historyQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(historyResponse);
      return historyQuery;
    };

    // Cards query (for allCards in getGachaStats)
    // カードクエリ（getGachaStats内のallCards用）
    const cardsQuery = createMockQueryBuilder();
    const cardsResponse = {
      data: [
        {
          id: "c1",
          name: "Card1",
          rarity: "common",
          image_url: null,
          drop_rate: 100,
        },
      ],
      error: null,
    };
    (cardsQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve(cardsResponse);
      return cardsQuery;
    };

    const rpc = vi.fn().mockResolvedValue({
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

    // Track gacha_history call order to return count query first, then data query
    // gacha_history の呼び出し順を追跡し、最初にcountクエリ、次にデータクエリを返す
    let gachaHistoryCallCount = 0;
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "gacha_history") {
          gachaHistoryCallCount++;
          return gachaHistoryCallCount === 1 ? countQuery : historyQuery;
        }
        if (table === "cards") return cardsQuery;
        return createMockQueryBuilder();
      }),
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalDraws).toBe(1);
    expect(body.cardStats).toHaveLength(1);
    expect(body.cardStats[0].cardName).toBe("Card1");
    expect(body.cardStats[0].actualCount).toBe(1);
    expect(body.cardStats[0].actualRate).toBe(100);
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
      p_from_date: expect.any(String),
      p_limit: 10,
    });
  });

  it("falls back to history rows when channel point stats RPC is not deployed", async () => {
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

    const countQuery = createMockQueryBuilder();
    (countQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve({ data: null, error: null, count: 3 });
      return countQuery;
    };

    const historyQuery = createMockQueryBuilder();
    (historyQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve({
        data: [
          {
            card_id: "c1",
            user_twitch_id: "viewer1",
            user_twitch_username: "ViewerOne",
            reward_cost: 100,
            redeemed_at: "2026-01-01T00:00:00Z",
            cards: { rarity: "common" },
          },
          {
            card_id: "c1",
            user_twitch_id: "viewer1",
            user_twitch_username: "ViewerOne",
            reward_cost: 200,
            redeemed_at: "2026-01-02T00:00:00Z",
            cards: { rarity: "common" },
          },
          {
            card_id: "c2",
            user_twitch_id: "viewer2",
            user_twitch_username: "ViewerTwo",
            reward_cost: 250,
            redeemed_at: "2026-01-03T00:00:00Z",
            cards: { rarity: "rare" },
          },
        ],
        error: null,
      });
      return historyQuery;
    };

    const cardsQuery = createMockQueryBuilder();
    (cardsQuery as unknown as Record<string, unknown>).then = (
      resolve: (value: unknown) => void
    ) => {
      resolve({
        data: [
          {
            id: "c1",
            name: "Card1",
            rarity: "common",
            image_url: null,
            drop_rate: 50,
          },
          {
            id: "c2",
            name: "Card2",
            rarity: "rare",
            image_url: null,
            drop_rate: 50,
          },
        ],
        error: null,
      });
      return cardsQuery;
    };

    let gachaHistoryCallCount = 0;
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "gacha_history") {
          gachaHistoryCallCount++;
          return gachaHistoryCallCount === 1 ? countQuery : historyQuery;
        }
        if (table === "cards") return cardsQuery;
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
    expect(body.channelPointStats.totalPoints).toBe(550);
    expect(body.channelPointStats.ranking).toEqual([
      {
        userTwitchId: "viewer1",
        username: "ViewerOne",
        totalPoints: 300,
        redemptionCount: 2,
        lastRedeemedAt: "2026-01-02T00:00:00Z",
      },
      {
        userTwitchId: "viewer2",
        username: "ViewerTwo",
        totalPoints: 250,
        redemptionCount: 1,
        lastRedeemedAt: "2026-01-03T00:00:00Z",
      },
    ]);
  });
});
