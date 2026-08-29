import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKvBinding: vi.fn(),
}));

vi.mock("@/lib/cloudflare-kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloudflare-kv")>();
  return {
    ...actual,
    getKvBinding: mocks.getKvBinding,
  };
});

describe("rate-limit KV binding fallback", () => {
  beforeEach(() => {
    // rate-limit は currentStorage / storageInitPromise を module scope に保持するため、
    // 各ケースを fresh module で開始して初回 binding 解決の契約だけを検証する。
    vi.resetModules();
    mocks.getKvBinding.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      label: "binding が無く null を返す",
      arrange: () => mocks.getKvBinding.mockResolvedValue(null),
    },
    {
      label: "binding 解決が reject する",
      arrange: () => mocks.getKvBinding.mockRejectedValue(new Error("RATE_LIMIT_KV unavailable")),
    },
  ])("getKvBinding が $label 場合もメモリへfallbackしてカウントを継続する", async ({ arrange }) => {
    arrange();

    const { checkRateLimit, rateLimits } = await import("@/lib/rate-limit");
    const first = await checkRateLimit(rateLimits.authLogin, "user:kv-fallback");
    const second = await checkRateLimit(rateLimits.authLogin, "user:kv-fallback");

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.limit).toBeDefined();
    expect(first.remaining).toBeDefined();
    expect(second.limit).toBe(first.limit);
    expect(second.remaining).toBe((first.remaining as number) - 1);
    expect(second.reset).toBe(first.reset);

    // RATE_LIMIT_KV は getKvBinding の既定bindingで解決する。呼び出し回数は
    // storageInitPromise の再試行方針を固定しないため、ここでは契約に含めない。
    expect(mocks.getKvBinding).toHaveBeenCalledWith();
  });
});
