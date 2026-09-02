/**
 * #1215: Twitch app token invalidation の KV delete 障害時フォールバックを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKvBinding } from "@/lib/cloudflare-kv";
import { reportError } from "@/lib/sentry/error-handler";
import {
  __resetTwitchAppTokenForTests,
  getTwitchAppAccessToken,
  invalidateTwitchAppToken,
} from "@/lib/twitch/app-token";

vi.mock("@/lib/cloudflare-kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloudflare-kv")>();
  return {
    ...actual,
    getKvBinding: vi.fn(),
  };
});

vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
}));

function makeKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function tokenResponse(accessToken: string) {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
    { status: 200 },
  );
}

describe("Twitch app token invalidation", () => {
  let kv: ReturnType<typeof makeKv>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTwitchAppTokenForTests();
    process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    kv = makeKv();
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("KV削除失敗でも stale KV を確認し forceRefresh で新tokenへ切り替える", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(tokenResponse("token-2"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getTwitchAppAccessToken()).toBe("token-1");

    const deleteError = new Error("kv delete failed");
    kv.delete.mockRejectedValueOnce(deleteError);

    await expect(invalidateTwitchAppToken()).resolves.toBeUndefined();

    expect(kv.delete).toHaveBeenCalledWith("twitch:app-token");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(deleteError, {
      context: "twitchAppToken:kvDelete",
    });

    // delete 失敗で旧tokenがKVに残る本番相当の状態を再現する。
    kv.get.mockResolvedValue(
      JSON.stringify({
        accessToken: "token-1",
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(await getTwitchAppAccessToken()).toBe("token-1");
    expect(kv.get).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 401自己回復経路は forceRefresh で stale KV / memory を読まず再発行する。
    expect(await getTwitchAppAccessToken({ forceRefresh: true })).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
