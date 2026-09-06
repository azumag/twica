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
vi.mock("@/lib/constants", async (importOriginal) => await importOriginal());

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockGetUserPlan = vi.mocked(getUserPlan);

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(config: { selects: PgResponse[] }) {
  let selectIndex = 0;
  const updateCalls: Array<{ set?: Record<string, unknown> }> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const response = config.selects[Math.min(selectIndex, config.selects.length - 1)];
      selectIndex += 1;
      const resolve = () => {
        if (response.error) return Promise.reject(response.error);
        return Promise.resolve(
          (response.rows ?? []).map((row) =>
            Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
          )
        );
      };
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    update: vi.fn(() => {
      const call: { set?: Record<string, unknown> } = {};
      updateCalls.push(call);
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = { ...values };
          return builder;
        }),
        where: vi.fn(() => Promise.resolve([])),
      };
      return builder;
    }),
  };

  return { db, updateCalls };
}

async function loadRoute() {
  return import("@/app/api/streamer/settings/route");
}

describe("streamer settings basic-plan sound legacy mirror (#991)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      twitchUserId: "streamer123",
      twitchUsername: "testuser",
      twitchDisplayName: "Test User",
      twitchProfileImageUrl: "https://example.com/avatar.jpg",
      broadcasterType: "affiliate",
      expiresAt: Date.UTC(2100, 0, 1),
      version: 1,
    } as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.UTC(2100, 0, 1),
    } as any);
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
    mockValidateContentType.mockReturnValue(null);
    mockGetUserPlan.mockResolvedValue("basic" as any);
  });

  it("derives gacha_sound_url/enabled from the post-gate rules, not the submitted gated fields", async () => {
    const existingRule = {
      id: "catch-all",
      url: "https://example.com/all.mp3",
      enabled: true,
      label: "All",
      targetType: "all",
      rarity: null,
      rewardId: null,
      rewardName: null,
    };
    const pg = createDrizzleDbMock({
      selects: [
        { rows: [{ id: "streamer123" }] },
        { rows: [{ gacha_sound_rules: [existingRule] }] },
      ],
    });
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);

    const { POST } = await loadRoute();
    const response = await POST(
      new NextRequest("http://localhost:3000/api/streamer/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamerId: "streamer123",
          gachaSoundRules: [
            {
              ...existingRule,
              targetType: "rarity",
              rarity: "legendary",
            },
          ],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gachaSoundRulesPremiumRequired).toBe(true);
    expect(body.gachaSoundRules).toEqual([existingRule]);
    expect(pg.updateCalls).toHaveLength(1);
    expect(pg.updateCalls[0].set).toEqual(
      expect.objectContaining({
        gacha_sound_rules: [existingRule],
        gacha_sound_url: existingRule.url,
        gacha_sound_enabled: true,
      })
    );
  });
});
