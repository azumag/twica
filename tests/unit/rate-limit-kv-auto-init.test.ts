import { describe, expect, it, vi } from "vitest";

const { getKvBindingMock } = vi.hoisted(() => ({
  getKvBindingMock: vi.fn(),
}));

vi.mock("@/lib/cloudflare-kv", () => ({
  KV_MIN_EXPIRATION_TTL_SECONDS: 60,
  getKvBinding: getKvBindingMock,
}));

describe("rate limit KV auto initialization", () => {
  it("初回check時にRATE_LIMIT_KVへ自動切替し、以後同じbindingを再利用する", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string, type?: "json") => {
        const value = store.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      }),
      put: vi.fn(
        async (
          key: string,
          value: string,
          _options?: { expirationTtl?: number },
        ) => {
          store.set(key, value);
        },
      ),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };
    getKvBindingMock.mockResolvedValue(kv);

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");

    const first = await checkRateLimit(rateLimits.authLogin, "user:auto-kv");
    const second = await checkRateLimit(rateLimits.authLogin, "user:auto-kv");

    expect(first.success).toBe(true);
    expect(first.remaining).toBe(4);
    expect(second.success).toBe(true);
    expect(second.remaining).toBe(3);
    expect(getKvBindingMock).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith(
      "ratelimit:authLogin:user:auto-kv",
      "json",
    );
    expect(kv.put).toHaveBeenCalledTimes(2);
  });
});
