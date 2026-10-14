import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKvBinding: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/cloudflare-kv", () => ({
  KV_MIN_EXPIRATION_TTL_SECONDS: 60,
  getKvBinding: mocks.getKvBinding,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

/**
 * issue #728 の計測点（storage選択ログ / read・write所要時間 / fail-open理由）を
 * 固定するテスト。identifier（生IP / Twitch user id）がログへ漏れないことも
 * 併せて検証する。
 */
describe("rate limit KV observability (#728)", () => {
  /** 同一 KV namespace を模したストア。get/put を差し替えて任意の失敗を作れる。 */
  function createKv(
    overrides: {
      get?: (key: string) => Promise<unknown>;
      put?: (key: string) => Promise<void>;
    } = {},
  ) {
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
    // rate-limit は currentStorage / storageInitPromise / currentStorageKind を
    // module scope に保持するため、各ケースを fresh module で開始する。
    vi.resetModules();
    mocks.getKvBinding.mockReset();
    mocks.loggerInfo.mockReset();
    mocks.loggerWarn.mockReset();
    // MemoryRateLimitStorage の module-scope cleanup interval を実時間タイマーとして
    // 積み残さないため fake timers を使う（同時に Date.now が制御可能になる）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** logger.warn の第2引数（payload）だけを集める。 */
  function warnPayloads(): Array<Record<string, unknown>> {
    return mocks.loggerWarn.mock.calls
      .map(([, payload]) => payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" && payload !== null && !(payload instanceof Error),
      );
  }

  /** op/durationMs を持つ遅延ログ（通常帯では出ない）。 */
  const slowLogs = () =>
    warnPayloads().filter(
      (payload) => payload.op !== undefined && payload.durationMs !== undefined,
    );

  /** error を持つ fail-open ログ。 */
  const failOpenLogs = () => warnPayloads().filter((payload) => payload.error !== undefined);

  /** storage選択ログのpayload。 */
  function storageSelection(): { storage: string } {
    const [, payload] =
      mocks.loggerInfo.mock.calls.find(
        ([message]) => message === "[rate-limit] storage selected",
      ) ?? [];
    expect(payload).toBeDefined();
    return payload as { storage: string };
  }

  it("KV が選ばれた場合、選択結果を isolate あたり1回だけ記録する", async () => {
    const kv = createKv();
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    await checkRateLimit(rateLimits.authLogin, "user:kv-observability");
    await checkRateLimit(rateLimits.authLogin, "user:kv-observability");

    expect(storageSelection()).toEqual({ storage: "kv" });
    expect(
      mocks.loggerInfo.mock.calls.filter(
        ([message]) => message === "[rate-limit] storage selected",
      ),
    ).toHaveLength(1);
    // 通常帯（250ms未満）のstorage操作では遅延ログもfail-openログも出さない
    expect(slowLogs()).toEqual([]);
    expect(failOpenLogs()).toEqual([]);
  });

  it("binding が解決できない場合は memory を記録する", async () => {
    mocks.getKvBinding.mockResolvedValue(null);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.authLogin, "user:memory-observability");

    expect(result.success).toBe(true);
    expect(storageSelection()).toEqual({ storage: "memory" });
  });

  it("write 失敗を op=write として記録し、identifierを出さずにリクエストを許可する", async () => {
    // KV の同一key 1 write/秒制限（429）を模した失敗。fail-open しても
    // どの操作で落ちたかが判別できることを固定する。
    const kv = createKv({
      put: async () => {
        throw new Error("KV write rejected: 429 Too Many Requests");
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.7");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
    expect(kv.namespace.put).toHaveBeenCalledTimes(1);

    const [payload] = failOpenLogs();
    expect(payload).toMatchObject({
      name: "authLogin",
      storage: "kv",
      op: "write",
      error: "KV write rejected: 429 Too Many Requests",
    });
    expect(typeof payload.durationMs).toBe("number");
    // identifier（生IP / user id）はログへ出さない
    expect(JSON.stringify(payload)).not.toContain("203.0.113.7");
  });

  it("storageキーを埋め込んだエラーメッセージからidentifierを除去する", async () => {
    // KV の実エラーメッセージが対象キー（ratelimit:<name>:<identifier>）を
    // 含み得る場合でも、fail-openログへ生IPが漏れないことを固定する。
    const kv = createKv({
      put: async () => {
        throw new Error(
          "KV PUT rejected for ratelimit:authLogin:ip:203.0.113.9: 429 Too Many Requests",
        );
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.9");

    expect(result.success).toBe(true);
    const [payload] = failOpenLogs();
    expect(payload.error).toBe(
      "KV PUT rejected for [ratelimit key redacted]: 429 Too Many Requests",
    );
    expect(JSON.stringify(payload)).not.toContain("203.0.113.9");
  });

  it("read 失敗を op=read として記録する", async () => {
    const kv = createKv({
      get: async () => {
        throw new Error("KV read failed");
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const result = await checkRateLimit(rateLimits.authLogin, "user:kv-read-failure");

    expect(result.success).toBe(true);
    expect(failOpenLogs()[0]).toMatchObject({
      name: "authLogin",
      storage: "kv",
      op: "read",
    });
  });

  it("memory fallback 時のfail-openも storage=memory として記録する", async () => {
    mocks.getKvBinding.mockRejectedValue(new Error("RATE_LIMIT_KV unavailable"));

    const { checkRateLimit, rateLimits, setRateLimitStorage } = await import(
      "@/lib/rate-limit"
    );
    setRateLimitStorage({
      get: async () => {
        throw new Error("memory get failed");
      },
      set: async () => {},
      delete: async () => {},
    });

    const result = await checkRateLimit(rateLimits.authLogin, "user:memory-failure");

    expect(result.success).toBe(true);
    expect(failOpenLogs()[0]).toMatchObject({
      storage: "memory",
      op: "read",
    });
  });

  it("250ms を超える read/write だけを遅延として記録する", async () => {
    const kv = createKv({
      get: async () => {
        // fake timers の時計を進めて、storage read に300msかかった状況を作る
        vi.advanceTimersByTime(300);
        return null;
      },
      put: async () => {
        vi.advanceTimersByTime(300);
      },
    });
    mocks.getKvBinding.mockResolvedValue(kv.namespace);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    await checkRateLimit(rateLimits.authLogin, "user:kv-slow");

    expect(slowLogs()).toEqual([
      expect.objectContaining({ name: "authLogin", storage: "kv", op: "read", durationMs: 300 }),
      expect.objectContaining({ name: "authLogin", storage: "kv", op: "write", durationMs: 300 }),
    ]);
  });
});
