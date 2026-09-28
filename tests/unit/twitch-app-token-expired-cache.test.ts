/**
 * #921 follow-up 41: 期限切れの KV app token を再利用せず再発行する契約を固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKvBinding } from "@/lib/cloudflare-kv";
import {
  __resetTwitchAppTokenForTests,
  getTwitchAppAccessToken,
} from "@/lib/twitch/app-token";

vi.mock("@/lib/cloudflare-kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloudflare-kv")>();
  return {
    ...actual,
    getKvBinding: vi.fn(),
  };
});

function makeKv() {
  return {
    get: vi.fn().mockResolvedValue(
      JSON.stringify({
        accessToken: "expired-token",
        expiresAt: Date.now() - 1_000,
      }),
    ),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Twitch app token expired KV cache", () => {
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

  it("期限切れ KV token を無視して新しい token を発行・保存する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
        { status: 200 },
      ) as never,
    );

    const token = await getTwitchAppAccessToken();

    expect(token).toBe("fresh-token");
    expect(kv.get).toHaveBeenCalledWith("twitch:app-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://id.twitch.tv/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(kv.put).toHaveBeenCalledWith(
      "twitch:app-token",
      expect.stringContaining("fresh-token"),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });
});
