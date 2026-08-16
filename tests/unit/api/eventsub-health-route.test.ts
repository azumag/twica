/**
 * #540: GET /api/admin/eventsub-health のテスト
 *
 * db-health-route.test.ts と同じ構成（vi.hoisted + vi.mock でモジュール差し替え、
 * beforeEach でモックをリセットしてから既定の成功応答を設定する）に揃える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  listAllEventSubSubscriptions: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { eventsubHealth: {} },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/twitch/eventsub-subscriptions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/twitch/eventsub-subscriptions")>(
    "@/lib/twitch/eventsub-subscriptions"
  );
  return {
    ...actual,
    listAllEventSubSubscriptions: mocks.listAllEventSubSubscriptions,
  };
});

// logErrorFromLogger（logger.server.ts の logger.error が内部で呼ぶ）は実装のまま
// 残す。NEXT_RUNTIME 未設定のテスト環境では DB module を読み込まず安全に
// no-op するため（db-health-route.test.ts と同じ前提）、reportError だけを
// 差し替える。
vi.mock("@/lib/sentry/error-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry/error-handler")>();
  return {
    ...actual,
    reportError: mocks.reportError,
  };
});

const TEST_SECRET = "test-eventsub-health-secret";

function healthySubscription(id: string) {
  return {
    id,
    status: "enabled",
    type: "channel.channel_points_custom_reward_redemption.add",
    condition: { broadcaster_user_id: "12345", reward_id: "reward-1" },
    transport: { method: "webhook", callback: "https://twica.example.com/api/twitch/eventsub" },
    created_at: "2026-01-01T00:00:00Z",
  };
}

function unhealthySubscription(id: string, status: string) {
  return { ...healthySubscription(id), status };
}

function createHealthRequest(
  path = "/api/admin/eventsub-health",
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    headers: {
      "x-eventsub-health-secret": TEST_SECRET,
      ...headers,
    },
  });
}

describe("GET /api/admin/eventsub-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EVENTSUB_HEALTH_SECRET = TEST_SECRET;
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 20,
      remaining: 19,
      reset: Date.now() + 60000,
    });
    mocks.getRateLimitIdentifier.mockResolvedValue("ip:127.0.0.1");
    mocks.listAllEventSubSubscriptions.mockResolvedValue([healthySubscription("sub-1")]);
    mocks.reportError.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.EVENTSUB_HEALTH_SECRET;
  });

  it("EVENTSUB_HEALTH_SECRET未設定なら500でfail-closedする", async () => {
    delete process.env.EVENTSUB_HEALTH_SECRET;
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(mocks.listAllEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("シークレットが不一致なら403を返す", async () => {
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(
      createHealthRequest("/api/admin/eventsub-health", { "x-eventsub-health-secret": "wrong" })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.FORBIDDEN);
    expect(mocks.listAllEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("シークレットヘッダー自体が無ければ403を返す", async () => {
    const { GET } = await import("@/app/api/admin/eventsub-health/route");
    const request = new NextRequest("http://localhost:3000/api/admin/eventsub-health", {
      method: "GET",
    });

    const response = await GET(request);

    expect(response.status).toBe(403);
  });

  it("レート制限に達していれば429を返す", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Date.now() + 60000,
    });
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(429);
    expect(mocks.listAllEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("全サブスクリプションが健全ならunhealthyCount=0を返し、reportErrorは呼ばない", async () => {
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      healthySubscription("sub-1"),
      healthySubscription("sub-2"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.unhealthyCount).toBe(0);
    expect(body.unhealthy).toEqual([]);
    expect(typeof body.checkedAt).toBe("string");
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("unhealthyなサブスクリプションを検知したらreportErrorを固定メッセージで呼ぶ", async () => {
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      healthySubscription("sub-1"),
      unhealthySubscription("sub-2", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.unhealthyCount).toBe(1);
    expect(body.unhealthy).toEqual([
      {
        id: "sub-2",
        type: "channel.channel_points_custom_reward_redemption.add",
        status: "webhook_callback_verification_failed",
        broadcasterUserId: "12345",
        rewardId: "reward-1",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [error, context] = mocks.reportError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "[EventSub Health] Unhealthy EventSub subscription(s) detected"
    );
    expect(context).toMatchObject({ count: 1 });
  });

  it("webhook_callback_verification_pending（作成直後の一過性状態）はunhealthy扱いしない", async () => {
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_pending"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    const body = await response.json();
    expect(body.unhealthyCount).toBe(0);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("同じ検知が繰り返されてもメッセージ文字列は常に固定（GitHub Issueグルーピング用シグネチャの安定性）", async () => {
    mocks.listAllEventSubSubscriptions
      .mockResolvedValueOnce([unhealthySubscription("sub-1", "authorization_revoked")])
      .mockResolvedValueOnce([
        unhealthySubscription("sub-1", "authorization_revoked"),
        unhealthySubscription("sub-2", "notification_failures_exceeded"),
      ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());
    await GET(createHealthRequest());

    expect(mocks.reportError).toHaveBeenCalledTimes(2);
    const firstMessage = (mocks.reportError.mock.calls[0][0] as Error).message;
    const secondMessage = (mocks.reportError.mock.calls[1][0] as Error).message;
    expect(firstMessage).toBe(secondMessage);
  });

  it("Twitch API呼び出しが失敗したら502を返しreportErrorは呼ばない", async () => {
    mocks.listAllEventSubSubscriptions.mockRejectedValue(
      new Error("Failed to fetch EventSub subscriptions: 503")
    );
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
