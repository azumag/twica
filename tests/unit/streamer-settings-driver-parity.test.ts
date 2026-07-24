/**
 * #663: 配信者設定APIのPlanetScale契約テスト
 *
 * 対象: POST /api/streamer/settings
 * ここでは DB アクセスの形状（クエリ対象テーブル/条件/値、フォールバック
 * チェインの発火順序、skip フラグの立ち方）に焦点を当てる。バリデーション/
 * 正規化ロジックそのものの網羅的な検証は
 * tests/unit/streamer-settings-api.test.ts に委ねる。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getUserPlan } from "@/lib/plan";
import { getDb } from "@/lib/db/client";
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from "@/lib/db/schema";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/plan");
vi.mock("@/lib/constants", async (importOriginal) => await importOriginal());
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockGetUserPlan = vi.mocked(getUserPlan);

const SESSION = {
  twitchUserId: "streamer123",
  twitchUsername: "testuser",
  twitchDisplayName: "Test User",
  twitchProfileImageUrl: "https://example.com/avatar.jpg",
  broadcasterType: "affiliate",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  version: 1,
};

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(
  config: { selects?: PgResponse[]; updates?: PgResponse[]; inserts?: PgResponse[]; deletes?: PgResponse[] } = {}
) {
  let selectIndex = 0;
  let updateIndex = 0;
  let insertIndex = 0;
  let deleteIndex = 0;
  const selectCalls: Array<{ where?: unknown }> = [];
  const updateCalls: Array<{ table: unknown; set?: unknown; where?: unknown }> = [];
  const insertCalls: Array<{ table: unknown; values?: unknown; onConflict?: unknown }> = [];
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex, responses.length - 1)];
      selectIndex += 1;
      const call: { where?: unknown } = {};
      selectCalls.push(call);
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
        where: vi.fn((condition: unknown) => {
          call.where = condition;
          return builder;
        }),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [] }];
      const response = responses[Math.min(updateIndex, responses.length - 1)];
      updateIndex += 1;
      const call: { table: unknown; set?: unknown; where?: unknown } = { table };
      updateCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []));
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          // updateData は呼び出し元(applyStreamerSettingsUpdatePg)と共有する同一
          // オブジェクト参照であり、カスケード内で後続の delete によって
          // ミューテートされる。呼び出し記録として使うため、記録時点の
          // スナップショット(浅いコピー)を保存する(参照だとテスト側の
          // アサーション時点で最終状態しか見えなくなる)。
          call.set = { ...values };
          return builder;
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [] }];
      const response = responses[Math.min(insertIndex, responses.length - 1)];
      insertIndex += 1;
      const call: { table: unknown; values?: unknown; onConflict?: unknown } = { table };
      insertCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []));
      const builder: any = {
        values: vi.fn((values: unknown) => {
          call.values = values;
          return builder;
        }),
        onConflictDoUpdate: vi.fn((options: unknown) => {
          call.onConflict = options;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    delete: vi.fn((table: unknown) => {
      const responses = config.deletes ?? [{ rows: [] }];
      const response = responses[Math.min(deleteIndex, responses.length - 1)];
      deleteIndex += 1;
      const call: { table: unknown; where?: unknown } = { table };
      deleteCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []));
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.where = condition;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  return { db, selectCalls, updateCalls, insertCalls, deleteCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/streamer/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadRoute() {
  return import("@/app/api/streamer/settings/route");
}

describe("streamer/settings POST: PlanetScale契約 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 } as any);
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
    mockValidateContentType.mockReturnValue(null);
    mockGetUserPlan.mockResolvedValue("support" as any);
  });

  it("所有権SELECT + UPDATE が正しいテーブル/条件/値で実行される", async () => {
    const pg = createDrizzleDbMock({
      selects: [
        {
          rows: [
            { id: "streamer123", channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null },
          ],
        },
      ],
      updates: [{ rows: [] }],
    });
    primePgDb(pg);
    const { POST: pgPOST } = await loadRoute();
    const pgResponse = await pgPOST(
      postRequest({
        streamerId: "streamer123",
        channelPointRewardId: "reward-123",
        channelPointRewardName: "Test Reward",
      })
    );
    const pgBody = await pgResponse.json();

    expect(pgResponse.status).toBe(200);
    expect(pgBody).toEqual(expect.objectContaining({ success: true }));
    expect(getDb).toHaveBeenCalled();
    expect(pg.selectCalls[0].where).toEqual(
      and(eq(streamersTable.id, "streamer123"), eq(streamersTable.twitch_user_id, "streamer123"))
    );
    expect(pg.updateCalls[0].table).toBe(streamersTable);
    expect(pg.updateCalls[0].set).toEqual(
      expect.objectContaining({ channel_point_reward_id: "reward-123", channel_point_reward_name: "Test Reward" })
    );
    expect(pg.updateCalls[0].where).toEqual(eq(streamersTable.id, "streamer123"));
  });

  it("streamer所有権が無ければ403", async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
    primePgDb(pg);

    const { POST } = await loadRoute();
    const response = await POST(postRequest({ streamerId: "streamer123", channelPointRewardId: "reward-1" }));
    expect(response.status).toBe(403);
  });

  it("rarity_weights_scope 列欠落 → 剥がして再試行し、rarityWeightsScopeSkippedDeployWindow を返す", async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: "streamer123", channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null }] }],
      updates: [
        { error: { code: "42703", message: 'column "rarity_weights_scope" of relation "streamers" does not exist' } },
        { rows: [] },
      ],
    });
    primePgDb(pg);

    const { POST } = await loadRoute();
    // rarityWeightsScope 単独だと剥がした後 updateData が空になり2回目のDB呼び出しが
    // 発生しない（「空になったら error=null」短絡）ため、剥がされない
    // 別フィールド(showUnownedCards)を同時に送って実際にリトライが発火することを検証する。
    const response = await POST(
      postRequest({ streamerId: "streamer123", rarityWeightsScope: "per_pack", showUnownedCards: true })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rarityWeightsScopeSkippedDeployWindow).toBe(true);
    expect(pg.updateCalls).toHaveLength(2);
    expect(pg.updateCalls[0].set).toEqual({ rarity_weights_scope: "per_pack", show_unowned_cards: true });
    expect(pg.updateCalls[1].set).toEqual({ show_unowned_cards: true });
  });

  it("gacha_sound_rules 列欠落 → legacy fallback で保存し、gachaSoundRulesSkippedDeployWindow を返す", async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: "streamer123", channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null }] }],
      updates: [
        {
          error: {
            code: "42703",
            message: 'column "gacha_sound_rules" of relation "streamers" does not exist',
          },
        },
        { rows: [] },
      ],
    });
    primePgDb(pg);

    const { POST } = await loadRoute();
    const response = await POST(
      postRequest({
        streamerId: "streamer123",
        gachaSoundRules: [
          { id: "catch-all", url: "https://example.com/all.mp3", enabled: true, label: "A", targetType: "all", rarity: null, rewardId: null, rewardName: null },
        ],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gachaSoundRulesSkippedDeployWindow).toBe(true);
    expect(pg.updateCalls).toHaveLength(2);
    // legacy fallback: gacha_sound_rules は含まれないが gacha_sound_url/enabled は含まれる
    expect(pg.updateCalls[1].set).toEqual(
      expect.objectContaining({ gacha_sound_url: "https://example.com/all.mp3", gacha_sound_enabled: true })
    );
    expect(pg.updateCalls[1].set).not.toHaveProperty("gacha_sound_rules");
  });

  it("disconnectBot=true が UPSERT(onConflictDoUpdate) + DELETE を正しい条件で実行する", async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: "streamer123", channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null }] }],
      inserts: [{ rows: [] }],
      deletes: [{ rows: [] }],
    });
    primePgDb(pg);

    const { POST } = await loadRoute();
    const response = await POST(postRequest({ streamerId: "streamer123", disconnectBot: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(pg.insertCalls[0].table).toBe(streamerChatSenderSettingsTable);
    expect(pg.insertCalls[0].values).toEqual({
      streamer_id: "streamer123",
      sender_mode: "streamer",
      custom_bot_account_id: null,
    });
    expect(pg.insertCalls[0].onConflict).toEqual({
      target: streamerChatSenderSettingsTable.streamer_id,
      set: { sender_mode: "streamer", custom_bot_account_id: null },
    });
    expect(pg.deleteCalls[0].table).toBe(twitchBotAccountsTable);
    expect(pg.deleteCalls[0].where).toEqual(
      and(eq(twitchBotAccountsTable.streamer_id, "streamer123"), eq(twitchBotAccountsTable.owner_type, "streamer"))
    );
  });

  it("disconnectBot 失敗時は handleDatabaseError(500) を返す", async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: "streamer123", channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null }] }],
      inserts: [{ error: { code: "08006", message: "connection failure" } }],
    });
    primePgDb(pg);

    const { POST } = await loadRoute();
    const response = await POST(postRequest({ streamerId: "streamer123", disconnectBot: true }));
    expect(response.status).toBe(500);
  });

  it("card_pack_names列欠落の所有権SELECTフォールバックが正しい列セットで再試行される", async () => {
    let selectCall = 0;
    const db = {
      select: vi.fn((fields: Record<string, unknown>) => {
        selectCall += 1;
        const thisCall = selectCall;
        const builder: any = {
          from: vi.fn(() => builder),
          where: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) => {
            if (thisCall === 1) {
              return Promise.reject({
                code: "42703",
                message: "column streamers.card_pack_names does not exist",
              }).then(onFulfilled, onRejected);
            }
            // 2回目は card_pack_names / pack_rarity_weights を落とした列セット
            expect(Object.keys(fields).sort()).toEqual(["channel_point_collection_name", "id"].sort());
            return Promise.resolve([{ id: "streamer123", channel_point_collection_name: null }]).then(onFulfilled, onRejected);
          },
        };
        return builder;
      }),
      update: vi.fn(() => {
        const builder: any = {
          set: vi.fn(() => builder),
          where: vi.fn(() => builder),
          then: (onFulfilled: any, onRejected: any) => Promise.resolve([]).then(onFulfilled, onRejected),
        };
        return builder;
      }),
    };
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const { POST } = await loadRoute();
    const response = await POST(postRequest({ streamerId: "streamer123", channelPointRewardId: "reward-1" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
