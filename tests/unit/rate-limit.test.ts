import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  KVRateLimitStorage,
  checkRateLimit,
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
      // 実際のCloudflare KVは expirationTtl < 60 を 400 Invalid expiration_ttl で
      // 拒否する。ここでモックが何でも受理してしまうと、クランプが壊れて
      // ttl=1 のような不正値を送る退行があってもテストが検知できない
      // (#1062 レビュー指摘: モックが素通りするとfail-open回帰テストが空振りする)。
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`,
        );
      }
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

  it("TTLはミリ秒から秒へ切り上げる(クランプが切り上げ結果を潰さないことも確認)", async () => {
    const storage = new KVRateLimitStorage(kv as never);
    // 60_001msは割り切れないため、切り上げが働けば61秒、
    // 働かなければ60秒(切り捨て)になり、両者を区別できる。
    // さらに61 > 60なので、60秒クランプの影響を受けていないことも同時に確認する。
    await storage.set("ratelimit:test", { count: 1, resetTime: 60_001 }, 60_001);
    expect(kv.put).toHaveBeenCalledWith(
      "ratelimit:test",
      JSON.stringify({ count: 1, resetTime: 60_001 }),
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

  it("window終端直前のインクリメントでもKV PUTがfail-openせず正しく増分する(#1062回帰テスト)", async () => {
    // 本番で実際に壊れていたのはKVRateLimitStorage.set単体ではなく、
    // checkRateLimitInternalのインクリメント経路(existing.resetTime - nowを
    // ttlMsとして渡す箇所)。window終端直前までfake timerで進め、その経路を
    // 直接通してfail-openしないことを確認する。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      setRateLimitStorage(new KVRateLimitStorage(kv as never));

      // 1回目: 新規カウンタ作成(count: 1, window: 60秒)
      const first = await checkRateLimit(rateLimits.authLogin, "user:almost-expired");
      expect(first.success).toBe(true);

      // window終端の1ms前まで進める(残りTTLが1msの状態を作る)
      vi.setSystemTime(new Date("2026-01-01T00:00:59.999Z"));

      const second = await checkRateLimit(rateLimits.authLogin, "user:almost-expired");

      // fail-open(ストレージエラーによる無条件許可)ではなく、正しく
      // カウントアップした上で成功していることを確認する。fail-open時は
      // remainingがlimit-1(定数)に戻ってしまうため、remainingの値でも区別する。
      expect(second.success).toBe(true);
      expect(second.remaining).toBe(3); // limit(5) - count(2)

      // 直近のKV PUTはクランプ後の60秒であり、400を返すはずの値
      // (Math.ceil(1/1000) = 1)ではないことを確認する。
      const lastCall = kv.put.mock.calls.at(-1);
      expect(lastCall?.[2]).toEqual({ expirationTtl: 60 });
    } finally {
      vi.useRealTimers();
    }
  });
});