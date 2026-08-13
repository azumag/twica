/**
 * #739: 配信中ページ（/live）データ層 getLiveDirectory() のテスト。
 *
 * RPC+Helix 合成 / Helix バッチ分割（101人→2リクエスト）/ 障害時空配列 +
 * reportError / RSCへ不要な統計を渡さないこと / KV キャッシュ / ローカルメモ化と、
 * 匿名ランキングの識別情報ホワイトリストを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKvBinding } from "@/lib/cloudflare-kv";
import { getDb } from "@/lib/db/client";
import {
  __resetLiveDirectoryCacheForTests,
  getLiveDirectory,
  getLiveDirectoryCount,
  getLiveDirectoryRankings,
} from "@/lib/live-directory";
import { reportError } from "@/lib/sentry/error-handler";
import { fetchTwitchApi } from "@/lib/twitch/app-token";

vi.mock("@/lib/cloudflare-kv", () => ({
  getKvBinding: vi.fn(),
}));
vi.mock("@/lib/twitch/app-token", () => ({
  fetchTwitchApi: vi.fn(),
}));
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

function makeKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const RPC_ROWS = [
  {
    streamerId: "s1",
    twitchUserId: "u1",
    twitchDisplayName: "Live One",
    twitchProfileImageUrl: "https://example.com/a.png",
    publishStats: true,
    cardCount: 5,
    redemptionCount: 3,
  },
  {
    streamerId: "s2",
    twitchUserId: "u2",
    twitchDisplayName: "Offline Two",
    twitchProfileImageUrl: null,
    publishStats: false,
    cardCount: null,
    redemptionCount: null,
  },
];

function streamResponse(userIds: string[]) {
  return {
    data: userIds.map((userId, index) => ({
      user_id: userId,
      user_login: `login_${userId}`,
      user_name: `Name ${index}`,
      title: `Title ${index}`,
      game_name: "Just Chatting",
      viewer_count: 10 + index,
      started_at: `2026-08-11T00:0${index}:00Z`,
      thumbnail_url: "https://example.com/thumb_{width}x{height}.jpg",
    })),
  };
}

describe("getLiveDirectory", () => {
  let kv: ReturnType<typeof makeKv>;
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveDirectoryCacheForTests();
    kv = makeKv();
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);
    sqlMock = vi.fn().mockResolvedValue([{ result: RPC_ROWS }]);
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql: sqlMock } as never);
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1"])), { status: 200 }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("オプトインかつライブ中の配信者のみ返し、ライブ外は除外する", async () => {
    const entries = await getLiveDirectory();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      streamerId: "s1",
      twitchUserId: "u1",
      twitchLogin: "login_u1",
      displayName: "Live One",
      profileImageUrl: "https://example.com/a.png",
      title: "Title 0",
      gameName: "Just Chatting",
      viewerCount: 10,
      startedAt: "2026-08-11T00:00:00Z",
      thumbnailUrl: "https://example.com/thumb_320x180.jpg",
    });
    // KV へキャッシュ書き込み
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:v1",
      expect.any(String),
      { expirationTtl: 60 },
    );
  });

  it("ライブカード用RSCデータから旧統計フィールドを除去する", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1", "u2"])), {
        status: 200,
      }) as never,
    );

    const entries = await getLiveDirectory();

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      streamerId: "s2",
      profileImageUrl: "",
    });
    expect(entries[0]).not.toHaveProperty("stats");
    expect(entries[1]).not.toHaveProperty("stats");
  });

  it("オプトイン101人を100件ずつ2リクエストに分割し、first=100 を付与する", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      streamerId: `s${i}`,
      twitchUserId: `u${i}`,
      twitchDisplayName: `Name ${i}`,
      twitchProfileImageUrl: null,
      publishStats: true,
      cardCount: i,
      redemptionCount: 0,
    }));
    sqlMock.mockResolvedValue([{ result: rows }]);
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }) as never,
    );

    await getLiveDirectory();

    expect(fetchTwitchApi).toHaveBeenCalledTimes(2);
    const firstUrl = String(vi.mocked(fetchTwitchApi).mock.calls[0][0]);
    const secondUrl = String(vi.mocked(fetchTwitchApi).mock.calls[1][0]);
    const countParams = (url: string) => new URL(url).searchParams.getAll("user_id").length;
    expect(countParams(firstUrl)).toBe(100);
    expect(countParams(secondUrl)).toBe(1);
    // Get Streams の first デフォルトは20件のため、明示指定を固定する（#739必須）。
    expect(new URL(firstUrl).searchParams.get("first")).toBe("100");
    expect(new URL(secondUrl).searchParams.get("first")).toBe("100");
  });

  it("レスポンスに cursor が含まれても追加リクエストせず単発で終わる（無限ループ防止）", async () => {
    vi.mocked(fetchTwitchApi)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [streamResponse(["u1"]).data[0]],
            pagination: { cursor: "next-page" },
          }),
          { status: 200 },
        ) as never,
      );

    const entries = await getLiveDirectory();

    // cursor が返っても2回目を呼ばない（#739 レビュー必須: 無限ループ防止）
    expect(fetchTwitchApi).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => e.twitchUserId)).toEqual(["u1"]);
  });

  it("Helix 障害時は空配列を返し reportError で通知する", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(null, { status: 500 }) as never,
    );

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:helix",
    });
    // 障害による空配列はキャッシュへ書き込まない（瞬断が60秒の「誰もいない」に化けない）
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("RPC 障害（42883）時は空配列を返し Helix を呼ばない", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error('function get_live_directory_streamers() does not exist'), {
        code: "42883",
      }),
    );

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:rpc",
    });
    expect(fetchTwitchApi).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("オプトイン0件なら Helix を呼ばず、正常な空状態はキャッシュする", async () => {
    sqlMock.mockResolvedValue([{ result: [] }]);

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(fetchTwitchApi).not.toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:v1",
      "[]",
      { expirationTtl: 60 },
    );
  });

  it("KV hit は旧fieldを除去して RPC/Helix へ再到達しない", async () => {
    const cached = JSON.stringify([{
      streamerId: "s1",
      twitchUserId: "u1",
      twitchLogin: "alpha",
      displayName: "Alpha",
      profileImageUrl: "https://example.com/profile.png",
      title: "Live title",
      gameName: "Game",
      viewerCount: 42,
      startedAt: "2026-08-11T00:00:00Z",
      thumbnailUrl: "https://example.com/thumb.jpg",
      stats: { cardCount: 99, redemptionCount: 88 },
      unexpectedInternalField: "drop-me",
    }]);
    kv.get.mockResolvedValue(cached);

    const entries = await getLiveDirectory();

    expect(entries).toEqual([{
      streamerId: "s1",
      twitchUserId: "u1",
      twitchLogin: "alpha",
      displayName: "Alpha",
      profileImageUrl: "https://example.com/profile.png",
      title: "Live title",
      gameName: "Game",
      viewerCount: 42,
      startedAt: "2026-08-11T00:00:00Z",
      thumbnailUrl: "https://example.com/thumb.jpg",
    }]);
    expect(JSON.stringify(entries)).not.toContain("stats");
    expect(JSON.stringify(entries)).not.toContain("unexpectedInternalField");
    expect(getDb).not.toHaveBeenCalled();
    expect(fetchTwitchApi).not.toHaveBeenCalled();
  });

  it("KV 読み取り例外は miss 扱いで続行し reportError で通知する", async () => {
    kv.get.mockRejectedValue(new Error("kv down"));

    const entries = await getLiveDirectory();

    expect(entries).toHaveLength(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:kvRead",
    });
  });

  it("KV なし環境（ローカル）はメモリキャッシュで2回目の再取得を防ぐ", async () => {
    vi.mocked(getKvBinding).mockResolvedValue(null);

    const first = await getLiveDirectory();
    const second = await getLiveDirectory();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchTwitchApi).toHaveBeenCalledTimes(1);
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});

describe("getLiveDirectoryRankings", () => {
  let kv: ReturnType<typeof makeKv>;
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveDirectoryCacheForTests();
    kv = makeKv();
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);
    sqlMock = vi.fn().mockResolvedValue([
      {
        result: {
          last7Days: [
            null,
            "malformed-row",
            {
              identity: {
                twitchLogin: "public_login",
                displayName: "Public Channel",
                profileImageUrl: "https://example.com/public.png",
                unexpectedSecret: "drop-me",
              },
              cardCount: 12,
              redemptionCount: 34,
              totalPoints: 5600,
              rankedMetrics: ["cardCount", "redemptionCount", "totalPoints", "unknownMetric"],
              unexpectedInternalId: "drop-me-too",
            },
          ],
          allTime: [
            {
              identity: null,
              cardCount: 7,
              redemptionCount: 8,
              totalPoints: 900,
              rankedMetrics: ["redemptionCount", "unknownMetric"],
              streamerId: "must-not-leak",
              twitchUserId: "must-not-leak",
            },
          ],
          unexpectedPeriod: [{ streamerId: "must-not-leak" }],
        },
      },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql: sqlMock } as never);
  });

  it("whitelists public identity and allowed ranking metrics for every row", async () => {
    const rankings = await getLiveDirectoryRankings();

    expect(rankings).toEqual({
      last7Days: [
        {
          identity: {
            twitchLogin: "public_login",
            displayName: "Public Channel",
            profileImageUrl: "https://example.com/public.png",
          },
          cardCount: 12,
          redemptionCount: 34,
          totalPoints: 5600,
          rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
        },
      ],
      allTime: [
        {
          identity: null,
          cardCount: 7,
          redemptionCount: 8,
          totalPoints: 900,
          rankedMetrics: ["redemptionCount"],
        },
      ],
    });
    expect(JSON.stringify(rankings)).not.toContain("must-not-leak");
    expect(JSON.stringify(rankings)).not.toContain("unexpectedPeriod");
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:rankings:v3",
      JSON.stringify(rankings),
      { expirationTtl: 60 },
    );
  });

  it("drops a row when every selected metric normalizes to zero", async () => {
    sqlMock.mockResolvedValue([
      {
        result: {
          last7Days: [
            {
              identity: null,
              cardCount: -1,
              redemptionCount: "12",
              totalPoints: Number.MAX_SAFE_INTEGER + 1,
              rankedMetrics: ["cardCount", "notAllowed"],
            },
          ],
          allTime: [],
        },
      },
    ]);

    await expect(getLiveDirectoryRankings()).resolves.toEqual({
      last7Days: [],
      allTime: [],
    });
  });

  it("does not cache an RPC failure and reports the ranking-specific context", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error("function get_live_directory_rankings_by_period() does not exist"), {
        code: "42883",
      }),
    );

    await expect(getLiveDirectoryRankings()).resolves.toEqual({
      last7Days: [],
      allTime: [],
    });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:rankingsRpc",
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("normalizes cached rows and avoids an RPC read on a KV hit", async () => {
    kv.get.mockResolvedValue(
      JSON.stringify({
        last7Days: [
          {
            identity: null,
            cardCount: 1,
            redemptionCount: 2,
            totalPoints: 3,
            rankedMetrics: ["totalPoints", "unknownMetric"],
            hidden: "not-returned",
          },
        ],
        allTime: [],
        secretPeriod: [{ identity: { twitchLogin: "hidden" } }],
      }),
    );

    await expect(getLiveDirectoryRankings()).resolves.toEqual({
      last7Days: [
        {
          identity: null,
          cardCount: 1,
          redemptionCount: 2,
          totalPoints: 3,
          rankedMetrics: ["totalPoints"],
        },
      ],
      allTime: [],
    });
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("getLiveDirectoryCount (#951)", () => {
  let kv: ReturnType<typeof makeKv>;
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveDirectoryCacheForTests();
    kv = makeKv();
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);
    sqlMock = vi.fn().mockResolvedValue([{ result: ["u1", "u2"] }]);
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql: sqlMock } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the number of live active streamers regardless of opt-in", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1"])), { status: 200 }) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBe(1);
    // u2 はライブ判定に使われるが、人数には含まれない
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:count:v1",
      JSON.stringify({ count: 1 }),
      { expirationTtl: 60 },
    );
  });

  it("counts zero as a normal empty state and caches it", async () => {
    sqlMock.mockResolvedValue([{ result: [] }]);
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBe(0);
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:count:v1",
      JSON.stringify({ count: 0 }),
      { expirationTtl: 60 },
    );
  });

  it("returns null and does not cache on an RPC failure", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error("function get_live_directory_active_streamer_ids() does not exist"), {
        code: "42883",
      }),
    );

    await expect(getLiveDirectoryCount()).resolves.toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:countRpc",
    });
    expect(fetchTwitchApi).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns null and does not cache on a Helix failure", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(null, { status: 500 }) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      context: "liveDirectory:countHelix",
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns the cached count without an RPC read on a KV hit", async () => {
    kv.get.mockResolvedValue(JSON.stringify({ count: 7 }));

    await expect(getLiveDirectoryCount()).resolves.toBe(7);
    expect(getDb).not.toHaveBeenCalled();
    expect(fetchTwitchApi).not.toHaveBeenCalled();
  });

  it("uses the in-memory cache on a second call while the TTL is fresh", async () => {
    // KV は常に miss のままにし、初回実取得後にメモリキャッシュが効くことを確認する
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1"])), { status: 200 }) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBe(1);
    expect(fetchTwitchApi).toHaveBeenCalledTimes(1);

    await expect(getLiveDirectoryCount()).resolves.toBe(1);
    expect(fetchTwitchApi).toHaveBeenCalledTimes(1);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("treats a broken cached payload as a miss and refetches", async () => {
    kv.get.mockResolvedValue(JSON.stringify({ count: "not-a-number" }));
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1"])), { status: 200 }) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBe(1);
  });

  it("treats NaN, negative, and fractional cached counts as a miss", async () => {
    for (const broken of [NaN, -1, 1.5]) {
      kv.get.mockResolvedValue(JSON.stringify({ count: broken }));
      vi.mocked(fetchTwitchApi).mockResolvedValue(
        new Response(JSON.stringify(streamResponse(["u1"])), { status: 200 }) as never,
      );

      await expect(getLiveDirectoryCount()).resolves.toBe(1);
    }
  });

  it("splits a large active set into batched Helix requests", async () => {
    const userIds = Array.from({ length: 101 }, (_, i) => `u${i}`);
    sqlMock.mockResolvedValue([{ result: userIds }]);
    vi.mocked(fetchTwitchApi).mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ) as never,
    );

    await expect(getLiveDirectoryCount()).resolves.toBe(0);
    expect(fetchTwitchApi).toHaveBeenCalledTimes(2);
    const firstUrl = String(vi.mocked(fetchTwitchApi).mock.calls[0][0]);
    expect(new URL(firstUrl).searchParams.getAll("user_id")).toHaveLength(100);
    expect(new URL(firstUrl).searchParams.get("first")).toBe("100");
  });
});
