import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/overlay/[streamerId]/events/route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createMockQueryBuilder } from "../utils/supabase-mock";

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

const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

function createRequest(streamerId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/overlay/${streamerId}/events`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function createRouteParams(streamerId: string) {
  return { params: Promise.resolve({ streamerId }) };
}

/** gacha_history クエリの共通モック生成。thenableにしてawait対応 */
function createHistoryQuery(response: { data: unknown; error: unknown }) {
  const q = createMockQueryBuilder();
  (q as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve(response);
    return q;
  };
  return q;
}

// Issue #591: gacha_history.reward_id (migration 00070) がポーリング経路の
// レスポンスに正しく反映されること、および列未デプロイ時のデプロイ窓フォール
// バックを検証する。
describe("GET /api/overlay/[streamerId]/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 120,
      remaining: 119,
      reset: Date.now() + 60000,
    });
  });

  it("returns 400 when since is missing/invalid", async () => {
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(createRequest("streamer-1"), createRouteParams("streamer-1"));
    expect(res.status).toBe(400);
  });

  it("reward_id列の値をrewardIdとしてそのまま返す(Issue #591)", async () => {
    const historyQuery = createHistoryQuery({
      data: [
        {
          id: "h1",
          event_id: "event-1",
          redeemed_at: "2026-01-01T00:00:01Z",
          user_twitch_username: "viewer1",
          reward_id: "reward-abc",
          cards: { id: "c1", name: "Card1", description: null, image_url: null, rarity: "rare" },
        },
      ],
      error: null,
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].rewardId).toBe("reward-abc");
  });

  it("reward_idがnullの行はrewardId: nullを返す(レイドガチャ等)", async () => {
    const historyQuery = createHistoryQuery({
      data: [
        {
          id: "h2",
          event_id: null,
          redeemed_at: "2026-01-01T00:00:02Z",
          user_twitch_username: "viewer2",
          reward_id: null,
          cards: { id: "c2", name: "Card2", description: null, image_url: null, rarity: "common" },
        },
      ],
      error: null,
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    const body = await res.json();
    expect(body.events[0].rewardId).toBeNull();
  });

  it("reward_id列未デプロイ時(42703)は列無しSELECTへフォールバックしrewardId: nullを返す(デプロイ窓, Issue #591)", async () => {
    const failingQuery = createHistoryQuery({
      data: null,
      error: { message: "column gacha_history.reward_id does not exist", code: "42703" },
    });
    const fallbackQuery = createHistoryQuery({
      data: [
        {
          id: "h3",
          event_id: "event-3",
          redeemed_at: "2026-01-01T00:00:03Z",
          user_twitch_username: "viewer3",
          cards: { id: "c3", name: "Card3", description: null, image_url: null, rarity: "epic" },
        },
      ],
      error: null,
    });

    const fromMock = vi.fn((table: string) => {
      if (table !== "gacha_history") return createMockQueryBuilder();
      return fromMock.mock.calls.filter(([name]) => name === "gacha_history").length === 1
        ? failingQuery
        : fallbackQuery;
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: fromMock,
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].rewardId).toBeNull();
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  it("列未デプロイ以外のDBエラーはフォールバックせず500を返す", async () => {
    const failingQuery = createHistoryQuery({
      data: null,
      error: { message: "connection reset", code: "08006" },
    });

    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => failingQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(500);
  });
});

// Issue #569: overlay のバージョン不一致検出＋アイドル時自動リロード機構向けに、
// ポーリング応答へ overlayVersion を追加したことを検証する。
describe("GET /api/overlay/[streamerId]/events: overlayVersion (Issue #569)", () => {
  const originalOverlayVersion = process.env.NEXT_PUBLIC_OVERLAY_VERSION;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 120,
      remaining: 119,
      reset: Date.now() + 60000,
    });
  });

  afterEach(() => {
    // 他のテストファイル/テストへ影響しないよう、テスト前の値へ必ず戻す
    if (originalOverlayVersion !== undefined) {
      process.env.NEXT_PUBLIC_OVERLAY_VERSION = originalOverlayVersion;
    } else {
      delete process.env.NEXT_PUBLIC_OVERLAY_VERSION;
    }
  });

  it("NEXT_PUBLIC_OVERLAY_VERSION未設定時はoverlayVersion: 'dev'を返す", async () => {
    delete process.env.NEXT_PUBLIC_OVERLAY_VERSION;

    const historyQuery = createHistoryQuery({ data: [], error: null });
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overlayVersion).toBe("dev");
  });

  it("NEXT_PUBLIC_OVERLAY_VERSION設定時はその値をoverlayVersionとして返す", async () => {
    process.env.NEXT_PUBLIC_OVERLAY_VERSION = "abc123def456";

    const historyQuery = createHistoryQuery({ data: [], error: null });
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overlayVersion).toBe("abc123def456");
  });

  it("events配列を含む応答でもoverlayVersionが同居する(既存フィールドとの後方互換)", async () => {
    process.env.NEXT_PUBLIC_OVERLAY_VERSION = "v-test";

    const historyQuery = createHistoryQuery({
      data: [
        {
          id: "h1",
          event_id: "event-1",
          redeemed_at: "2026-01-01T00:00:01Z",
          user_twitch_username: "viewer1",
          reward_id: null,
          cards: { id: "c1", name: "Card1", description: null, image_url: null, rarity: "rare" },
        },
      ],
      error: null,
    });
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00Z" }),
      createRouteParams("streamer-1")
    );

    const body = await res.json();
    expect(body.overlayVersion).toBe("v-test");
    expect(body.events).toHaveLength(1);
  });
});
