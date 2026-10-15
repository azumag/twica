/**
 * #934 docich 同志カードコーナー: GET /api/overlay/[streamerId]/card-ranking の
 * 公開契約テスト（設計 docs/features/doushi-card-corner.md §6）。
 *
 * 検証するのは TwiCa 側の境界責務だけにする:
 *   - period / limit の入力検証（不正値は DB 接続前に 400）
 *   - 既存 /events と同じ公開レート制限
 *   - RPC の透過返却と no-store（docich が毎回フェッチする前提）
 *   - opt-in していない streamer は 404（P0002）。未知の streamer と同じ応答にして
 *     公開可否を探索できないようにする
 *   - fail-closed（RPC 未デプロイの 42883 と、payload 欠落は 503。docich 側は
 *     開始 skip する）
 * 集計値そのものの正しさは tests/fixtures/card-ranking-postgres.sql が実 DB で担保する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/overlay/[streamerId]/card-ranking/route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/rate-limit");
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

const STREAMER_ID = "123e4567-e89b-42d3-a456-426614174000";
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetDb = vi.mocked(getDb);

const RPC_PAYLOAD = {
  generated_at: "2026-10-15T00:00:00.000Z",
  period: "all",
  metric_labels: {
    by_count: "排出枚数",
    by_points: "使用チャネルポイント",
    by_unique: "蒐集カード数",
    popular_cards: "人気カード",
  },
  note: "N連はN件 / 配信者本人とBOTを除く / 全期間",
  card_type_total: 3,
  by_count: [{ rank: 1, username: "viewerA", redemption_count: 3 }],
  by_points: [{ rank: 1, username: "viewerB", total_points: 600, redemption_count: 2 }],
  by_unique: [{ rank: 1, username: "viewerA", unique_count: 2, total_cards: 2 }],
  popular_cards: [{ rank: 1, card_name: "CR Card Two", actual_count: 5, drawer_count: 3 }],
};

function createRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/overlay/${STREAMER_ID}/card-ranking`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function routeParams(streamerId = STREAMER_ID) {
  return { params: Promise.resolve({ streamerId }) };
}

describe("GET /api/overlay/[streamerId]/card-ranking", () => {
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    sqlMock = vi.fn().mockResolvedValue([{ result: RPC_PAYLOAD }]);
    mockGetDb.mockResolvedValue({ db: {} as never, sql: sqlMock } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function bindingValues(): unknown[] {
    // sql`select get_published_card_ranking(${streamerId}::uuid, ${period}, ${limit})`
    // の第2引数以降が実バインド値。
    const [, ...values] = sqlMock.mock.calls[0] as [unknown, ...unknown[]];
    return values;
  }

  it("period/limit 省略時は all/10 で RPC を呼び、payload と no-store を返す", async () => {
    const response = await GET(createRequest(), routeParams());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(RPC_PAYLOAD);
    expect(bindingValues()).toEqual([STREAMER_ID, "all", 10]);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it("指定した period と limit をそのままバインドする", async () => {
    const response = await GET(
      createRequest({ period: "7d", limit: "5" }),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(bindingValues()).toEqual([STREAMER_ID, "7d", 5]);
  });

  it("不正な streamerId / period / limit は DB 接続前に 400 で拒否する", async () => {
    const invalidStreamer = await GET(createRequest(), routeParams("not-a-uuid"));
    const invalidPeriod = await GET(
      createRequest({ period: "lifetime" }),
      routeParams()
    );
    const missingPeriod = await GET(
      createRequest({ period: "" }),
      routeParams()
    );
    const zeroLimit = await GET(createRequest({ limit: "0" }), routeParams());
    const overLimit = await GET(createRequest({ limit: "51" }), routeParams());
    const nonNumericLimit = await GET(
      createRequest({ limit: "abc" }),
      routeParams()
    );
    const fractionalLimit = await GET(
      createRequest({ limit: "1.5" }),
      routeParams()
    );

    expect(invalidStreamer.status).toBe(400);
    expect(invalidPeriod.status).toBe(400);
    expect(missingPeriod.status).toBe(400);
    expect(zeroLimit.status).toBe(400);
    expect(overLimit.status).toBe(400);
    expect(nonNumericLimit.status).toBe(400);
    expect(fractionalLimit.status).toBe(400);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("rate limit 超過は 429 を返し DB へ接続しない", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 30,
    });

    const response = await GET(createRequest(), routeParams());

    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("RPC 未デプロイ（42883）は 503 fail-closed にする（docich は開始 skip）", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error("function get_published_card_ranking(...) does not exist"), {
        code: "42883",
      })
    );

    const response = await GET(createRequest(), routeParams());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("未 opt-in / 未知の streamer（P0002）は 404 にして公開可否を探れなくする", async () => {
    // wrapper get_published_card_ranking は publish_card_ranking が FALSE の
    // streamer と存在しない streamer の両方へ同じ SQLSTATE を返す。
    sqlMock.mockRejectedValue(
      Object.assign(new Error("card_ranking: not published"), {
        code: "P0002",
      })
    );

    const response = await GET(createRequest(), routeParams());

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Card ranking is not published",
    });
  });

  it("その他の DB エラーは既存どおり 500 に落とす", async () => {
    sqlMock.mockRejectedValue(
      Object.assign(new Error("connection unexpectedly closed"), {
        code: "57P01",
      })
    );

    const response = await GET(createRequest(), routeParams());

    expect(response.status).toBe(500);
  });

  it("RPC が null / 非オブジェクトを返した場合は 503 fail-closed にする", async () => {
    sqlMock.mockResolvedValue([{ result: null }]);

    const nullResponse = await GET(createRequest(), routeParams());
    expect(nullResponse.status).toBe(503);

    sqlMock.mockResolvedValue([{ result: [RPC_PAYLOAD] }]);
    const arrayResponse = await GET(createRequest(), routeParams());
    expect(arrayResponse.status).toBe(503);
  });

  it("返却 payload は RPC の allowlist をそのまま渡し、内部 id を route 側で足さない", async () => {
    const response = await GET(createRequest(), routeParams());
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "by_count",
      "by_points",
      "by_unique",
      "card_type_total",
      "generated_at",
      "metric_labels",
      "note",
      "period",
      "popular_cards",
    ]);
    // user_twitch_id / card_id は SQL 側で組み立てない（fixture で実 DB 検証）。
    expect(JSON.stringify(body)).not.toContain("user_twitch_id");
    expect(JSON.stringify(body)).not.toContain("card_id");
  });
});
