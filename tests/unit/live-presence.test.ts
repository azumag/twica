/**
 * #1114: 推定配信チャネル数データ層 getEstimatedLiveChannelCount() のテスト。
 *
 * 署名付き presence-count 取得 / KV・メモリキャッシュ / 障害時 ok:false（0と
 * 誤表示しない）/ do-primary 以外の機能無効時非表示 / レスポンス正規化を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createPublishSignature } from "@/lib/overlay-realtime/signature";
import {
  __resetLivePresenceCacheForTests,
  getEstimatedLiveChannelCount,
} from "@/lib/live-presence";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));
vi.mock("@/lib/cloudflare-kv", () => ({
  getKvBinding: vi.fn(),
}));
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
}));

import { getKvBinding } from "@/lib/cloudflare-kv";

const ORIGINAL_ENV = { ...process.env };

function makeKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function configureEnv(overrides: Record<string, string | undefined> = {}) {
  vi.mocked(getCloudflareContext).mockRejectedValue(
    new Error("no request context in unit tests")
  );
  process.env.OVERLAY_REALTIME_MODE = "do-primary";
  process.env.OVERLAY_REALTIME_PUBLISH_URL =
    "https://twica-overlay-realtime-preview.example.workers.dev";
  process.env.OVERLAY_REALTIME_PUBLISH_SECRET = "presence-test-secret";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function fetchMock(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), { status })
  );
}

describe("getEstimatedLiveChannelCount (#1114)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLivePresenceCacheForTests();
    process.env = { ...ORIGINAL_ENV };
    vi.mocked(getKvBinding).mockResolvedValue(makeKv() as never);
    configureEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("returns the registry count through a signed request and caches it", async () => {
    const innerFetch = fetchMock({ estimatedRooms: 12, generatedAt: "2026-08-21T00:00:00Z" });
    vi.stubGlobal("fetch", innerFetch);

    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({
      ok: true,
      count: 12,
    });

    const [url, init] = innerFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/internal/v1/presence-count");
    expect(init.method).toBe("GET");
    // 空bodyの署名がWorker側の検証canonical（sha256("")）と一致することを実測。
    const timestamp = (init.headers as Record<string, string>)["x-twica-timestamp"];
    const nonce = (init.headers as Record<string, string>)["x-twica-nonce"];
    const signature = (init.headers as Record<string, string>)["x-twica-signature"];
    await expect(
      createPublishSignature(
        process.env.OVERLAY_REALTIME_PUBLISH_SECRET!,
        "/internal/v1/presence-count",
        "",
        timestamp,
        nonce
      )
    ).resolves.toBe(signature);

    // 成功スナップショットはメモリへキャッシュされ、2回目はfetchしない。
    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({
      ok: true,
      count: 12,
    });
    expect(innerFetch).toHaveBeenCalledTimes(1);
  });

  it("hides the estimate when realtime transport is not do-primary", async () => {
    configureEnv({ OVERLAY_REALTIME_MODE: "polling-only" });
    const innerFetch = vi.fn();
    vi.stubGlobal("fetch", innerFetch);

    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({ ok: false });
    // 機能無効時はnetwork呼び出し自体を行わない。
    expect(innerFetch).not.toHaveBeenCalled();
  });

  it("returns ok:false instead of zero when the registry is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down"))
    );

    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({ ok: false });
  });

  it("treats malformed registry payloads as unavailable", async () => {
    vi.stubGlobal("fetch", fetchMock({ estimatedRooms: "many" }));

    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({ ok: false });
  });

  it("keeps serving a cached snapshot without refetching after a failure", async () => {
    const kv = makeKv();
    kv.get.mockResolvedValue(JSON.stringify({ estimatedRooms: 5 }));
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);

    // KVに成功スナップショットがある間は障害でもその値を返す。
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    await expect(getEstimatedLiveChannelCount()).resolves.toEqual({
      ok: true,
      count: 5,
    });
  });
});
