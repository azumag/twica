import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/cards/batch-update/route";
import { getDb } from "@/lib/db/client";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

function createPgSelectMock(responses: unknown[][]) {
  let responseIndex = 0;
  const select = vi.fn(() => {
    const rows = responses[responseIndex] ?? [];
    responseIndex += 1;

    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  });

  return { db: { select }, select };
}

function createSqlMock(results: Array<{ updated_count: number }>) {
  let resultIndex = 0;
  return vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = results[resultIndex] ?? results[results.length - 1];
    resultIndex += 1;
    return Promise.resolve([{ result }]);
  });
}

function createRequest(): NextRequest {
  return new NextRequest("http://localhost/api/cards/batch-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      streamerId: "streamer-1",
      updates: [
        {
          id: "card-after-cutover",
          dropRate: 0.25,
          intraRarityWeight: 2,
        },
      ],
    }),
  });
}

describe("POST /api/cards/batch-update DB driver consistency (#794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DB_DRIVER", "pg");

    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-user-1",
      twitchUsername: "streamer",
      twitchDisplayName: "Streamer",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    mockGetRateLimitIdentifier.mockResolvedValue("user:twitch-user-1");
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockValidateContentType.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses PlanetScale for ownership, card validation, recalculation, and response reads", async () => {
    const streamerRow = {
      id: "streamer-1",
      rarity_weights: { common: 100 },
    };
    const activeCards = [
      {
        id: "card-old",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
      },
      {
        id: "card-after-cutover",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 2,
      },
    ];
    const recalculatedCards = [
      {
        id: "card-old",
        streamer_id: "streamer-1",
        rarity: "common",
        drop_rate: 0.3333,
        intra_rarity_weight: 1,
        is_active: true,
      },
      {
        id: "card-after-cutover",
        streamer_id: "streamer-1",
        rarity: "common",
        drop_rate: 0.6667,
        intra_rarity_weight: 2,
        is_active: true,
      },
    ];
    const updatedCards = [recalculatedCards[1]];

    const pg = createPgSelectMock([
      [streamerRow],
      [{ id: "card-after-cutover" }],
      activeCards,
      recalculatedCards,
      updatedCards,
    ]);
    const sql = createSqlMock([
      { updated_count: 1 },
      { updated_count: 2 },
    ]);
    vi.mocked(getDb).mockResolvedValue({
      db: pg.db,
      sql,
    } as never);

    const supabaseAdmin = {
      from: vi.fn(() => {
        throw new Error("Supabase read must not run in pg mode");
      }),
      rpc: vi.fn(() => {
        throw new Error("Supabase RPC must not run in pg mode");
      }),
    };
    mockGetSupabaseAdmin.mockReturnValue(supabaseAdmin as never);

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      updated: 1,
      cards: updatedCards,
      recalculatedCards,
    });
    expect(pg.select).toHaveBeenCalledTimes(5);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(sql).toHaveBeenCalledTimes(2);

    const firstSqlValues = (sql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ]).slice(1);
    expect(firstSqlValues).toEqual([
      "streamer-1",
      JSON.stringify([
        {
          id: "card-after-cutover",
          drop_rate: 0.25,
          intra_rarity_weight: 2,
        },
      ]),
    ]);

    const secondSqlValues = (sql.mock.calls[1] as [
      TemplateStringsArray,
      ...unknown[],
    ]).slice(1);
    expect(secondSqlValues).toEqual([
      "streamer-1",
      JSON.stringify([
        { id: "card-old", drop_rate: 0.3333 },
        { id: "card-after-cutover", drop_rate: 0.6667 },
      ]),
    ]);
  });
});
