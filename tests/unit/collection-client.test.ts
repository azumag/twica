import { afterEach, describe, expect, it, vi } from "vitest";
import { postJsonWithCsrfRetry } from "@/lib/collection-client";

// postJsonWithCsrfRetry: CSRF cookie 未発行時だけ /api/session で発行して 1 回再送する (#1953)
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("postJsonWithCsrfRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("成功時は 1 回だけ POST して ok=true", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postJsonWithCsrfRetry("/api/x", { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ a: 1 }) });
  });

  it("403 CSRF_TOKEN_INVALID なら /api/session を挟んで 1 回だけ再送する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(403, { code: "CSRF_TOKEN_INVALID" }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postJsonWithCsrfRetry("/api/x", {})).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/x", "/api/session", "/api/x"]);
  });

  it("再送後も失敗、または CSRF 以外の 403 は ok=false で再送しない", async () => {
    const csrfTwice = vi
      .fn()
      .mockResolvedValueOnce(json(403, { code: "CSRF_TOKEN_INVALID" }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(403, { code: "CSRF_TOKEN_INVALID" }));
    vi.stubGlobal("fetch", csrfTwice);
    await expect(postJsonWithCsrfRetry("/api/x", {})).resolves.toEqual({ ok: false });
    expect(csrfTwice).toHaveBeenCalledTimes(3);

    const forbidden = vi.fn().mockResolvedValueOnce(json(403, { code: "FORBIDDEN" }));
    vi.stubGlobal("fetch", forbidden);
    await expect(postJsonWithCsrfRetry("/api/x", {})).resolves.toEqual({ ok: false });
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it("ネットワークエラーは ok=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("network")));
    await expect(postJsonWithCsrfRetry("/api/x", {})).resolves.toEqual({ ok: false });
  });
});
