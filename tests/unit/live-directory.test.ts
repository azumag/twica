/**
 * #739: 配信中ページ（/live）データ層 getLiveDirectory() のテスト。
 *
 * RPC+Helix 合成 / Helix バッチ分割（101人→2リクエスト）/ 障害時空配列 +
 * reportError / publish_stats=false の NULL マスク / KV キャッシュ / ローカル
 * メモ化を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKvBinding } from "@/lib/cloudflare-kv";
import { getDb } from "@/lib/db/client";
import {
  __resetLiveDirectoryCacheForTests,
  getLiveDirectory,
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
    twitchUsername: "live_one",
    twitchDisplayName: "Live One",
    twitchProfileImageUrl: "https://example.com/a.png",
    publishStats: true,
    cardCount: 5,
    redemptionCount: 3,
  },
  {
    streamerId: "s2",
    twitchUserId: "u2",
    twitchUsername: "offline_two",
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
      stats: { cardCount: 5, redemptionCount: 3 },
    });
    // KV へキャッシュ書き込み
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:v1",
      expect.any(String),
      { expirationTtl: 60 },
    );
  });

  it("publish_stats=false の配信者は stats を null で返す", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(JSON.stringify(streamResponse(["u1", "u2"])), {
        status: 200,
      }) as never,
    );

    const entries = await getLiveDirectory();

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      streamerId: "s2",
      stats: null,
      profileImageUrl: "",
    });
  });

  it("オプトイン101人を100件ずつ2リクエストに分割する", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      streamerId: `s${i}`,
      twitchUserId: `u${i}`,
      twitchUsername: `login_${i}`,
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
  });

  it("Helix 障害時は空配列を返し reportError で通知する", async () => {
    vi.mocked(fetchTwitchApi).mockResolvedValue(
      new Response(null, { status: 500 }) as never,
    );

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      "Live directory Helix streams failed",
      expect.any(Object),
    );
  });

  it("RPC 障害（42883）時は空配列を返し Helix を呼ばない", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error('function get_live_directory_streamers() does not exist'), {
        code: "42883",
      }),
    );

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      "Live directory RPC failed",
      expect.any(Object),
    );
    expect(fetchTwitchApi).not.toHaveBeenCalled();
  });

  it("オプトイン0件なら Helix を呼ばない", async () => {
    sqlMock.mockResolvedValue([{ result: [] }]);

    const entries = await getLiveDirectory();

    expect(entries).toEqual([]);
    expect(fetchTwitchApi).not.toHaveBeenCalled();
  });

  it("KV キャッシュ hit 時は RPC/Helix へ再到達しない", async () => {
    const cached = JSON.stringify([{ streamerId: "s1", twitchUserId: "u1" }]);
    kv.get.mockResolvedValue(cached);

    const entries = await getLiveDirectory();

    expect(entries).toEqual([{ streamerId: "s1", twitchUserId: "u1" }]);
    expect(getDb).not.toHaveBeenCalled();
    expect(fetchTwitchApi).not.toHaveBeenCalled();
  });

  it("KV 読み取り例外は miss 扱いで続行し reportError で通知する", async () => {
    kv.get.mockRejectedValue(new Error("kv down"));

    const entries = await getLiveDirectory();

    expect(entries).toHaveLength(1);
    expect(reportError).toHaveBeenCalledWith(
      "Live directory KV read failed",
      expect.any(Object),
    );
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
