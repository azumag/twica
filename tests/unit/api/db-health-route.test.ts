/**
 * #693: GET /api/admin/db-health のテスト
 *
 * eventsub-replay-route.test.ts と同じ構成（vi.hoisted + vi.mock でモジュール差し替え、
 * beforeEach でモックをリセットしてから既定の成功応答を設定する）に揃える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: mocks.getRateLimitIdentifier,
  rateLimits: { dbHealth: {} },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

const TEST_SECRET = "test-db-health-secret";

function createHealthRequest(
  path = "/api/admin/db-health",
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    headers: {
      "x-health-secret": TEST_SECRET,
      ...headers,
    },
  });
}

describe("GET /api/admin/db-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DB_HEALTH_SECRET = TEST_SECRET;
    mocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 20,
      remaining: 19,
      reset: Date.now() + 60000,
    });
    mocks.getRateLimitIdentifier.mockResolvedValue("ip:127.0.0.1");
    // sql はタグ付きテンプレートとして呼ばれる postgres.js クライアントのスタブ。
    // vi.fn() は通常関数として呼び出し可能なので `sql\`...\`` の形でも動作する。
    const sqlStub = vi.fn().mockResolvedValue([{ version_num: 150004 }]);
    mocks.getDb.mockResolvedValue({ sql: sqlStub, db: {} });
  });

  afterEach(() => {
    delete process.env.DB_HEALTH_SECRET;
  });

  it("DB_HEALTH_SECRET未設定なら500でfail-closedする", async () => {
    delete process.env.DB_HEALTH_SECRET;
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    // シークレット未設定時は認証チェックより前に弾くため、DB接続は一切試みない
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("シークレットが不一致なら403を返す", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(
      createHealthRequest("/api/admin/db-health", { "x-health-secret": "wrong-secret" })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.FORBIDDEN);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("シークレットヘッダー自体が無ければ403を返す", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");
    const request = new NextRequest("http://localhost:3000/api/admin/db-health", {
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
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("targetクエリ省略時はPlanetScaleを使い、serverVersionMajorを返す", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      driver: "pg",
      target: "planetscale",
      serverVersionMajor: 15,
    });
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error).toBeUndefined();
    expect(mocks.getDb).toHaveBeenCalledWith();
  });

  it("target=planetscaleを明示しても同じ単一接続を使う", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest("/api/admin/db-health?target=planetscale"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.target).toBe("planetscale");
    expect(mocks.getDb).toHaveBeenCalledWith();
  });

  it("不正なtargetクエリパラメータは400を返す", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest("/api/admin/db-health?target=mysql"));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe(ERROR_MESSAGES.INVALID_REQUEST);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("削除済みtarget=supabaseは400で拒否する", async () => {
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest("/api/admin/db-health?target=supabase"));

    expect(response.status).toBe(400);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("target解決に失敗した場合（binding不足等）は500ではなく200+errorフィールドで返す", async () => {
    mocks.getDb.mockRejectedValue(
      new Error(
        "[db:pg] No database connection configured for target=planetscale: bind HYPERDRIVE_PLANETSCALE ..."
      )
    );
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest("/api/admin/db-health?target=planetscale"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.target).toBe("planetscale");
    expect(body.serverVersionMajor).toBeNull();
    // target解決の失敗メッセージはenv var名・binding名のみで機密情報を含まないため
    // そのまま返ってよい
    expect(body.error).toContain("HYPERDRIVE_PLANETSCALE");
  });

  it("target解決失敗が[db:pg]prefix無しの例外（postgres()コンストラクタ由来等）の場合は汎用メッセージのみ返す（ホスト名等の機密情報を露出しない）", async () => {
    // resolveConnectionString が投げる [db:pg] prefix 付きメッセージ以外
    // （postgres() コンストラクタ自体が投げる例外等）はホスト名等を含みうるため、
    // 無条件でechoしないことを確認する（Fableレビュー指摘A）。
    mocks.getDb.mockRejectedValue(
      new Error("connect ECONNREFUSED db.supersecret-host.example.com:5432")
    );
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.serverVersionMajor).toBeNull();
    expect(body.error).toBe("database connection check failed");
    expect(body.error).not.toContain("supersecret-host");
  });

  it("実クエリ発行時のエラーは詳細を返さず汎用メッセージのみ返す（ホスト名等の機密情報を露出しない）", async () => {
    const sqlStub = vi
      .fn()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND db.supersecret-host.example.com"));
    mocks.getDb.mockResolvedValue({ sql: sqlStub, db: {} });
    const { GET } = await import("@/app/api/admin/db-health/route");

    const response = await GET(createHealthRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.serverVersionMajor).toBeNull();
    expect(body.error).toBe("database connection check failed");
    expect(body.error).not.toContain("supersecret-host");
  });
});
