/**
 * #663: 低頻度APIルート群のpg直結移行 — 追加ガチャ報酬APIの
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象: GET/POST/DELETE /api/streamer/additional-rewards
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db/client";
import { streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable } from "@/lib/db/schema";
import { createMockQueryBuilder } from "../utils/supabase-mock";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);

const STREAMER_SESSION = {
  twitchUserId: "streamer-twitch-1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: null,
  broadcasterType: "affiliate",
  expiresAt: Date.now() + 60_000,
  version: 1,
};

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(
  config: { selects?: PgResponse[]; inserts?: PgResponse[]; deletes?: PgResponse[] } = {}
) {
  let selectIndex = 0;
  let insertIndex = 0;
  let deleteIndex = 0;
  const selectCalls: Array<{ where?: unknown; orderBy?: unknown }> = [];
  const insertCalls: Array<{ table: unknown; values?: unknown }> = [];
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex, responses.length - 1)];
      selectIndex += 1;
      const call: { where?: unknown; orderBy?: unknown } = {};
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
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition;
          return builder;
        }),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{}] }];
      const response = responses[Math.min(insertIndex, responses.length - 1)];
      insertIndex += 1;
      const call: { table: unknown; values?: unknown } = { table };
      insertCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [{}]));
      const builder: any = {
        values: vi.fn((values: unknown) => {
          call.values = values;
          return builder;
        }),
        returning: vi.fn(() => builder),
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
        returning: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  return { db, selectCalls, insertCalls, deleteCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function loadRoute() {
  return import("@/app/api/streamer/additional-rewards/route");
}

describe("streamer/additional-rewards: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 } as any);
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
    mockValidateContentType.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET", () => {
    it("フラグ未設定時は getDb が呼ばれない（挙動不変の検証）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const streamerQuery = createMockQueryBuilder();
      (streamerQuery.maybeSingle as any).mockResolvedValue({ data: { id: "streamer-1" }, error: null });
      const rewardsQuery = createMockQueryBuilder();
      (rewardsQuery as any).then = (resolve: (v: unknown) => void) => {
        resolve({ data: [], error: null });
        return rewardsQuery;
      };
      const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : rewardsQuery));
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as any);

      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/streamer/additional-rewards"));

      expect(response.status).toBe(200);
      expect(getDb).not.toHaveBeenCalled();
    });

    it("DB_DRIVER=pg-read: 同一fixtureで両経路の戻り値が一致する", async () => {
      const REWARD_ROW = {
        id: "reward-1",
        reward_id: "extra-1",
        reward_name: "Extra",
        draw_count: 3,
        is_raid_limited: true,
        collection_name: "weapons",
        created_at: "2026-01-01T00:00:00.000Z",
      };

      vi.stubEnv("DB_DRIVER", undefined);
      const streamerQuery = createMockQueryBuilder();
      (streamerQuery.maybeSingle as any).mockResolvedValue({ data: { id: "streamer-1" }, error: null });
      const rewardsQuery = createMockQueryBuilder();
      (rewardsQuery as any).then = (resolve: (v: unknown) => void) => {
        resolve({ data: [REWARD_ROW], error: null });
        return rewardsQuery;
      };
      const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : rewardsQuery));
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as any);
      const { GET: postgrestGET } = await loadRoute();
      const postgrestResponse = await postgrestGET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      const postgrestBody = await postgrestResponse.json();

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1" }] }, { rows: [REWARD_ROW] }],
      });
      primePgDb(pg);
      const { GET: pgGET } = await loadRoute();
      const pgResponse = await pgGET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(postgrestResponse.status);
      expect(pgBody).toEqual(postgrestBody);
      expect(getDb).toHaveBeenCalled();
      expect(pg.selectCalls[1].where).toEqual(eq(streamerAdditionalGachaRewardsTable.streamer_id, "streamer-1"));
    });

    it("DB_DRIVER=pg-read: streamerが見つからなければ両経路とも404", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      expect(response.status).toBe(404);
    });

    it("DB_DRIVER=pg-read: collection_name列欠落 → raid列欠落の2段カスケードで最小列セットにフォールバックする", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      let selectCall = 0;
      const db = {
        select: vi.fn((fields: Record<string, unknown>) => {
          selectCall += 1;
          const thisCall = selectCall;
          const builder: any = {
            from: vi.fn(() => builder),
            where: vi.fn(() => builder),
            orderBy: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            then: (onFulfilled: any, onRejected: any) => {
              if (thisCall === 1) {
                // ownership lookup
                return Promise.resolve([{ id: "streamer-1" }]).then(onFulfilled, onRejected);
              }
              if (thisCall === 2) {
                // full reward select: collection_name missing
                return Promise.reject({
                  code: "42703",
                  message: "column streamer_additional_gacha_rewards.collection_name does not exist",
                }).then(onFulfilled, onRejected);
              }
              if (thisCall === 3) {
                // without collection_name: draw_count / is_raid_limited missing
                return Promise.reject({
                  code: "42703",
                  message: "column streamer_additional_gacha_rewards.draw_count does not exist",
                }).then(onFulfilled, onRejected);
              }
              // minimal select
              return Promise.resolve([
                Object.fromEntries(
                  Object.keys(fields).map((k) => [
                    k,
                    ({ id: "reward-1", reward_id: "legacy", reward_name: "Legacy", created_at: "2026-01-01T00:00:00.000Z" } as any)[k] ?? null,
                  ])
                ),
              ]).then(onFulfilled, onRejected);
            },
          };
          return builder;
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({
          reward_id: "legacy",
          draw_count: 1,
          is_raid_limited: false,
          collection_name: null,
        }),
      ]);
    });
  });

  describe("POST", () => {
    it("DB_DRIVER=pg: 所有権確認 + INSERT が正しいテーブル/値で実行され、戻り値が postgrest 経路と一致する", async () => {
      const OWNED_STREAMER = { id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] as string[] };
      const NEW_REWARD = { id: "additional-1", reward_id: "extra-reward", reward_name: "Extra", draw_count: 5, is_raid_limited: false };

      vi.stubEnv("DB_DRIVER", undefined);
      const streamerQuery = createMockQueryBuilder();
      (streamerQuery.maybeSingle as any).mockResolvedValue({ data: OWNED_STREAMER, error: null });
      const insertQuery = createMockQueryBuilder();
      (insertQuery.maybeSingle as any).mockResolvedValue({ data: NEW_REWARD, error: null });
      const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : insertQuery));
      vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as any);
      const { POST: postgrestPOST } = await loadRoute();
      const postgrestResponse = await postgrestPOST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "extra-reward",
          rewardName: "Extra",
          drawCount: 5,
        })
      );
      const postgrestBody = await postgrestResponse.json();

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNED_STREAMER] }],
        inserts: [{ rows: [NEW_REWARD] }],
      });
      primePgDb(pg);
      const { POST: pgPOST } = await loadRoute();
      const pgResponse = await pgPOST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "extra-reward",
          rewardName: "Extra",
          drawCount: 5,
        })
      );
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(postgrestResponse.status);
      expect(pgBody).toEqual(postgrestBody);
      expect(getDb).toHaveBeenCalled();
      expect(pg.insertCalls[0].table).toBe(streamerAdditionalGachaRewardsTable);
      expect(pg.insertCalls[0].values).toEqual(
        expect.objectContaining({ streamer_id: "streamer-1", reward_id: "extra-reward", draw_count: 5, is_raid_limited: false })
      );
    });

    it("DB_DRIVER=pg: raid列欠落エラーなら両経路とも503", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: { code: "PGRST204", message: "Could not find the 'draw_count' column" } }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "extra-reward",
          drawCount: 10,
          isRaidLimited: true,
        })
      );

      expect(response.status).toBe(503);
    });

    it("DB_DRIVER=pg: 一意制約違反(23505)なら両経路とも409", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: { code: "23505", message: "duplicate key value" } }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", { rewardId: "extra-reward" })
      );

      expect(response.status).toBe(409);
    });

    it("DB_DRIVER=pg: card_pack_names列欠落時は報酬作成を続行しパック紐付けのみ見送る（collectionNameSkippedDeployWindow）", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
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
              return Promise.resolve([
                Object.fromEntries(
                  Object.keys(fields).map((k) => [k, ({ id: "streamer-1", channel_point_reward_id: "main-reward" } as any)[k] ?? null])
                ),
              ]).then(onFulfilled, onRejected);
            },
          };
          return builder;
        }),
        insert: vi.fn(() => {
          const builder: any = {
            values: vi.fn(() => builder),
            returning: vi.fn(() => builder),
            then: (onFulfilled: any, onRejected: any) =>
              Promise.resolve([{ id: "additional-1", reward_id: "extra-reward", collection_name: null }]).then(onFulfilled, onRejected),
          };
          return builder;
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "extra-reward",
          rewardName: "Weapons",
          collectionName: "weapons",
        })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.collectionNameSkippedDeployWindow).toBe(true);
      expect(db.insert).toHaveBeenCalled();
    });

    it("フラグ未設定 / pg-read では getDb が呼ばれない（POSTは書き込み関数のため isPgWriteEnabled のみで切替）", async () => {
      const OWNED_STREAMER = { id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] as string[] };
      for (const driver of [undefined, "pg-read"]) {
        vi.clearAllMocks();
        mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
        mockCanUseStreamerFeatures.mockReturnValue(true);
        mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 } as any);
        mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
        mockValidateContentType.mockReturnValue(null);

        vi.stubEnv("DB_DRIVER", driver as string);
        const streamerQuery = createMockQueryBuilder();
        (streamerQuery.maybeSingle as any).mockResolvedValue({ data: OWNED_STREAMER, error: null });
        const insertQuery = createMockQueryBuilder();
        (insertQuery.maybeSingle as any).mockResolvedValue({
          data: { id: "additional-1", reward_id: "extra-reward" },
          error: null,
        });
        const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : insertQuery));
        vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as any);

        const { POST } = await loadRoute();
        const response = await POST(
          jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", { rewardId: "extra-reward" })
        );
        expect(response.status).toBe(200);
        expect(getDb).not.toHaveBeenCalled();
      }
    });
  });

  describe("DELETE", () => {
    it("DB_DRIVER=pg: deleteAll=true が正しいテーブル/条件で実行され、deletedCountはpostgrest経路と同じnullを返す", async () => {
      // postgrest 経路は .delete().select() のみで { count: 'exact' } を要求しない
      // ため、本番でも response.count は常に null（node_modules/@supabase/
      // postgrest-js の PostgrestQueryBuilder.delete() で確認済み）。この
      // #663 移行は「経路の切替のみ」が目的で挙動改善はスコープ外のため、
      // pg 経路も deletedCount: null で揃える（実際の削除件数を返すよう
      // 「直した」場合、DB_DRIVER=pg 切替だけでレスポンスの値が変わってしまう）。
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1" }] }],
        deletes: [{ rows: [{ id: "r1" }, { id: "r2" }] }],
      });
      primePgDb(pg);

      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest("http://localhost/api/streamer/additional-rewards?deleteAll=true", { method: "DELETE" })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, deletedCount: null });
      expect(pg.deleteCalls[0].table).toBe(streamerAdditionalGachaRewardsTable);
      expect(pg.deleteCalls[0].where).toEqual(eq(streamerAdditionalGachaRewardsTable.streamer_id, "streamer-1"));
    });

    it("DB_DRIVER=pg: rewardId指定の単一削除が正しい条件で実行される", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1" }] }],
        deletes: [{ rows: [] }],
      });
      primePgDb(pg);

      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest("http://localhost/api/streamer/additional-rewards?rewardId=reward-9", { method: "DELETE" })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(pg.deleteCalls[0].where).toEqual(
        and(
          eq(streamerAdditionalGachaRewardsTable.streamer_id, "streamer-1"),
          eq(streamerAdditionalGachaRewardsTable.reward_id, "reward-9")
        )
      );
    });

    it("DB_DRIVER=pg: streamerが見つからなければ404", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest("http://localhost/api/streamer/additional-rewards?deleteAll=true", { method: "DELETE" })
      );
      expect(response.status).toBe(404);
    });

    it("フラグ未設定 / pg-read では getDb が呼ばれない（DELETEは読み書き混在のため isPgWriteEnabled のみで切替）", async () => {
      for (const driver of [undefined, "pg-read"]) {
        vi.clearAllMocks();
        mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
        mockCanUseStreamerFeatures.mockReturnValue(true);
        mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 } as any);

        vi.stubEnv("DB_DRIVER", driver as string);
        const streamerQuery = createMockQueryBuilder();
        (streamerQuery.maybeSingle as any).mockResolvedValue({ data: { id: "streamer-1" }, error: null });
        const deleteQuery = createMockQueryBuilder();
        const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : deleteQuery));
        vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as any);

        const { DELETE } = await loadRoute();
        const response = await DELETE(
          new NextRequest("http://localhost/api/streamer/additional-rewards?rewardId=r1", { method: "DELETE" })
        );
        expect(response.status).toBe(200);
        expect(getDb).not.toHaveBeenCalled();
      }
    });
  });
});
