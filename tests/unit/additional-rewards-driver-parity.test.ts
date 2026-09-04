/**
 * #663: 追加ガチャ報酬APIのPlanetScale契約テスト
 *
 * 対象: GET/POST/PUT/DELETE /api/streamer/additional-rewards
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { getDb } from "@/lib/db/client";
import { streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable } from "@/lib/db/schema";
import { ERROR_MESSAGES } from "@/lib/constants";

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
  config: { selects?: PgResponse[]; inserts?: PgResponse[]; deletes?: PgResponse[]; updates?: PgResponse[] } = {}
) {
  let selectIndex = 0;
  let insertIndex = 0;
  let deleteIndex = 0;
  let updateIndex = 0;
  const selectCalls: Array<{ where?: unknown; orderBy?: unknown }> = [];
  const insertCalls: Array<{ table: unknown; values?: unknown }> = [];
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = [];
  const updateCalls: Array<{ table: unknown; values?: unknown; where?: unknown }> = [];

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
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{}] }];
      const response = responses[Math.min(updateIndex, responses.length - 1)];
      updateIndex += 1;
      const call: { table: unknown; values?: unknown; where?: unknown } = { table };
      updateCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [{}]));
      const builder: any = {
        set: vi.fn((values: unknown) => {
          call.values = values;
          return builder;
        }),
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
  return { db, selectCalls, insertCalls, deleteCalls, updateCalls };
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

describe("streamer/additional-rewards: PlanetScale契約 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 } as any);
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
    mockValidateContentType.mockReturnValue(null);
  });

  describe("GET", () => {
    it("報酬一覧を返し、streamer_idで絞り込む", async () => {
      const REWARD_ROW = {
        id: "reward-1",
        reward_id: "extra-1",
        reward_name: "Extra",
        draw_count: 3,
        is_raid_limited: true,
        collection_name: "weapons",
        created_at: "2026-01-01T00:00:00.000Z",
      };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1" }] }, { rows: [REWARD_ROW] }],
      });
      primePgDb(pg);
      const { GET: pgGET } = await loadRoute();
      const pgResponse = await pgGET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(200);
      expect(pgBody).toEqual([REWARD_ROW]);
      expect(getDb).toHaveBeenCalled();
      expect(pg.selectCalls[1].where).toEqual(eq(streamerAdditionalGachaRewardsTable.streamer_id, "streamer-1"));
    });

    it("streamerが見つからなければ404", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/streamer/additional-rewards"));
      expect(response.status).toBe(404);
    });

    it("collection_name列欠落 → raid列欠落の2段カスケードで最小列セットにフォールバックする", async () => {
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

    // 2026-07 Fable厳格レビュー指摘(中3)の回帰テスト: listAdditionalRewardsPg も
    // insertAdditionalRewardPg と同じ isRaidOptionsSchemaErrorPg を使う。
    // Drizzle にラップされた形状でも列欠落フォールバックが働くこと、かつ
    // SQL 文に列名が偶然写っているだけの無関係なエラー（接続断等）では
    // 誤って最小列セットへ縮退しないことの両方を検証する。
    it("raid列欠落(Drizzleラップ形状)でも最小列セットにフォールバックする", async () => {
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
                return Promise.resolve([{ id: "streamer-1" }]).then(onFulfilled, onRejected);
              }
              if (thisCall === 2) {
                // full select (id/.../collection_name): draw_count 列欠落を
                // Drizzle ラップ形状（{ query, params, cause }）で再現。
                const wrapped = Object.assign(
                  new Error('Failed query: select "id", "draw_count", "is_raid_limited", "collection_name", ... from "streamer_additional_gacha_rewards" where ...'),
                  {
                    query: 'select "id", "draw_count", ... from "streamer_additional_gacha_rewards" where ...',
                    params: [],
                    cause: Object.assign(
                      new Error('column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist'),
                      { code: "42703" }
                    ),
                  }
                );
                return Promise.reject(wrapped).then(onFulfilled, onRejected);
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

    it("接続断エラー（SQL文にdraw_countを含む）は最小列セットへ誤って縮退せずそのまま500になる", async () => {
      let selectCall = 0;
      const db = {
        select: vi.fn(() => {
          selectCall += 1;
          const thisCall = selectCall;
          const builder: any = {
            from: vi.fn(() => builder),
            where: vi.fn(() => builder),
            orderBy: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            then: (onFulfilled: any, onRejected: any) => {
              if (thisCall === 1) {
                return Promise.resolve([{ id: "streamer-1" }]).then(onFulfilled, onRejected);
              }
              // SQL文には draw_count が含まれるが、原因は無関係な接続断
              // (cause.code = CONNECTION_CLOSED)。42703 かつ列名一致を要求する
              // isRaidOptionsSchemaErrorPg は false を返すべき。
              const wrapped = Object.assign(
                new Error('Failed query: select "id", "draw_count", "is_raid_limited", "collection_name", ... from "streamer_additional_gacha_rewards" where ...'),
                {
                  query: 'select "id", "draw_count", ... from "streamer_additional_gacha_rewards" where ...',
                  params: [],
                  cause: Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" }),
                }
              );
              return Promise.reject(wrapped).then(onFulfilled, onRejected);
            },
          };
          return builder;
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/streamer/additional-rewards"));

      expect(response.status).toBe(500);
    });
  });

  describe("POST", () => {
    it("所有権確認後に正しいテーブルと値でINSERTする", async () => {
      const OWNED_STREAMER = { id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] as string[] };
      const NEW_REWARD = { id: "additional-1", reward_id: "22222222-2222-2222-2222-222222222222", reward_name: "Extra", draw_count: 5, is_raid_limited: false };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNED_STREAMER] }],
        inserts: [{ rows: [NEW_REWARD] }],
      });
      primePgDb(pg);
      const { POST: pgPOST } = await loadRoute();
      const pgResponse = await pgPOST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "22222222-2222-2222-2222-222222222222",
          rewardName: "Extra",
          drawCount: 5,
        })
      );
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(200);
      expect(pgBody).toEqual(expect.objectContaining({ success: true, reward: NEW_REWARD }));
      expect(getDb).toHaveBeenCalled();
      expect(pg.insertCalls[0].table).toBe(streamerAdditionalGachaRewardsTable);
      expect(pg.insertCalls[0].values).toEqual(
        expect.objectContaining({ streamer_id: "streamer-1", reward_id: "22222222-2222-2222-2222-222222222222", draw_count: 5, is_raid_limited: false })
      );
    });

    // 現行 postgres.js/Drizzle が返す SQLSTATE 42703 を使い、
    // isRaidOptionsSchemaErrorPg の本番エラー契約を直接検証する。
    it("raid列欠落エラー(42703)なら503", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: { code: "42703", message: 'column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist' } }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "22222222-2222-2222-2222-222222222222",
          drawCount: 10,
          isRaidLimited: true,
        })
      );

      expect(response.status).toBe(503);
    });

    // 2026-07 Fable厳格レビュー指摘(高1相当バグの高2/中3ファミリー)の回帰テスト:
    // Drizzle にラップされた形状（{ query, params, cause }）でも同じ 503 判定が
    // 働くことを検証する。
    it("raid列欠落エラー(Drizzleラップ形状)でも503", async () => {
      const wrapped42703 = Object.assign(
        new Error('Failed query: insert into streamer_additional_gacha_rewards ("streamer_id", "draw_count", "is_raid_limited", ...) values (...)'),
        {
          query: 'insert into streamer_additional_gacha_rewards (...) values (...)',
          params: [],
          cause: Object.assign(
            new Error('column "draw_count" of relation "streamer_additional_gacha_rewards" does not exist'),
            { code: "42703" }
          ),
        }
      );
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: wrapped42703 }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "22222222-2222-2222-2222-222222222222",
          drawCount: 10,
          isRaidLimited: true,
        })
      );

      expect(response.status).toBe(503);
    });

    // 2026-07 Fable厳格レビュー指摘(中3)の過剰マッチ回避テスト: DrizzleQueryError
    // の message は「実行された SQL 文そのもの」であり、この INSERT 文には常に
    // "draw_count" が列名として含まれる。cause が接続断など全く無関係な理由
    // でも、SQL 文に列名が写っているだけで raid-options-unavailable(503)へ
    // 誤って縮退してはならない（isRaidOptionsSchemaErrorPg は 42703 かつ
    // 該当列名を要求するため、接続断コードでは false になる）。
    it("接続断エラー（SQL文にdraw_countを含む）は503に誤判定されず素通しでエラーになる", async () => {
      const wrappedConnectionError = Object.assign(
        new Error('Failed query: insert into streamer_additional_gacha_rewards ("streamer_id", "draw_count", "is_raid_limited", ...) values (...)'),
        {
          query: 'insert into streamer_additional_gacha_rewards (...) values (...)',
          params: [],
          cause: Object.assign(new Error('connection closed'), { code: "CONNECTION_CLOSED" }),
        }
      );
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: wrappedConnectionError }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "22222222-2222-2222-2222-222222222222",
          drawCount: 10,
          isRaidLimited: true,
        })
      );

      // 503（raid-options-unavailable）ではなく、{ kind: "error" } → handleDatabaseError
      // の500になること。
      expect(response.status).toBe(500);
    });

    it("一意制約違反(23505)なら409", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: { code: "23505", message: "duplicate key value" } }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", { rewardId: "22222222-2222-2222-2222-222222222222" })
      );

      expect(response.status).toBe(409);
    });

    // 2026-07 Fable厳格レビュー指摘(高2)の回帰テスト: classifyError が以前は
    // トップレベルの code だけを見ていたため、Drizzle にラップされた 23505 は
    // 常に conflict 判定に失敗し 500 になっていた。
    it("一意制約違反(23505、Drizzleラップ形状)でも409", async () => {
      const wrapped23505 = Object.assign(new Error("Failed query: insert into streamer_additional_gacha_rewards ..."), {
        query: "insert into streamer_additional_gacha_rewards ...",
        params: [],
        cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
      });
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] }],
        inserts: [{ error: wrapped23505 }],
      });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", { rewardId: "22222222-2222-2222-2222-222222222222" })
      );

      expect(response.status).toBe(409);
    });

    it("card_pack_names列欠落時は報酬作成を続行しパック紐付けのみ見送る（collectionNameSkippedDeployWindow）", async () => {
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
              Promise.resolve([{ id: "additional-1", reward_id: "22222222-2222-2222-2222-222222222222", collection_name: null }]).then(onFulfilled, onRejected),
          };
          return builder;
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const { POST } = await loadRoute();
      const response = await POST(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "POST", {
          rewardId: "22222222-2222-2222-2222-222222222222",
          rewardName: "Weapons",
          collectionName: "weapons",
        })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.collectionNameSkippedDeployWindow).toBe(true);
      expect(db.insert).toHaveBeenCalled();
    });

  });

  describe("PUT", () => {
    const REWARD_ID = "33333333-3333-3333-3333-333333333333";

    it("所有権確認後に正しいテーブル・条件・値でUPDATEする", async () => {
      const OWNED_STREAMER = { id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: ["weapons", "characters"] };
      const UPDATED_REWARD = { id: "additional-1", reward_id: REWARD_ID, collection_name: "characters", draw_count: 5 };

      const pg = createDrizzleDbMock({
        selects: [
          { rows: [OWNED_STREAMER] },
          { rows: [{ id: "additional-1", collection_name: "weapons" }] },
          { rows: [{ count: 2 }] }, // checkCollectionHasActiveCards（値が変わるため）
        ],
        updates: [{ rows: [UPDATED_REWARD] }],
      });
      primePgDb(pg);
      const { PUT: pgPUT } = await loadRoute();
      const pgResponse = await pgPUT(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "PUT", {
          rewardId: REWARD_ID,
          collectionName: "characters",
          drawCount: 5,
        })
      );
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(200);
      expect(pgBody).toEqual(expect.objectContaining({ success: true, reward: UPDATED_REWARD }));
      expect(getDb).toHaveBeenCalled();
      expect(pg.updateCalls[0].table).toBe(streamerAdditionalGachaRewardsTable);
      expect(pg.updateCalls[0].values).toEqual(
        expect.objectContaining({ collection_name: "characters", draw_count: 5 })
      );
      expect(pg.updateCalls[0].where).toEqual(
        and(
          eq(streamerAdditionalGachaRewardsTable.streamer_id, "streamer-1"),
          eq(streamerAdditionalGachaRewardsTable.reward_id, REWARD_ID)
        )
      );
    });

    // 必須レビュー指摘の回帰テスト: collection_name 列未デプロイ窓で
    // collectionName のみの更新を送ると、ストリップ後に空 payload になり
    // Drizzle の空 SET が throw する。no-op へ分岐して 500 にしない。
    it("collection_name列欠落時、パック変更のみの更新はno-opになり500にならずフラグを返す", async () => {
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: ["weapons", "characters"] }] },
          { rows: [{ id: "additional-1", collection_name: "weapons" }] },
          { rows: [{ count: 2 }] },
        ],
        updates: [{
          error: {
            code: "42703",
            message: 'column "collection_name" of relation "streamer_additional_gacha_rewards" does not exist',
          },
        }],
      });
      primePgDb(pg);

      const { PUT } = await loadRoute();
      const response = await PUT(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "PUT", {
          rewardId: REWARD_ID,
          collectionName: "characters",
        })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({ success: true, collectionNameSkippedDeployWindow: true })
      );
      // ストリップ後の再試行は空 payload になるため DB を呼ばない（1回目のみ）
      expect(pg.updateCalls).toHaveLength(1);
    });

    it("変更なしのリクエストはunchangedを返しUPDATEしない", async () => {
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [{ id: "streamer-1", channel_point_reward_id: "main-reward", card_pack_names: [] }] },
          { rows: [{ id: "additional-1", collection_name: "weapons" }] },
        ],
      });
      primePgDb(pg);

      const { PUT } = await loadRoute();
      const response = await PUT(
        jsonRequest("http://localhost/api/streamer/additional-rewards", "PUT", { rewardId: REWARD_ID })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ success: true, unchanged: true }));
      expect(pg.updateCalls).toHaveLength(0);
    });
  });

  describe("DELETE", () => {
    it("deleteAll=true が正しいテーブル/条件で実行され、互換レスポンスのdeletedCountはnullを返す", async () => {
      // 公開APIの既存契約は削除件数を数えず null を返す。移行だけでクライアント
      // 応答を変えないため、Drizzle の returning 行数は内部検証にのみ利用する。
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

    it("rewardId指定の単一削除が正しい条件で実行される", async () => {
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

    it("streamerが見つからなければ404", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest("http://localhost/api/streamer/additional-rewards?deleteAll=true", { method: "DELETE" })
      );
      expect(response.status).toBe(404);
    });

    it("CSRF検証が無効な場合は403を返し、レートリミット/セッション取得/DB削除にも到達しない (#736)", async () => {
      mockValidateCSRFToken.mockResolvedValue({ valid: false, error: "bad csrf" } as any);
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: "streamer-1" }] }] });
      primePgDb(pg);

      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest("http://localhost/api/streamer/additional-rewards?deleteAll=true", { method: "DELETE" })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.FORBIDDEN });
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(pg.deleteCalls).toHaveLength(0);
    });

  });
});
