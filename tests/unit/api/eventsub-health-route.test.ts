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
  getKvBinding: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { eventsubHealth: {} },
}));

// route.ts が実際に import しているのは @/lib/logger.server（@/lib/logger では
// ない）。ここを丸ごとモックに差し替えることで、route内のlogger.error/warn
// 呼び出しをテスト出力に混ぜず、かつ実装（内部でlogErrorFromLoggerを呼ぶ
// fire-and-forget経路）を経由させない。reportErrorはdirect awaitされる別経路
// (下のvi.mock("@/lib/sentry/error-handler")参照)なのでここには含まれない。
vi.mock("@/lib/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// #540 PR #1009 レビュー指摘(必須): unhealthy検知の度に無条件でreportErrorすると
// error-reporterが同一Issueへクールダウン無しでコメントを積み続けてしまうため、
// route.ts は KV ベースのクールダウン+変化検知ゲートを持つ。既定では
// getKvBinding が null を返す(=KV binding無し)ことでfail-open（常にアラート）
// させ、既存の大半のテストは cooldown を意識せず動く。cooldown 自体の挙動は
// 専用の describe ブロックで検証する。
vi.mock("@/lib/cloudflare-kv", () => ({
  getKvBinding: mocks.getKvBinding,
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
    // 既定はKV bindingが無い状態(fail-open=常にアラート)。cooldown自体の
    // 挙動を検証するテストだけ、下の describe 内で個別に上書きする。
    mocks.getKvBinding.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.EVENTSUB_HEALTH_SECRET;
    // environmentテストが例外で中断した場合でも次のテストへ漏れないようにする。
    delete process.env.NEXT_PUBLIC_APP_URL;
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

  it("unhealthyなサブスクリプションを検知したらreportErrorをenvironment付き固定メッセージで呼ぶ", async () => {
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
    // NEXT_PUBLIC_APP_URL未設定時はproduction扱い（resolveEnvironment参照）。
    expect((error as Error).message).toBe(
      "[EventSub Health][production] Unhealthy EventSub subscription(s) detected"
    );
    expect(context).toMatchObject({ count: 1, environment: "production" });
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

  // PR #1009 レビュー指摘(必須): Issue #285 の方針との整合性。配信者が
  // 自分の意思でapp連携を解除しただけの状態を、健全性監視が「対応が必要な
  // 障害」として報告してはならない。
  it.each(["authorization_revoked", "user_removed"])(
    "%s（ユーザー起因の期待される終端状態）はunhealthy扱いせずreportErrorを呼ばない(Issue #285)",
    async (status) => {
      mocks.listAllEventSubSubscriptions.mockResolvedValue([unhealthySubscription("sub-1", status)]);
      const { GET } = await import("@/app/api/admin/eventsub-health/route");

      const response = await GET(createHealthRequest());

      const body = await response.json();
      expect(body.unhealthyCount).toBe(0);
      expect(mocks.reportError).not.toHaveBeenCalled();
    }
  );

  it("同じenvironmentでの検知が繰り返されてもメッセージ文字列は常に固定（GitHub Issueグルーピング用シグネチャの安定性）", async () => {
    mocks.listAllEventSubSubscriptions
      .mockResolvedValueOnce([unhealthySubscription("sub-1", "webhook_callback_verification_failed")])
      .mockResolvedValueOnce([
        unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
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

  // PR #1009 レビュー指摘(必須): environmentごとにメッセージ(=GitHub Issue
  // グルーピング用signatureの元)を分けないと、prod/previewの検知が同一
  // signatureに潰れて1つのIssueに混在し、どちらの環境の障害か本文から
  // 判別できなくなる。
  it("environmentが異なればメッセージも異なる（prod/previewのGitHub Issue混在を防ぐ）", async () => {
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());
    const productionMessage = (mocks.reportError.mock.calls[0][0] as Error).message;

    mocks.reportError.mockClear();
    process.env.NEXT_PUBLIC_APP_URL = "https://twica-preview.example.workers.dev";
    await GET(createHealthRequest());
    const previewMessage = (mocks.reportError.mock.calls[0][0] as Error).message;
    delete process.env.NEXT_PUBLIC_APP_URL;

    expect(productionMessage).not.toBe(previewMessage);
    expect(productionMessage).toContain("[production]");
    expect(previewMessage).toContain("[preview]");
  });

  it("Twitch API呼び出しが失敗したら502を返し、reportErrorをawaitして記録を保証する", async () => {
    // レビュー指摘の修正: この失敗経路も「レスポンス前に永続化を保証する必要が
    // ある経路」（logger.server.ts 冒頭コメント）に該当する。fire-and-forget の
    // logger.error だと、Cloudflare Workers の isolate 回収タイミング次第で
    // DB書き込みが完走しないまま失われうるため、reportError を直接 await する
    // （unhealthy 検知時の分岐と同じ設計）。
    const apiError = new Error("Failed to fetch EventSub subscriptions: 503");
    mocks.listAllEventSubSubscriptions.mockRejectedValue(apiError);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [error, context] = mocks.reportError.mock.calls[0];
    expect(error).toBe(apiError);
    expect(context).toMatchObject({ context: "eventsub-health:fetchFailed" });
  });
});

// ===========================================================================
// PR #1009 レビュー指摘(必須): KVベースのアラートクールダウン/変化検知ゲート。
// 5分毎に無条件でreportErrorすると、error-reporterが同一Issueへクールダウン
// 無しでコメントを積み続けるスパムになるため、これを防ぐゲートを検証する。
// ===========================================================================
describe("GET /api/admin/eventsub-health のアラートクールダウン", () => {
  const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");

  let kvGet: ReturnType<typeof vi.fn>;
  let kvPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    process.env.EVENTSUB_HEALTH_SECRET = TEST_SECRET;
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 20,
      remaining: 19,
      reset: Date.now() + 60000,
    });
    mocks.getRateLimitIdentifier.mockResolvedValue("ip:127.0.0.1");
    mocks.reportError.mockResolvedValue(undefined);

    kvGet = vi.fn();
    kvPut = vi.fn().mockResolvedValue(undefined);
    mocks.getKvBinding.mockResolvedValue({ get: kvGet, put: kvPut });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EVENTSUB_HEALTH_SECRET;
  });

  const agoIso = (minutesAgo: number) => FIXED_NOW.getTime() - minutesAgo * 60_000;

  it("前回状態がKVに無ければ(初回検知)アラートし、状態をKVへ記録する", async () => {
    kvGet.mockResolvedValue(null);
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(kvPut).toHaveBeenCalledTimes(1);
    const [key, value, options] = kvPut.mock.calls[0];
    expect(key).toBe("eventsub-health:alert-state:production");
    expect(JSON.parse(value)).toEqual({ subscriptionIds: ["sub-1"], alertedAt: FIXED_NOW.getTime() });
    expect(options).toEqual({ expirationTtl: 7200 });
  });

  it("同じsubscription ID集合のままクールダウン期間内なら再アラートしない", async () => {
    kvGet.mockResolvedValue(
      JSON.stringify({ subscriptionIds: ["sub-1"], alertedAt: agoIso(10) }) // 10分前(60分未満)
    );
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();
    // アラート自体は間引かれても、レスポンスは常に現在の健全性を正確に返す。
    const body = await response.json();
    expect(body.unhealthyCount).toBe(1);
  });

  it("同じ集合でもクールダウン期間(60分)を過ぎていれば生存確認として再アラートする", async () => {
    kvGet.mockResolvedValue(
      JSON.stringify({ subscriptionIds: ["sub-1"], alertedAt: agoIso(61) }) // 61分前
    );
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(kvPut).toHaveBeenCalledTimes(1);
  });

  it("unhealthyなsubscription集合が変化していればクールダウン中でも即座に再アラートする(悪化を見逃さない)", async () => {
    kvGet.mockResolvedValue(
      JSON.stringify({ subscriptionIds: ["sub-1"], alertedAt: agoIso(5) }) // 5分前(60分未満)
    );
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
      unhealthySubscription("sub-2", "notification_failures_exceeded"), // 新たに壊れた
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [, context] = mocks.reportError.mock.calls[0];
    expect(context).toMatchObject({ count: 2 });
    const [, value] = kvPut.mock.calls[0];
    expect(JSON.parse(value).subscriptionIds).toEqual(["sub-1", "sub-2"]);
  });

  it("KV読み取りが失敗した場合はfail-openで常にアラートする", async () => {
    kvGet.mockRejectedValue(new Error("KV unavailable"));
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    await GET(createHealthRequest());

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("KV書き込みが失敗してもreportError自体は成功として扱う(ベストエフォート)", async () => {
    kvGet.mockResolvedValue(null);
    kvPut.mockRejectedValue(new Error("KV unavailable"));
    mocks.listAllEventSubSubscriptions.mockResolvedValue([
      unhealthySubscription("sub-1", "webhook_callback_verification_failed"),
    ]);
    const { GET } = await import("@/app/api/admin/eventsub-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });
});
