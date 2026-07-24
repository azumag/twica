/**
 * POST /api/cards/batch-update のPlanetScale契約。
 *
 * 所有権・対象カード照合・更新後取得は Drizzle、原子的な一括更新は
 * postgres.js のSQLタグで行う。SQLタグへ渡すJSONを検証し、単なるレスポンス
 * モックでは見逃すID/率の取り違えを防ぐ。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cards/batch-update/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);

function primeBatchUpdate(options: {
  streamer?: Record<string, unknown> | null;
  existingCards?: Array<Record<string, unknown>>;
  rpcResult?: { updated_count: number } | null;
  rpcError?: Error | null;
  updatedCards?: Array<Record<string, unknown>>;
  updatedCardsError?: Error | null;
}) {
  const responses = [
    { rows: options.streamer ? [options.streamer] : [] },
    { rows: options.existingCards ?? [] },
    options.updatedCardsError
      ? { error: options.updatedCardsError, rows: [] }
      : { rows: options.updatedCards ?? [] },
  ];
  let selectIndex = 0;
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const response = responses[Math.min(selectIndex++, responses.length - 1)];
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              response.rows.map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null])),
              ),
            );
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  const sqlMock = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    void _strings;
    void _values;
    if (options.rpcError) throw options.rpcError;
    return [{ result: options.rpcResult ?? null }];
  });
  vi.mocked(getDb).mockResolvedValue({ db, sql: sqlMock } as any);
  return { db, sqlMock };
}

function createRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/cards/batch-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const STREAMER = {
  id: "streamer-1",
  twitch_user_id: "twitch-user-123",
  rarity_weights: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    twitchUserId: "twitch-user-123",
    twitchUsername: "testuser",
    twitchDisplayName: "Test User",
    twitchProfileImageUrl: "https://example.com/avatar.jpg",
    broadcasterType: "affiliate",
    expiresAt: Date.now() + 60_000,
    version: 1,
  });
  mockCanUseStreamerFeatures.mockReturnValue(true);
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
  });
  mockValidateCSRFToken.mockResolvedValue({ valid: true });
  mockValidateContentType.mockReturnValue(null);
});

describe("POST /api/cards/batch-update", () => {
  it("returns 400 for duplicate card IDs", async () => {
    primeBatchUpdate({ streamer: STREAMER });
    const response = await POST(createRequest({
      streamerId: "streamer-1",
      updates: [
        { id: "card-1", dropRate: 0.5 },
        { id: "card-1", dropRate: 0.3 },
        { id: "card-2", dropRate: 0.2 },
      ],
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("同じカードIDが複数含まれています");
  });

  it("accepts distinct card IDs and returns the updated count", async () => {
    const cardIds = ["card-1", "card-2", "card-3"];
    primeBatchUpdate({
      streamer: STREAMER,
      existingCards: cardIds.map((id) => ({ id })),
      rpcResult: { updated_count: 3 },
      updatedCards: cardIds.map((id) => ({ id, streamer_id: "streamer-1", drop_rate: 0.5 })),
    });
    const response = await POST(createRequest({
      streamerId: "streamer-1",
      updates: cardIds.map((id, index) => ({ id, dropRate: 0.5 - index * 0.1 })),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, updated: 3 });
  });

  it("passes the exact normalized payload to batch_update_card_drop_rates", async () => {
    const mock = primeBatchUpdate({
      streamer: STREAMER,
      existingCards: [{ id: "card-1" }, { id: "card-2" }],
      rpcResult: { updated_count: 2 },
      updatedCards: [{ id: "card-1" }, { id: "card-2" }],
    });
    await POST(createRequest({
      streamerId: "streamer-1",
      updates: [
        { id: "card-1", dropRate: 0.5 },
        { id: "card-2", dropRate: 0.3 },
      ],
    }));
    expect(mock.sqlMock).toHaveBeenCalledTimes(1);
    expect(mock.sqlMock.mock.calls[0].slice(1)).toEqual([
      "streamer-1",
      JSON.stringify([
        { id: "card-1", drop_rate: 0.5 },
        { id: "card-2", drop_rate: 0.3 },
      ]),
    ]);
  });

  it("maps an RPC error to 500", async () => {
    primeBatchUpdate({
      streamer: STREAMER,
      existingCards: [{ id: "card-1" }],
      rpcError: new Error("RPC function error"),
    });
    const response = await POST(createRequest({
      streamerId: "streamer-1",
      updates: [{ id: "card-1", dropRate: 0.5 }],
    }));
    expect(response.status).toBe(500);
  });

  it("returns 500 when the RPC updates fewer rows than requested", async () => {
    primeBatchUpdate({
      streamer: STREAMER,
      existingCards: [{ id: "card-1" }, { id: "card-2" }],
      rpcResult: { updated_count: 1 },
    });
    const response = await POST(createRequest({
      streamerId: "streamer-1",
      updates: [
        { id: "card-1", dropRate: 0.5 },
        { id: "card-2", dropRate: 0.3 },
      ],
    }));
    expect(response.status).toBe(500);
  });

  it("returns 400 for an empty updates array", async () => {
    const response = await POST(createRequest({ streamerId: "streamer-1", updates: [] }));
    expect(response.status).toBe(400);
  });

  it("returns 400 above the batch size limit", async () => {
    const updates = Array.from({ length: 101 }, (_, index) => ({
      id: `card-${index}`,
      dropRate: 0.5,
    }));
    const response = await POST(createRequest({ streamerId: "streamer-1", updates }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("100");
  });

  it("returns 400 for an out-of-range dropRate", async () => {
    primeBatchUpdate({ streamer: STREAMER });
    const response = await POST(createRequest({
      streamerId: "streamer-1",
      updates: [{ id: "card-1", dropRate: 1.5 }],
    }));
    expect(response.status).toBe(400);
  });
});
