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

  it("returns 400 for unknown period value", async () => {
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
                drawer_count: 1,
                drawers: [
                  {
                    user_twitch_id: "viewer1",
                    username: "alice",
                    draw_count: 1001,
                    last_drawn_at: "2026-01-02T00:00:00Z",
                  },
                ],
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

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
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
    expect(body.cardStats[0].drawerCount).toBe(1);
    expect(body.cardStats[0].drawers).toEqual([
      {
        userTwitchId: "viewer1",
        username: "alice",
        drawCount: 1001,
        lastDrawnAt: "2026-01-02T00:00:00Z",
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

  it("aggregates drop stats from history when get_gacha_drop_stats RPC errors", async () => {
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

    const thenable = (response: unknown) => {
      const q = createMockQueryBuilder();
      Object.assign(q, {
        then: Promise.resolve(response).then.bind(Promise.resolve(response)),
      });
      return q;
    };

    // 1回目の gacha_history = count-only クエリ、2回目 = 履歴サンプル
    const countQuery = thenable({ count: 3, error: null });
    const historySampleQuery = thenable({
      data: [
        { card_id: "c1", cards: { rarity: "common" } },
        { card_id: "c1", cards: { rarity: "common" } },
        { card_id: "c2", cards: { rarity: "legendary" } },
      ],
      error: null,
    });
    const cardsQuery = thenable({
      data: [
        {
          id: "c1",
          name: "Card1",
          rarity: "common",
          image_url: null,
          drop_rate: 7,
          rarity_order: 4,
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "c2",
          name: "Card2",
          rarity: "legendary",
          image_url: null,
          drop_rate: 3,
          rarity_order: 1,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    });
    const ownersQuery = thenable({ data: [], error: null });

    let gachaHistoryCalls = 0;
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "user_cards") return ownersQuery;
        if (table === "cards") return cardsQuery;
        if (table === "gacha_history") {
          gachaHistoryCalls += 1;
          return gachaHistoryCalls === 1 ? countQuery : historySampleQuery;
        }
        return createMockQueryBuilder();
      }),
      rpc: vi.fn((functionName: string) => {
        if (functionName === "get_gacha_drop_stats") {
          return Promise.resolve({
            data: null,
            error: { code: "P0001", message: "boom" },
          });
        }
        return Promise.resolve({
          data: { total_points: 0, ranking: [] },
          error: null,
        });
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalDraws).toBe(3);
    expect(body.cardStats).toHaveLength(2);

    const c1 = body.cardStats.find(
      (c: { cardId: string }) => c.cardId === "c1"
    );
    const c2 = body.cardStats.find(
      (c: { cardId: string }) => c.cardId === "c2"
    );
    expect(c1.actualCount).toBe(2);
    expect(c1.configuredRate).toBeCloseTo(70);
    expect(c1.actualRate).toBeCloseTo((2 / 3) * 100);
    expect(c2.actualCount).toBe(1);
    expect(c2.configuredRate).toBeCloseTo(30);
    expect(c2.actualRate).toBeCloseTo((1 / 3) * 100);

    const common = body.rarityStats.find(
      (r: { rarity: string }) => r.rarity === "common"
    );
    const legendary = body.rarityStats.find(
      (r: { rarity: string }) => r.rarity === "legendary"
    );
    expect(common.count).toBe(2);
    expect(legendary.count).toBe(1);
  });

  it("returns per-card owner stats for period=byCard", async () => {
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

    const rpc = vi.fn((functionName: string) => {
      if (functionName === "get_card_owner_stats") {
        return Promise.resolve({
          data: {
            card_stats: [
              {
                card_id: "c1",
                card_name: "Card1",
                rarity: "common",
                image_url: null,
                owner_count: 1,
                owners: [
                  {
                    user_twitch_id: "viewer1",
                    username: "alice",
                    display_name: "Alice",
                    owned_count: 2,
                    last_obtained_at: "2026-01-02T00:00:00Z",
                  },
                ],
              },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        return createMockQueryBuilder();
      }),
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "byCard" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cardStats).toEqual([
      {
        cardId: "c1",
        cardName: "Card1",
        rarity: "common",
        imageUrl: null,
        ownerCount: 1,
        owners: [
          {
            userTwitchId: "viewer1",
            username: "alice",
            displayName: "Alice",
            ownedCount: 2,
            lastObtainedAt: "2026-01-02T00:00:00Z",
          },
        ],
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("get_card_owner_stats", {
      p_streamer_id: "streamer-id-1",
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

  it("falls back to user_cards aggregation for byCard when get_card_owner_stats is not deployed", async () => {
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

    const thenable = (response: unknown) => {
      const q = createMockQueryBuilder();
      Object.assign(q, {
        then: Promise.resolve(response).then.bind(Promise.resolve(response)),
      });
      return q;
    };

    const cardsQuery = thenable({
      data: [
        {
          id: "c1",
          name: "Card1",
          rarity: "common",
          image_url: null,
          rarity_order: 4,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    });
    const userCardsQuery = thenable({
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
          obtained_at: "2026-01-03T00:00:00Z",
          users: {
            twitch_user_id: "viewer1",
            twitch_username: "alice",
            twitch_display_name: "Alice",
          },
        },
      ],
      error: null,
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "cards") return cardsQuery;
        if (table === "user_cards") return userCardsQuery;
        return createMockQueryBuilder();
      }),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42883", message: "function not found" },
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "byCard" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cardStats).toEqual([
      {
        cardId: "c1",
        cardName: "Card1",
        rarity: "common",
        imageUrl: null,
        ownerCount: 1,
        owners: [
          {
            userTwitchId: "viewer1",
            username: "alice",
            displayName: "Alice",
            ownedCount: 2,
            lastObtainedAt: "2026-01-03T00:00:00Z",
          },
        ],
      },
    ]);
  });

  it("aggregates period drawers from history when get_gacha_drop_stats RPC errors", async () => {
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

    const thenable = (response: unknown) => {
      const q = createMockQueryBuilder();
      Object.assign(q, {
        then: Promise.resolve(response).then.bind(Promise.resolve(response)),
      });
      return q;
    };

    const countQuery = thenable({ count: 3, error: null });
    const historySampleQuery = thenable({
      data: [
        {
          card_id: "c1",
          user_twitch_id: "viewer1",
          user_twitch_username: "alice",
          redeemed_at: "2026-01-01T00:00:00Z",
          cards: { rarity: "common" },
        },
        {
          card_id: "c1",
          user_twitch_id: "viewer1",
          user_twitch_username: "alice",
          redeemed_at: "2026-01-02T00:00:00Z",
          cards: { rarity: "common" },
        },
        {
          card_id: "c1",
          user_twitch_id: "viewer2",
          user_twitch_username: "bob",
          redeemed_at: "2026-01-03T00:00:00Z",
          cards: { rarity: "common" },
        },
      ],
      error: null,
    });
    const cardsQuery = thenable({
      data: [
        {
          id: "c1",
          name: "Card1",
          rarity: "common",
          image_url: null,
          drop_rate: 10,
          rarity_order: 4,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    });

    let gachaHistoryCalls = 0;
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "streamers") return streamerQuery;
        if (table === "cards") return cardsQuery;
        if (table === "gacha_history") {
          gachaHistoryCalls += 1;
          return gachaHistoryCalls === 1 ? countQuery : historySampleQuery;
        }
        return createMockQueryBuilder();
      }),
      rpc: vi.fn((functionName: string) => {
        if (functionName === "get_gacha_drop_stats") {
          return Promise.resolve({
            data: null,
            error: { code: "P0001", message: "boom" },
          });
        }
        return Promise.resolve({
          data: { total_points: 0, ranking: [] },
          error: null,
        });
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest({ period: "7d" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.totalDraws).toBe(3);
    expect(body.cardStats).toHaveLength(1);
    const c1 = body.cardStats[0];
    expect(c1.actualCount).toBe(3);
    expect(c1.drawerCount).toBe(2);
    // 引いた回数の多い順 → viewer1(2回) が先頭、viewer2(1回) が次
    expect(c1.drawers).toEqual([
      {
        userTwitchId: "viewer1",
        username: "alice",
        drawCount: 2,
        lastDrawnAt: "2026-01-02T00:00:00Z",
      },
      {
        userTwitchId: "viewer2",
        username: "bob",
        drawCount: 1,
        lastDrawnAt: "2026-01-03T00:00:00Z",
      },
    ]);
  });
});
