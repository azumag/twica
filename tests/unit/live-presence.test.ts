import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getKvBinding } from "@/lib/cloudflare-kv";
import {
  __resetLiveDirectoryCacheForTests,
  getLiveDirectoryPresence,
} from "@/lib/live-directory";
import { reportError } from "@/lib/sentry/error-handler";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));
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

describe("getLiveDirectoryPresence", () => {
  let kv: ReturnType<typeof makeKv>;
  let serviceFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveDirectoryCacheForTests();
    kv = makeKv();
    serviceFetch = vi.fn();
    vi.mocked(getKvBinding).mockResolvedValue(kv as never);
    vi.mocked(getCloudflareContext).mockResolvedValue({
      env: { OVERLAY_REALTIME_SERVICE: { fetch: serviceFetch } },
    } as never);
  });

  it("reads the aggregate through the service binding and caches a safe snapshot", async () => {
    serviceFetch.mockResolvedValue(
      new Response(JSON.stringify({
        count: 12,
        observedAt: "2026-08-21T00:00:00.000Z",
        privateRoomIds: ["must-not-escape"],
      }), { status: 200 }),
    );

    await expect(getLiveDirectoryPresence()).resolves.toEqual({
      count: 12,
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    const request = serviceFetch.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe("/presence");
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:presence:v1",
      JSON.stringify({ count: 12, observedAt: "2026-08-21T00:00:00.000Z" }),
      { expirationTtl: 60 },
    );
  });

  it("uses a cached snapshot without waking the realtime Worker", async () => {
    kv.get.mockResolvedValue(JSON.stringify({
      count: 4,
      observedAt: "2026-08-21T00:00:00.000Z",
      privateRoomIds: ["must-not-escape"],
    }));

    await expect(getLiveDirectoryPresence()).resolves.toEqual({
      count: 4,
      observedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(serviceFetch).not.toHaveBeenCalled();
  });

  it("does not turn a registry failure into a cached zero", async () => {
    serviceFetch.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(getLiveDirectoryPresence()).resolves.toBeNull();
    expect(kv.put).toHaveBeenCalledWith(
      "live-directory:presence:v1",
      JSON.stringify({ unavailable: true }),
      { expirationTtl: 60 },
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("suppresses repeated service calls while the unavailable marker is fresh", async () => {
    serviceFetch.mockResolvedValue(new Response(null, { status: 503 }));
    kv.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ unavailable: true }));

    await expect(getLiveDirectoryPresence()).resolves.toBeNull();
    __resetLiveDirectoryCacheForTests();
    await expect(getLiveDirectoryPresence()).resolves.toBeNull();

    expect(serviceFetch).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("omits the estimate locally when the service binding is absent", async () => {
    vi.mocked(getCloudflareContext).mockResolvedValue({ env: {} } as never);

    await expect(getLiveDirectoryPresence()).resolves.toBeNull();
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("removes a malformed cached snapshot before the next read", async () => {
    kv.get.mockResolvedValue(JSON.stringify({ count: "not-a-number" }));
    await expect(getLiveDirectoryPresence()).resolves.toBeNull();

    expect(kv.delete).toHaveBeenCalledWith("live-directory:presence:v1");
  });
});
