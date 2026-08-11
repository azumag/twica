/**
 * #739: Twitch app access token 共通化ヘルパーのテスト。
 *
 * キャッシュ再利用 / 401自己回復（1回だけ再発行）/ 2連続401で無限ループしない /
 * KV障害時のフォールバックを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKvBinding } from "@/lib/cloudflare-kv";
import { reportError } from "@/lib/sentry/error-handler";
import {
  __resetTwitchAppTokenForTests,
  fetchTwitchApi,
  getTwitchAppAccessToken,
} from "@/lib/twitch/app-token";

vi.mock("@/lib/cloudflare-kv", () => ({
  getKvBinding: vi.fn(),
}));
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

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "token-1", expires_in: 3600 }),
    { status: 200 },
  );
}

describe("Twitch app access token", () => {
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

  it("キャッシュ再利用: 2回目は発行 fetch を呼ばず同じトークンを返す", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(tokenResponse() as never);

    const first = await getTwitchAppAccessToken();
    const second = await getTwitchAppAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://id.twitch.tv/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    // KV へは put 済み（TTL は expires_in × 0.8 以下）
    expect(kv.put).toHaveBeenCalledWith(
      "twitch:app-token",
      expect.any(String),
      expect.objectContaining({
        expirationTtl: expect.any(Number),
      }),
    );
  });

  it("KV に有効なトークンがあればそれを返し発行 fetch を呼ばない", async () => {
    kv.get.mockResolvedValue(
      JSON.stringify({
        accessToken: "cached-token",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const token = await getTwitchAppAccessToken();

    expect(token).toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 でキャッシュを破棄し、1回だけ再発行してリトライする", async () => {
    vi.spyOn(globalThis, "fetch")
      // 1回目: トークン発行
      .mockResolvedValueOnce(tokenResponse() as never)
      // 2回目: Helix 401
      .mockResolvedValueOnce(
        new Response(null, { status: 401 }) as never,
      )
      // 3回目: 再発行（新トークン）
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "token-2", expires_in: 3600 }),
          { status: 200 },
        ) as never,
      )
      // 4回目: 新トークンで再試行 → 成功
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ ok: true }] }), {
          status: 200,
        }) as never,
      );

    const response = await fetchTwitchApi("https://api.twitch.tv/helix/streams");

    expect(response.status).toBe(200);
    // 発行 fetch は2回（初回 + 再発行）。Helix は2回（401 + リトライ）。
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    // 401 で KV キャッシュが破棄されている
    expect(kv.delete).toHaveBeenCalledWith("twitch:app-token");
  });

  it("再発行後も 401 ならそのレスポンスを返し、無限ループしない", async () => {
    vi.spyOn(globalThis, "fetch")
      // トークン発行（初回）
      .mockResolvedValueOnce(tokenResponse() as never)
      // Helix 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }) as never)
      // 再発行
      .mockResolvedValueOnce(tokenResponse() as never)
      // リトライも 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }) as never);

    const response = await fetchTwitchApi("https://api.twitch.tv/helix/streams");

    expect(response.status).toBe(401);
    // 発行 fetch は2回で停止（3回目の発行はしない）
    const tokenFetches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url) === "https://id.twitch.tv/oauth2/token",
    );
    expect(tokenFetches).toHaveLength(2);
  });

  it("KV 読み取りが例外を投げても発行して継続し reportError で通知する", async () => {
    vi.mocked(getKvBinding).mockRejectedValue(new Error("kv down"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse() as never);

    const token = await getTwitchAppAccessToken();

    expect(token).toBe("token-1");
    expect(reportError).toHaveBeenCalledWith(
      "Twitch app token KV read failed",
      expect.any(Object),
    );
  });
});
