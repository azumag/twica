import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #2039: soft 経路の storage write が ctx.waitUntil 経由で応答を
 * ブロックしないこと、waitUntil が取れない環境では同期フォールバックで
 * write が失われないこと、write 失敗が sanitized warn として残ることを固定する。
 */
const mocks = vi.hoisted(() => ({
  getKvBinding: vi.fn(),
  getCloudflareContext: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/cloudflare-kv", () => ({
  KV_MIN_EXPIRATION_TTL_SECONDS: 60,
  getKvBinding: mocks.getKvBinding,
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

describe("rate limit background storage write (#2039)", () => {
  function createKv(overrides: {
    get?: (key: string) => Promise<unknown>;
    put?: (key: string, value: string) => Promise<void>;
  } = {}) {
    const store = new Map<string, string>();
    return {
      store,
      namespace: {
        get: vi.fn(
          overrides.get ??
            (async (key: string, type?: "json") => {
              const value = store.get(key);
              if (value === undefined) return null;
              return type === "json" ? JSON.parse(value) : value;
            }),
        ),
        put: vi.fn(
          overrides.put ??
            (async (key: string, value: string) => {
              store.set(key, value);
            }),
        ),
        delete: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    mocks.getKvBinding.mockReset();
    mocks.getCloudflareContext.mockReset();
    mocks.loggerInfo.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.loggerError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ctx.waitUntil が取れる環境では write 完了を待たずに応答を返す", async () => {
    // put が明示的に解放するまで pending になる KV を用意し、
    // checkRateLimit が write 完了なしに resolve することを確認する。
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const kv = createKv({
      put: async (key: string, value: string) => {
        await putGate;
        kv.store.set(key, value);
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const waitUntilTasks: Promise<unknown>[] = [];
    mocks.getCloudflareContext.mockResolvedValue({
      ctx: { waitUntil: vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task)) },
    });

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.gacha, "user:deferred-write");

    // write が未完了でも成功応答が返り、タスクは waitUntil へ紐付いている。
    expect(result.success).toBe(true);
    expect(kv.namespace.put).toHaveBeenCalledTimes(1);
    expect(waitUntilTasks).toHaveLength(1);

    // write 完了後はカウンタが反映される。
    releasePut();
    await waitUntilTasks[0];
    expect(JSON.parse(kv.store.get("ratelimit:gacha:user:deferred-write")!)).toMatchObject({
      count: 1,
    });
  });

  it("ctx が取れない環境では write を同期実行して結果を待つ", async () => {
    const kv = createKv();
    mocks.getKvBinding.mockResolvedValue(kv.namespace);
    mocks.getCloudflareContext.mockRejectedValue(new Error("no workers context"));

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    await checkRateLimit(rateLimits.gacha, "user:sync-write");

    // フォールバックでは応答時点で write 済み（カウンタ喪失を防ぐ）。
    expect(kv.store.has("ratelimit:gacha:user:sync-write")).toBe(true);
  });

  it("write 失敗は応答を変えず sanitized warn として記録する", async () => {
    const kv = createKv({
      put: async () => {
        throw new Error("KV write rejected: 429 Too Many Requests");
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const waitUntilTasks: Promise<unknown>[] = [];
    mocks.getCloudflareContext.mockResolvedValue({
      ctx: { waitUntil: vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task)) },
    });

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.gacha, "ip:203.0.113.20");

    expect(result.success).toBe(true);
    await waitUntilTasks[0];

    const warnPayload = mocks.loggerWarn.mock.calls
      .map(([message, payload]) => ({ message, payload }))
      .find((entry) => entry.message === "[rate-limit] background write failed");
    expect(warnPayload?.payload).toMatchObject({
      name: "gacha",
      storage: "kv",
      op: "write",
      error: "KV write rejected: 429 Too Many Requests",
    });
    expect(JSON.stringify(warnPayload?.payload)).not.toContain("203.0.113.20");
  });
});
