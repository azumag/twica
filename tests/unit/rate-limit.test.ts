import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  KVRateLimitStorage,
  checkRateLimit,
  getRateLimitStorage,
  rateLimits,
  retryAfterSeconds,
  setRateLimitStorage,
} from "@/lib/rate-limit";

function makeKv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    get: vi.fn(async (key: string, type?: "json") => {
      const entry = store.get(key);
      if (!entry) return null;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: options?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

describe("retryAfterSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset(epochミリ秒)と現在時刻の差分を秒(整数)に変換する", () => {
    const reset = Date.now() + 60_000;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("端数は切り上げる(59.2秒残 → 60秒)", () => {
    const reset = Date.now() + 59_200;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("1秒未満の正の残り時間は1秒に切り上げる", () => {
    const reset = Date.now() + 500;
    expect(retryAfterSeconds(reset)).toBe(1);
  });

  it("resetが現在時刻と同値の場合は0を返す", () => {
    expect(retryAfterSeconds(Date.now())).toBe(0);
  });

  it("大きな残り時間も秒単位の整数に正しく変換する", () => {
    const reset = Date.now() + 3_600_000;
    expect(retryAfterSeconds(reset)).toBe(3600);
  });

  it("reset未指定時はフォールバック値(fallbackMs、デフォルト60000)を使う", () => {
    expect(retryAfterSeconds()).toBe(60);
    expect(retryAfterSeconds(undefined, 3_600_000)).toBe(3600);
  });

  it("resetが過去の場合は0にクランプする", () => {
    expect(retryAfterSeconds(Date.now() - 5_000)).toBe(0);
  });
});

describe("KVRateLimitStorage", () => {
  let kv: ReturnType<typeof makeKv>;

  beforeEach(() => {
    kv = makeKv();
  });

  it("setはJSON文字列と秒単位TTLでKVへ書き込む", async () => {
    const storage = new KVRateLimitStorage(kv as never);
    await storage.set("ratelimit:test", { count: 3, resetTime: 12345 }, 90_000);

    expect(kv.put).toHaveBeenCalledWith(
      "ratelimit:test",
      JSON.stringify({ count: 3, resetTime: 12345 }),
      { expirationTtl: 90 },
    );
  });

  it("TTLはミリ秒から秒へ切り上げる", async () => {
    const storage = new KVRateLimitStorage(kv as never);
    await storage.set("ratelimit:test", { count: 1, resetTime: 61_000 }, 61_000);
    expect(kv.put).toHaveBeenCalledWith(
      "ratelimit:test",
      JSON.stringify({ count: 1, resetTime: 61_000 }),
      { expirationTtl: 61 },
    );
  });

  it("残りwindowが短くてもCloudflare KVの最小TTL60秒未満にはしない(#1062回帰テスト)", async () => {
    const storage = new KVRateLimitStorage(kv as never);

    // window終端直前(残り1ms)でもexpirationTtlは60秒にクランプされる。
    // クランプしないとKV PUTが `Invalid expiration_ttl of 1` で失敗し、
    // レート制限がfail-open(素通り)してしまう。
    await storage.set("ratelimit:almost-expired", { count: 1, resetTime: 1 }, 1);
    expect(kv.put).toHaveBeenCalledWith(
      "ratelimit:almost-expired",
      JSON.stringify({ count: 1, resetTime: 1 }),
      { expirationTtl: 60 },
    );

    // ちょうど0msでも同様にクランプされる。
    await storage.set("ratelimit:zero", { count: 1, resetTime: 0 }, 0);
    expect(kv.put).toHaveBeenCalledWith(
      "ratelimit:zero",
      JSON.stringify({ count: 1, resetTime: 0 }),
      { expirationTtl: 60 },
    );
  });

  it("getはJSONを復元し、未登録ならnullを返す", async () => {
    const storage = new KVRateLimitStorage(kv as never);
    expect(await storage.get("ratelimit:missing")).toBeNull();

    await storage.set("ratelimit:test", { count: 5, resetTime: 999 }, 60_000);
    expect(await storage.get("ratelimit:test")).toEqual({ count: 5, resetTime: 999 });
  });

  it("deleteでKVエントリを削除する", async () => {
    const storage = new KVRateLimitStorage(kv as never);
    await storage.set("ratelimit:test", { count: 1, resetTime: 1 }, 60_000);
    await storage.delete("ratelimit:test");
    expect(kv.delete).toHaveBeenCalledWith("ratelimit:test");
    expect(await storage.get("ratelimit:test")).toBeNull();
  });
});

describe("rate limit storage 切り替え", () => {
  let kv: ReturnType<typeof makeKv>;

  beforeEach(() => {
    kv = makeKv();
    // テスト間でモジュールレベルのストレージをメモリ実装へ戻す
    setRateLimitStorage(getRateLimitStorage());
  });

  it("KVストレージ設定後はcheckRateLimitがKVを経由してカウントする", async () => {
    setRateLimitStorage(new KVRateLimitStorage(kv as never));

    const first = await checkRateLimit(rateLimits.authLogin, "user:test");
    expect(first.success).toBe(true);
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith("ratelimit:authLogin:user:test", "json");

    // 上限(5回/分)を超えるまで繰り返すと拒否される
    for (let i = 0; i < 4; i++) {
      await checkRateLimit(rateLimits.authLogin, "user:test");
    }
    const blocked = await checkRateLimit(rateLimits.authLogin, "user:test");
    expect(blocked.success).toBe(false);
  });
});

describe("retryAfterSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset(epochミリ秒)と現在時刻の差分を秒(整数)に変換する", () => {
    const reset = Date.now() + 60_000;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("端数は切り上げる(59.2秒残 → 60秒)", () => {
    const reset = Date.now() + 59_200;
    expect(retryAfterSeconds(reset)).toBe(60);
  });

  it("1秒未満の正の残り時間は1秒に切り上げる", () => {
    const reset = Date.now() + 500;
    expect(retryAfterSeconds(reset)).toBe(1);
  });

  it("resetが現在時刻と同値の場合は0を返す", () => {
    expect(retryAfterSeconds(Date.now())).toBe(0);
  });

  it("大きな残り時間も秒単位の整数に正しく変換する", () => {
    const reset = Date.now() + 3_600_000;
    expect(retryAfterSeconds(reset)).toBe(3600);
  });

  it("reset未指定時はフォールバック値(fallbackMs、デフォルト60000)を使う", () => {
    expect(retryAfterSeconds()).toBe(60);
    expect(retryAfterSeconds(undefined, 3_600_000)).toBe(3600);
  });

  it("resetが過去の場合は0にクランプする", () => {
    expect(retryAfterSeconds(Date.now() - 5_000)).toBe(0);
  });
});
