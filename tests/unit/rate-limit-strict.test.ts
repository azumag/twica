import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictRateLimitDurableObject } from "../../workers/rate-limit/src";

const mocks = vi.hoisted(() => ({
  getStrictRateLimitNamespace: vi.fn(),
  getKvBinding: vi.fn(),
}));

vi.mock("@/lib/cloudflare-strict-rate-limit", () => ({
  getStrictRateLimitNamespace: mocks.getStrictRateLimitNamespace,
}));
vi.mock("@/lib/cloudflare-kv", () => ({
  KV_MIN_EXPIRATION_TTL_SECONDS: 60,
  getKvBinding: mocks.getKvBinding,
}));

function createObject() {
  const values = new Map<string, unknown>();
  let queue = Promise.resolve();
  const state = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T): Promise<void> => { values.set(key, value); },
      deleteAll: vi.fn(async () => { values.clear(); }),
      setAlarm: vi.fn(async () => undefined),
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => {
      const previous = queue;
      let release: () => void = () => undefined;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
  return { object: new StrictRateLimitDurableObject(state), state, values };
}

function createNamespace() {
  const objects = new Map<string, ReturnType<typeof createObject>>();
  return {
    objects,
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => {
      let instance = objects.get(id);
      if (!instance) {
        instance = createObject();
        objects.set(id, instance);
      }
      return {
        fetch: (request: Request) => instance!.object.fetch(request),
      };
    }),
  };
}

describe("strict rate limits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    mocks.getStrictRateLimitNamespace.mockReset();
    mocks.getKvBinding.mockReset().mockResolvedValue(null);
  });

  afterEach(() => vi.useRealTimers());

  it("serializes concurrent requests and enforces the exact limit across the shared object", async () => {
    const namespace = createNamespace();
    mocks.getStrictRateLimitNamespace.mockResolvedValue(namespace);
    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit(rateLimits.activateCode, "user:42")),
    );

    expect(results.filter((result) => result.success)).toHaveLength(5);
    expect(results.filter((result) => result.success === false && !result.unavailable)).toHaveLength(15);
    expect(namespace.objects.size).toBe(1);
    expect(namespace.idFromName).toHaveBeenCalledWith("activateCode:user:42");
  });

  it("keys distinct login IPs into separate strict counters", async () => {
    const namespace = createNamespace();
    mocks.getStrictRateLimitNamespace.mockResolvedValue(namespace);
    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.1", 5, 60_000, "ip:198.51.100.77")).success).toBe(true);
    }
    expect((await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.1", 5, 60_000, "ip:198.51.100.77")).success).toBe(false);
    expect((await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.2", 5, 60_000, "ip:198.51.100.77")).success).toBe(true);
    expect(namespace.objects.size).toBe(2);
  });

  it("returns an unavailable state on Durable Object failure instead of failing open", async () => {
    mocks.getStrictRateLimitNamespace.mockResolvedValue({
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => { throw new Error("backend unavailable"); } }),
    });
    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    const result = await checkRateLimit(rateLimits.authLogin, "ip:203.0.113.3");

    expect(result).toMatchObject({ success: false, unavailable: true });
  });

  it("fails closed when strict login has no trusted Cloudflare client IP", async () => {
    const namespace = createNamespace();
    mocks.getStrictRateLimitNamespace.mockResolvedValue(namespace);
    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    const result = await checkRateLimit(rateLimits.authLogin, "ip:unknown");

    expect(result).toMatchObject({ success: false, unavailable: true });
    expect(namespace.idFromName).not.toHaveBeenCalled();
  });

  it("keeps strict integration disabled when the optional namespace is absent", async () => {
    mocks.getStrictRateLimitNamespace.mockResolvedValue(null);
    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    // The optional-namespace path intentionally retains the existing in-memory
    // fallback, whose get/set pair is not atomic under concurrent calls.
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkRateLimit(rateLimits.authLogin, "ip:unknown", 5, 60_000, "ip:local"));
    }

    expect(results.slice(0, 5).every((result) => result.success)).toBe(true);
    expect(results[5]).toMatchObject({ success: false, unavailable: undefined });
  });

  it("does not route ordinary browsing limits through the strict backend and retains soft fail-open", async () => {
    mocks.getStrictRateLimitNamespace.mockRejectedValue(new Error("must not be requested"));
    const { checkRateLimit, rateLimits, setRateLimitStorage } = await import("@/lib/rate-limit");
    setRateLimitStorage({
      get: async () => { throw new Error("KV unavailable"); },
      set: async () => { throw new Error("KV unavailable"); },
      delete: async () => undefined,
    });

    const result = await checkRateLimit(rateLimits.cardsGet, "ip:reader");

    expect(result.success).toBe(true);
    expect(mocks.getStrictRateLimitNamespace).not.toHaveBeenCalled();
  });

  it("trusts only Cloudflare's single-address client IP header", async () => {
    const { getTrustedClientIp } = await import("@/lib/rate-limit");

    expect(getTrustedClientIp(new Request("https://example.test", {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.77",
        "x-real-ip": "192.0.2.88",
      },
    }))).toBe("203.0.113.9");
    expect(getTrustedClientIp(new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.77", "x-real-ip": "192.0.2.88" },
    }))).toBeNull();
    expect(getTrustedClientIp(new Request("https://example.test", {
      headers: { "cf-connecting-ip": "203.0.113.9, 198.51.100.77" },
    }))).toBeNull();
  });
});
