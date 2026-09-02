/**
 * 追加報酬作成の raid/collection 境界テスト。
 *
 * 現行実装は所有権、アクティブカード存在確認、INSERT の全てを
 * PlanetScale/Drizzle で行う。DB応答キューとINSERT値を分離して記録し、
 * 予約センチネル・未登録パック・デプロイ窓の永続化判断を固定する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST, PUT } from "@/app/api/streamer/additional-rewards/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getDb } from "@/lib/db/client";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { ERROR_MESSAGES } from "@/lib/constants";

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

function primeDb(config: { selects?: DbResponse[]; inserts?: DbResponse[]; updates?: DbResponse[] }) {
  let selectIndex = 0;
  let insertIndex = 0;
  let updateIndex = 0;
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const returningCalls: Array<unknown> = [];
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
    update: vi.fn(() => {
      const responses = config.updates ?? [{ rows: [] }];
      const response = responses[Math.min(updateIndex++, responses.length - 1)];
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(response.rows ?? []);
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          // スナップショットで記録（route 側が payload をミューテートしても
          // 呼び出し時の値を検証できるようにする）
          updateCalls.push({ ...values });
          return builder;
        }),
        where: vi.fn(() => builder),
        returning: vi.fn((columns?: unknown) => {
          // 引数なし returning() と明示列 returning({...}) を区別して記録する
          // （collection_name 列未デプロイ窓で RETURNING 側の 42703 再発を防ぐ
          // 明示列への切り替えを検証するため）
          returningCalls.push(columns);
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: vi.fn() } as any);
  return { db, insertCalls, updateCalls, returningCalls };
}

function request(body: Record<string, unknown>, method: "POST" | "PUT" = "POST") {
  return new NextRequest("http://localhost/api/streamer/additional-rewards", {
    method,
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

// 追加報酬の現在行（PUT の存在確認・現在値取得に使う）。
function currentAdditionalReward(collectionName: string | null = "weapons") {
  return { id: "additional-1", collection_name: collectionName };
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
      inserts: [{ rows: [{ id: "additional-1", reward_id: "44444444-4444-4444-4444-444444444444" }] }],
    });
    const response = await POST(request({
      rewardId: "44444444-4444-4444-4444-444444444444",
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
      rewardId: "44444444-4444-4444-4444-444444444444",
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
      rewardId: "44444444-4444-4444-4444-444444444444",
      rewardName: "Empty",
      collectionName: "empty-pack",
    }));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("rejects a present but invalid collectionName type", async () => {
    const response = await POST(request({ rewardId: "44444444-4444-4444-4444-444444444444", collectionName: 123 }));
    expect(response.status).toBe(400);
  });

  it("rejects an unregistered pack name", async () => {
    const db = primeDb({ selects: [{ rows: [streamer(["characters"])] }] });
    const response = await POST(request({
      rewardId: "44444444-4444-4444-4444-444444444444",
      rewardName: "Weapons",
      collectionName: "weapons",
    }));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("still creates a reward with no pack", async () => {
    const db = primeDb({
      selects: [{ rows: [streamer()] }],
      inserts: [{ rows: [{ id: "additional-1", reward_id: "44444444-4444-4444-4444-444444444444" }] }],
    });
    const response = await POST(request({ rewardId: "44444444-4444-4444-4444-444444444444", rewardName: "No Pack" }));
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
      rewardId: "44444444-4444-4444-4444-444444444444",
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
      rewardId: "44444444-4444-4444-4444-444444444444",
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
      inserts: [{ rows: [{ id: "additional-1", reward_id: "44444444-4444-4444-4444-444444444444" }] }],
    });
    const response = await POST(request({
      rewardId: "44444444-4444-4444-4444-444444444444",
      rewardName: "Weapons",
      collectionName: "weapons",
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).collectionNameSkippedDeployWindow).toBe(true);
    expect(db.insertCalls[0]).not.toHaveProperty("collection_name");
  });

  it("rejects drawCount outside the supported range", async () => {
    const response = await POST(request({
      rewardId: "44444444-4444-4444-4444-444444444444",
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

describe("/api/streamer/additional-rewards PUT (update)", () => {
  const REWARD_ID = "44444444-4444-4444-4444-444444444444";

  it("updates collectionName when the new pack has active cards", async () => {
    const db = primeDb({
      selects: [
        { rows: [streamer(["weapons", "characters"])] },
        { rows: [currentAdditionalReward("weapons")] },
        { rows: [{ count: 3 }] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, collection_name: "characters" }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "characters",
    }, "PUT"));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(db.updateCalls[0]).toEqual(expect.objectContaining({ collection_name: "characters" }));
  });

  it("updates drawCount only when no collectionName is sent", async () => {
    const { db, updateCalls } = primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, draw_count: 10 }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      drawCount: 10,
    }, "PUT"));
    expect(response.status).toBe(200);
    expect(updateCalls[0]).toEqual(expect.objectContaining({ draw_count: 10 }));
    // 値が変わらないため checkCollectionHasActiveCards（3回目のselect）は走らない。
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("clears collectionName to null (back to all cards)", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, collection_name: null }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: null,
    }, "PUT"));
    expect(response.status).toBe(200);
    expect(updateCalls[0]).toEqual(expect.objectContaining({ collection_name: null }));
  });

  it("rejects an unregistered pack name", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer(["characters"])] },
        // 現在値は null（全カード）。送信値 weapons は登録済み一覧に無く、
        // 現在値とも異なるため membership 検証で 400 になる。
        { rows: [currentAdditionalReward(null)] },
      ],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "weapons",
    }, "PUT"));
    expect(response.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects a pack with no active cards", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer(["empty-pack"])] },
        { rows: [currentAdditionalReward("weapons")] },
        { rows: [{ count: 0 }] },
      ],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "empty-pack",
    }, "PUT"));
    expect(response.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it("allows re-sending the current (orphaned) binding without an active-card check", async () => {
    // 登録解除済みパック（一覧に無いが現在紐付け中）の再送信は維持扱いで許可し、
    // checkCollectionHasActiveCards（3回目のselect）は走らせない。
    const { db, updateCalls } = primeDb({
      selects: [
        { rows: [streamer(["characters"])] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, collection_name: "weapons" }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "weapons",
    }, "PUT"));
    expect(response.status).toBe(200);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(updateCalls[0]).toEqual(expect.objectContaining({ collection_name: "weapons" }));
  });

  it("accepts DEFAULT_PACK_SENTINEL when active unclassified cards exist", async () => {
    const db = primeDb({
      selects: [
        { rows: [streamer(["weapons"])] },
        { rows: [currentAdditionalReward("weapons")] },
        { rows: [{ count: 1 }] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, collection_name: DEFAULT_PACK_SENTINEL }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: DEFAULT_PACK_SENTINEL,
    }, "PUT"));
    expect(response.status).toBe(200);
    expect(db.updateCalls[0]).toEqual(
      expect.objectContaining({ collection_name: DEFAULT_PACK_SENTINEL }),
    );
  });

  it("returns 404 with the reward-specific message when the target does not exist", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [] },
      ],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "weapons",
    }, "PUT"));
    expect(response.status).toBe(404);
    // STREAMER_NOT_FOUND（英語）ではなく報酬不在専用の日本語文言を返す
    expect(await response.json()).toEqual({
      error: "この追加の引き換えは既に削除されています。設定を再読み込みしてください",
    });
    expect(updateCalls).toHaveLength(0);
  });

it("drops pack binding when card_pack_names is not deployed (deploy window)", async () => {
    // getStreamerForAdditionalRewardPost が card_pack_names 欠落でフォールバック
    // SELECT（2回目）を使うため、現在値の SELECT は 3 回目になる。
    const { updateCalls } = primeDb({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward" }] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, draw_count: 5 }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "characters",
      drawCount: 5,
    }, "PUT"));
    expect(response.status).toBe(200);
    expect((await response.json()).collectionNameSkippedDeployWindow).toBe(true);
    expect(updateCalls[0]).not.toHaveProperty("collection_name");
  });

  // 現在値と同じパック名の再送は「変更要求」ではないため、デプロイ窓でも
  // 反映待ちフラグを立てず、同値の UPDATE として処理する（文言と実態の一致）。
  it("card_pack_names未デプロイ窓でも現在値と同じ再送では反映待ちフラグを立てない", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward" }] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{ rows: [{ id: "additional-1", reward_id: REWARD_ID, collection_name: "weapons" }] }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "weapons",
    }, "PUT"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.collectionNameSkippedDeployWindow).toBeUndefined();
    // 現在値と同じなので updatePayload に collection_name が入り、同値 UPDATE が走る
    expect(updateCalls[0]).toEqual(expect.objectContaining({ collection_name: "weapons" }));
  });

  it("rejects a present but invalid collectionName type", async () => {
    const response = await PUT(request({ rewardId: REWARD_ID, collectionName: 123 }, "PUT"));
    expect(response.status).toBe(400);
  });

  it("rejects drawCount outside the supported range", async () => {
    const response = await PUT(request({ rewardId: REWARD_ID, drawCount: 20 }, "PUT"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "drawCount must be an integer between 1 and 15",
    });
  });

  it("rejects a missing rewardId", async () => {
    const response = await PUT(request({ drawCount: 5 }, "PUT"));
    expect(response.status).toBe(400);
  });

  it("rejects a non-object body instead of throwing (500)", async () => {
    const nullBody = new NextRequest("http://localhost/api/streamer/additional-rewards", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect((await PUT(nullBody)).status).toBe(400);
    const arrayBody = new NextRequest("http://localhost/api/streamer/additional-rewards", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect((await PUT(arrayBody)).status).toBe(400);
  });

  // 必須レビュー指摘（collection_name 列未デプロイ窓）の回帰テスト:
  // collectionName のみの更新を送ると、ストリップ後に空 payload になり
  // Drizzle の空 SET が throw するため、no-op へ分岐して 500 にしない。
  it("collection_name列未デプロイ窓でパック変更のみの更新はno-opになり500にならない", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer(["weapons", "characters"])] },
        { rows: [currentAdditionalReward("weapons")] },
        { rows: [{ count: 2 }] },
      ],
      updates: [{
        error: {
          code: "42703",
          message: 'column "collection_name" of relation "streamer_additional_gacha_rewards" does not exist',
        },
      }],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "characters",
    }, "PUT"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    // DB は変わっていないことを他の分岐と対称に伝える
    expect(body.unchanged).toBe(true);
    // ストリップが起きたことを応答で明示する（黙って破棄しない）
    expect(body.collectionNameSkippedDeployWindow).toBe(true);
    // ストリップ後の再試行は空 payload になるため DB を呼ばない（1回目のみ）
    expect(updateCalls).toHaveLength(1);
  });

  it("collection_name列未デプロイ窓でdrawCount併送時もストリップを応答フラグで明示する", async () => {
    const { updateCalls, returningCalls } = primeDb({
      selects: [
        { rows: [streamer(["weapons", "characters"])] },
        { rows: [currentAdditionalReward("weapons")] },
        { rows: [{ count: 2 }] },
      ],
      updates: [
        {
          error: {
            code: "42703",
            message: 'column "collection_name" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        },
        { rows: [{ id: "additional-1", reward_id: REWARD_ID, draw_count: 7 }] },
      ],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      collectionName: "characters",
      drawCount: 7,
    }, "PUT"));
    expect(response.status).toBe(200);
    const body = await response.json();
    // drawCount 併送時もストリップが起きたことを応答で明示する（黙って破棄しない）
    expect(body.collectionNameSkippedDeployWindow).toBe(true);
    expect(body.reward).toEqual(expect.objectContaining({ draw_count: 7 }));
    // 1回目は collection_name を含み 42703 で失敗、2回目は draw_count のみで成功
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]).toEqual(expect.objectContaining({ collection_name: "characters", draw_count: 7 }));
    expect(updateCalls[1]).toEqual(expect.objectContaining({ draw_count: 7 }));
    expect(updateCalls[1]).not.toHaveProperty("collection_name");
    // 初回の RETURNING は GET と同じ明示列（collection_name 含む）、
    // ストリップ後の再試行は collection_name を含まない明示列
    expect(returningCalls[0]).toEqual(expect.any(Object));
    expect(returningCalls[0]).toHaveProperty("collection_name");
    expect(returningCalls[1]).toEqual(expect.any(Object));
    expect(returningCalls[1]).not.toHaveProperty("collection_name");
  });

  it("collection_name列未デプロイ窓でdrawCountのみの更新もRETURNINGの列明示で500にならない", async () => {
    // 初回の引数なし returning() はスキーマ全列（collection_name 含む）を展開する
    // ため、SET が draw_count のみでも 42703 になり得る。列欠落エラーで再試行に
    // 分岐し、明示列 RETURNING で成功することを検証する。
    const { updateCalls, returningCalls } = primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [
        {
          error: {
            code: "42703",
            message: 'column "collection_name" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        },
        { rows: [{ id: "additional-1", reward_id: REWARD_ID, draw_count: 5 }] },
      ],
    });
    const response = await PUT(request({
      rewardId: REWARD_ID,
      drawCount: 5,
    }, "PUT"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.reward).toEqual(expect.objectContaining({ draw_count: 5 }));
    // SET に collection_name が無いため、ストリップ再試行でもフラグは立たない
    // （「パック変更は反映待ち」の誤表示を防ぐ）。
    expect(body.collectionNameSkippedDeployWindow).toBeUndefined();
    // 2回目の RETURNING は collection_name を含まない明示列
    expect(returningCalls[1]).toEqual(expect.any(Object));
    expect(returningCalls[1]).not.toHaveProperty("collection_name");
    // 2回目の SET は draw_count のみ（collection_name は元々無い）
    expect(updateCalls[1]).toEqual(expect.objectContaining({ draw_count: 5 }));
    expect(updateCalls[1]).not.toHaveProperty("collection_name");
  });

  it("rejects a non-number drawCount instead of coercing it", async () => {
    const response = await PUT(request({ rewardId: REWARD_ID, drawCount: true }, "PUT"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "drawCount must be an integer between 1 and 15",
    });
  });

  // POST と同じく、draw_count / is_raid_limited 列未デプロイ窓は 503 + 専用文言
  // （raid-options 列欠落。接続断等は isRaidOptionsSchemaErrorPg が除外する）。
  it("raid-options列欠落エラー(42703 draw_count)なら503", async () => {
    primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
      updates: [{
        error: {
          code: "42703",
          message: 'column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist',
        },
      }],
    });
    const response = await PUT(request({ rewardId: REWARD_ID, drawCount: 5 }, "PUT"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "追加の引き換えのN連ガチャ設定がまだDBに反映されていません。少し待ってから再度お試しください。",
    });
  });

  it("変更なしのリクエストはunchangedを返しUPDATEしない", async () => {
    const { updateCalls } = primeDb({
      selects: [
        { rows: [streamer()] },
        { rows: [currentAdditionalReward("weapons")] },
      ],
    });
    const response = await PUT(request({ rewardId: REWARD_ID }, "PUT"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.unchanged).toBe(true);
    expect(updateCalls).toHaveLength(0);
  });

  it("CSRF検証が無効な場合は403を返し、レートリミット/セッション取得/DB更新に到達しない", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false, error: "bad csrf" } as any);
    const response = await PUT(request({ rewardId: REWARD_ID, collectionName: "weapons" }, "PUT"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.FORBIDDEN });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("未認証なら401を返す", async () => {
    mockCanUseStreamerFeatures.mockReturnValue(false);
    const response = await PUT(request({ rewardId: REWARD_ID }, "PUT"));
    expect(response.status).toBe(401);
  });

  it("レートリミット超過なら429を返す", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as any);
    const response = await PUT(request({ rewardId: REWARD_ID }, "PUT"));
    expect(response.status).toBe(429);
  });

  it("Content-Typeが不正なら415を返す", async () => {
    mockValidateContentType.mockReturnValue(
      new NextResponse(JSON.stringify({ error: "unsupported media type" }), { status: 415 })
    );
    const response = await PUT(request({ rewardId: REWARD_ID }, "PUT"));
    expect(response.status).toBe(415);
  });
});
