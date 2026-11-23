import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// PUT /api/streamer/trade-wanted-restrictions: 認可・検証・エラー写像。
// 置換のトランザクション自体は実 PostgreSQL の
// tests/integration/trade-wanted-restriction-pg.test.ts で検証する。

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  validateCSRFToken: vi.fn(),
  validateContentType: vi.fn(),
  checkRateLimit: vi.fn(),
  replace: vi.fn(),
  selectStreamer: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}));
vi.mock("@/lib/csrf", () => ({ validateCSRFToken: mocks.validateCSRFToken }));
vi.mock("@/lib/request-validation", () => ({ validateContentType: mocks.validateContentType }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getRateLimitIdentifier: vi.fn().mockResolvedValue("ip:test"),
  rateLimits: { streamerSettings: {} },
}));
vi.mock("@/lib/db/retry", () => ({ withDbRetry: async (fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/db/client", () => ({
  getDb: async () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: mocks.selectStreamer }) }) }),
    },
  }),
}));
vi.mock("@/lib/logger.server", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trade-wanted-restrictions", () => ({
  TRADE_WANTED_RESTRICTION_MAX_ITEMS: 3,
  replaceTradeWantedRestriction: mocks.replace,
}));

import { PUT } from "@/app/api/streamer/trade-wanted-restrictions/route";

const STREAMER_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION = { twitchUserId: "streamer-1", broadcasterType: "partner" };

function put(body: unknown) {
  return new NextRequest("http://localhost/api/streamer/trade-wanted-restrictions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateContentType.mockReturnValue(null);
  mocks.validateCSRFToken.mockResolvedValue({ valid: true });
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.canUseStreamerFeatures.mockReturnValue(true);
  mocks.checkRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 });
  mocks.selectStreamer.mockResolvedValue([{ id: STREAMER_ID }]);
  mocks.replace.mockResolvedValue({ kind: "ok", ruleRemoved: false });
});

describe("PUT /api/streamer/trade-wanted-restrictions", () => {
  it("replaces the allowlist of the session's own streamer (never a body-supplied one)", async () => {
    const response = await PUT(put({ allowedWantedCardIds: [C, D], streamerId: "evil" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, ruleRemoved: false });
    // 配信者はセッションの twitchUserId から解決する。body の streamerId は使わない。
    expect(mocks.replace).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      allowedWantedCardIds: [C, D],
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("normalizes UUIDs to lower case and drops duplicates", async () => {
    await PUT(put({ allowedWantedCardIds: [C.toUpperCase(), C] }));
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.objectContaining({ allowedWantedCardIds: [C] }),
    );
  });

  it("accepts the card being listed in the list (the old self-reference rule is gone)", async () => {
    // リストは出品カードに依存しない。自分自身を「求む」にして出品する操作は
    // 出品 API の TRADE_SAME_CARD が止める(この API の責務ではない)。
    const response = await PUT(put({ allowedWantedCardIds: [A, C] }));
    expect(response.status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith({
      streamerId: STREAMER_ID,
      allowedWantedCardIds: [A, C],
    });
  });

  it("an empty list removes the rule", async () => {
    mocks.replace.mockResolvedValue({ kind: "ok", ruleRemoved: true });
    const response = await PUT(put({ allowedWantedCardIds: [] }));
    expect(await response.json()).toEqual({ success: true, ruleRemoved: true });
  });

  it.each([
    ["CSRF failure", () => mocks.validateCSRFToken.mockResolvedValue({ valid: false }), 403],
    ["no session", () => mocks.getSession.mockResolvedValue(null), 401],
    ["not a streamer", () => mocks.canUseStreamerFeatures.mockReturnValue(false), 401],
    ["rate limited", () => mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: 0 }), 429],
    ["no streamer row", () => mocks.selectStreamer.mockResolvedValue([]), 401],
  ])("rejects: %s", async (_label, arrange, status) => {
    arrange();
    const response = await PUT(put({ allowedWantedCardIds: [C] }));
    expect(response.status).toBe(status);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["not an object", "[]"],
    ["missing allowedWantedCardIds", { streamerId: STREAMER_ID }],
    ["allowedWantedCardIds not an array", { allowedWantedCardIds: C }],
    ["allowed id not a uuid", { allowedWantedCardIds: ["x"] }],
    ["allowed id not a string", { allowedWantedCardIds: [1] }],
    ["over the item limit", { allowedWantedCardIds: [C, D, A, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"] }],
  ])("400 for an invalid body: %s", async (_label, body) => {
    const response = await PUT(put(body));
    expect(response.status).toBe(400);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("answers 404 for a card that is not the streamer's (other channel and missing are indistinguishable)", async () => {
    mocks.replace.mockResolvedValue({ kind: "error", code: "CARD_NOT_FOUND" });
    const response = await PUT(put({ allowedWantedCardIds: [C] }));
    expect(response.status).toBe(404);
  });

  it("answers 503 (never a fake success) while the tables are missing (migration not applied)", async () => {
    mocks.replace.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    const response = await PUT(put({ allowedWantedCardIds: [C] }));
    expect(response.status).toBe(503);
    expect((await response.json()).unavailable).toBe(true);
  });

  it("answers 500 without internal details for any other failure", async () => {
    mocks.replace.mockRejectedValue(new Error("secret db detail"));
    const response = await PUT(put({ allowedWantedCardIds: [C] }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
