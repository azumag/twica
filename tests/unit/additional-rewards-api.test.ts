/**
 * 追加報酬作成の raid/collection 境界テスト。
 *
 * 現行実装は所有権、アクティブカード存在確認、INSERT の全てを
 * PlanetScale/Drizzle で行う。DB応答キューとINSERT値を分離して記録し、
 * 予約センチネル・未登録パック・デプロイ窓の永続化判断を固定する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/streamer/additional-rewards/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getDb } from "@/lib/db/client";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);

interface DbResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function primeDb(config: { selects?: DbResponse[]; inserts?: DbResponse[] }) {
  let selectIndex = 0;
  let insertIndex = 0;
  const insertCalls: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex++, responses.length - 1)];
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
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
    insert: vi.fn(() => {
      const responses = config.inserts ?? [{ rows: [] }];
      const response = responses[Math.min(insertIndex++, responses.length - 1)];
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(response.rows ?? []);
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          insertCalls.push(values);
          return builder;
        }),
        returning: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: vi.fn() } as any);
  return { db, insertCalls };
}

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/streamer/additional-rewards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamer(cardPackNames: string[] = []) {
  return {
    id: "streamer-1",
    channel_point_reward_id: "main-reward",
    card_pack_names: cardPackNames,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    twitchUserId: "streamer-twitch-1",
    twitchUsername: "streamer",
    twitchDisplayName: "Streamer",
    twitchProfileImageUrl: "https://example.com/avatar.png",
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

describe("/api/streamer/additional-rewards raid options", () => {
  it("persists drawCount and raid-limited options", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer()] }],
      inserts: [{ rows: [{ id: "additional-1", reward_id: "raid-reward" }] }],
    });
    const response = await POST(request({
      rewardId: "raid-reward",
      rewardName: "Raid 10",
      drawCount: 10,
      isRaidLimited: true,
    }));
    expect(response.status).toBe(200);
    expect(db.insertCalls[0]).toEqual(
      expect.objectContaining({ draw_count: 10, is_raid_limited: true }),
    );
  });

  it("persists collectionName when the pack has active cards", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer(["weapons"])] }, { rows: [{ count: 2 }] }],
      inserts: [{ rows: [{ id: "additional-1", collection_name: "weapons" }] }],
    });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Weapons",
      collectionName: "weapons",
    }));
    expect(response.status).toBe(200);
    expect(db.insertCalls[0]).toEqual(expect.objectContaining({ collection_name: "weapons" }));
  });

  it("rejects a pack with no active cards", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer(["empty-pack"])] }, { rows: [{ count: 0 }] }],
    });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Empty",
      collectionName: "empty-pack",
    }));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("rejects a present but invalid collectionName type", async () => {
    const response = await POST(request({ rewardId: "extra-reward", collectionName: 123 }));
    expect(response.status).toBe(400);
  });

  it("rejects an unregistered pack name", async () => {
    const db = primeDb({ selects: [{ rows: [streamer(["characters"])] }] });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Weapons",
      collectionName: "weapons",
    }));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("still creates a reward with no pack", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer()] }],
      inserts: [{ rows: [{ id: "additional-1", reward_id: "extra-reward" }] }],
    });
    const response = await POST(request({ rewardId: "extra-reward", rewardName: "No Pack" }));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(db.insertCalls[0]).not.toHaveProperty("collection_name");
  });

  it("accepts DEFAULT_PACK_SENTINEL when active unclassified cards exist", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer(["weapons"])] }, { rows: [{ count: 1 }] }],
      inserts: [{ rows: [{ id: "additional-1", collection_name: DEFAULT_PACK_SENTINEL }] }],
    });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Default",
      collectionName: DEFAULT_PACK_SENTINEL,
    }));
    expect(response.status).toBe(200);
    expect(db.insertCalls[0]).toEqual(
      expect.objectContaining({ collection_name: DEFAULT_PACK_SENTINEL }),
    );
  });

  it("rejects DEFAULT_PACK_SENTINEL when no active unclassified card exists", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer()] }, { rows: [{ count: 0 }] }],
    });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Default",
      collectionName: DEFAULT_PACK_SENTINEL,
    }));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("drops pack binding when card_pack_names is not deployed", async () => {
    const db = primeDb({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward" }] },
      ],
      inserts: [{ rows: [{ id: "additional-1", reward_id: "extra-reward" }] }],
    });
    const response = await POST(request({
      rewardId: "extra-reward",
      rewardName: "Weapons",
      collectionName: "weapons",
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).collectionNameSkippedDeployWindow).toBe(true);
    expect(db.insertCalls[0]).not.toHaveProperty("collection_name");
  });

  it("rejects drawCount outside the supported range", async () => {
    const response = await POST(request({
      rewardId: "raid-reward",
      rewardName: "Raid 20",
      drawCount: 20,
      isRaidLimited: true,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "drawCount must be an integer between 1 and 15",
    });
  });
});
