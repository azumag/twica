import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getUserPlan } from "@/lib/plan";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/plan");
vi.mock("@/lib/db/client");
vi.mock("@/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = {
  twitchUserId: "streamer123",
  twitchUsername: "testuser",
  twitchDisplayName: "Test User",
  twitchProfileImageUrl: "https://example.com/avatar.jpg",
  broadcasterType: "affiliate",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  version: 1,
};

interface DbResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDbMock(selects: DbResponse[]) {
  let selectIndex = 0;
  const updateCalls: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const response = selects[Math.min(selectIndex, selects.length - 1)];
      selectIndex += 1;
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            );
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    update: vi.fn(() => {
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          updateCalls.push({ ...values });
          return builder;
        }),
        where: vi.fn(() => builder),
        then: (onFulfilled: any) => Promise.resolve([]).then(onFulfilled),
      };
      return builder;
    }),
  };

  return { db, updateCalls };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/streamer/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("streamer/settings gacha_sound_rules deploy-window fallback (#991)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION as any);
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true);
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    } as any);
    vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any);
    vi.mocked(validateContentType).mockReturnValue(null);
    vi.mocked(getUserPlan).mockResolvedValue("basic" as any);
  });

  it("既存ルール読取時にgacha_sound_rules列が未適用なら空配列として保存を継続する", async () => {
    const pg = createDbMock([
      {
        rows: [
          {
            id: "streamer123",
            channel_point_collection_name: null,
            card_pack_names: [],
            pack_rarity_weights: null,
          },
        ],
      },
      {
        error: {
          code: "42703",
          message: 'column "gacha_sound_rules" of relation "streamers" does not exist',
        },
      },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);

    const { POST } = await import("@/app/api/streamer/settings/route");
    const rule = {
      id: "catch-all",
      url: "https://example.com/all.mp3",
      enabled: true,
      label: "default",
      targetType: "all",
      rarity: null,
      rewardId: null,
      rewardName: null,
    };

    const response = await POST(
      postRequest({
        streamerId: "streamer123",
        gachaSoundRules: [rule],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("gachaSoundRulesPremiumRequired");
    expect(body.gachaSoundRules).toEqual([rule]);
    expect(pg.db.select).toHaveBeenCalledTimes(2);
    expect(pg.updateCalls).toHaveLength(1);
    expect(pg.updateCalls[0]).toEqual(
      expect.objectContaining({
        gacha_sound_rules: [rule],
        gacha_sound_url: rule.url,
        gacha_sound_enabled: true,
      })
    );
  });
});
