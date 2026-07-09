/**
 * #663: 低頻度APIルート群のpg直結移行 — PUT/DELETE /api/cards/[id] の
 * postgrest経路 / pg経路パリティテスト
 *
 * support-inquiries-routes-driver-parity.test.ts / storage-db-driver-parity.test.ts
 * と同じ流儀: 同一 fixture を両経路のモックに与え、戻り値・ステータスコードが
 * deepEqual になることと、pg 経路で正しいテーブル/条件(values/where)が使われる
 * ことを検証する。既存の tests/unit/api/cards-collection-membership.test.ts
 * （postgrest 経路のみ検証）は変更しない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/cards/[id]/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db/client";
import { removeBlobFile } from "@/lib/storage-db";
import { CARDS_SAFE_COLUMNS } from "@/lib/db/cards-safe-columns";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/storage-db");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);
const mockRemoveBlobFile = vi.mocked(removeBlobFile);

const SESSION = {
  twitchUserId: "user1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: "",
  broadcasterType: "affiliate" as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
};

const CARD_ID = "card-1";

// ---------------------------------------------------------------------------
// postgrest 経路のモック: table ごとの結果キュー + insert/update/delete の呼び出し記録
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data?: unknown;
  error?: unknown;
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  );
  const updateCalls: Array<{ table: string; values: unknown }> = [];
  const deleteCalls: Array<{ table: string }> = [];

  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`);
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0];
    const resolved = { data: result.data ?? null, error: result.error ?? null };
    const builder: any = {
      select: vi.fn(() => builder),
      update: vi.fn((values: unknown) => {
        updateCalls.push({ table, values });
        return builder;
      }),
      delete: vi.fn(() => {
        deleteCalls.push({ table });
        return builder;
      }),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
    };
    return builder;
  });

  return { from, updateCalls, deleteCalls };
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields).from(table).innerJoin().where().limit() /
// update(table).set().where().returning() / delete(table).where().returning()
// を await できる thenable builder
// ---------------------------------------------------------------------------

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(
  config: { selects?: PgResponse[]; updates?: PgResponse[]; deletes?: PgResponse[] } = {}
) {
  let selectIndex = 0;
  let updateIndex = 0;
  let deleteIndex = 0;
  const selectCalls: Array<{ joins: Array<{ table: unknown; on: unknown }>; where?: unknown }> = [];
  const updateCalls: Array<{
    table: unknown;
    values?: Record<string, unknown>;
    where?: unknown;
    returningFields?: Record<string, unknown>;
  }> = [];
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex, responses.length - 1)];
      selectIndex += 1;
      const call: { joins: Array<{ table: unknown; on: unknown }>; where?: unknown } = { joins: [] };
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
        innerJoin: vi.fn((table: unknown, on: unknown) => {
          call.joins.push({ table, on });
          return builder;
        }),
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
      const call: {
        table: unknown;
        values?: Record<string, unknown>;
        where?: unknown;
        returningFields?: Record<string, unknown>;
      } = { table };
      updateCalls.push(call);
      const resolve = () => {
        if (response.error) return Promise.reject(response.error);
        const rows = response.rows ?? [];
        // self-review fix (#663): .returning(CARDS_SAFE_COLUMNS) のような明示列指定時は
        // fields のキーだけを持つ行にマップし、本番未デプロイ8列(hp/atk等)が実際に
        // 応答から除外されることをテストで検証できるようにする。
        const fields = call.returningFields;
        return Promise.resolve(
          fields ? rows.map((row) => Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))) : rows
        );
      };
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.values = values;
          return builder;
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition;
          return builder;
        }),
        returning: vi.fn((fields?: Record<string, unknown>) => {
          call.returningFields = fields;
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
        returning: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };

  return { db, selectCalls, updateCalls, deleteCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

function createPutRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/cards/${CARD_ID}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createDeleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/cards/${CARD_ID}`, { method: "DELETE" });
}

describe("PUT/DELETE /api/cards/[id]: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockRemoveBlobFile.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("PUT /api/cards/[id]（読み書き混在: isPgWriteEnabled で関数全体を分岐）", () => {
    // rarity_weights: null にして recalculateIfAutoMode を即 return null（DB非到達）にする
    //
    // postgrest 経路は streamers を「埋め込みオブジェクト」として返す
    // (card.streamers = {...}) のに対し、pg 経路は cards/streamers を
    // INNER JOIN したフラットな行を select し、ルート側の fetchCardForUpdatePg が
    // 同じネスト形状に再構成する。モックの fixture もそれぞれの形状に合わせる。
    const OWNERSHIP_ROW_POSTGREST = {
      streamer_id: "streamer-1",
      image_url: null,
      rarity: "common",
      is_active: true,
      intra_rarity_weight: 1,
      collection_name: null,
      streamers: { twitch_user_id: "user1", rarity_weights: null, card_pack_names: [] },
    };
    const OWNERSHIP_ROW_PG = {
      streamer_id: "streamer-1",
      image_url: null,
      rarity: "common",
      is_active: true,
      intra_rarity_weight: 1,
      collection_name: null,
      twitch_user_id: "user1",
      rarity_weights: null,
      card_pack_names: [],
    };
    const UPDATED_ROW = {
      id: CARD_ID,
      streamer_id: "streamer-1",
      name: "Renamed",
      description: null,
      image_url: null,
      rarity: "common",
      card_number: null,
      max_issuance_count: null,
      collection_name: null,
      drop_rate: 0.5,
      intra_rarity_weight: 1,
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };

    it("成功時: 同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい UPDATE values を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        cards: [{ data: OWNERSHIP_ROW_POSTGREST }, { data: UPDATED_ROW }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(postgrestRes.status).toBe(200);
      const postgrestJson = await postgrestRes.json();
      expect(client.updateCalls[0].values).toEqual({ name: "Renamed" });

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNERSHIP_ROW_PG] }],
        updates: [{ rows: [UPDATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ ...UPDATED_ROW, recalculatedCards: null });
      expect(pg.updateCalls[0].values).toEqual({ name: "Renamed" });
      expect(pg.selectCalls[0].joins).toHaveLength(1);
    });

    it("所有者不一致: 両経路とも403を返しUPDATEは発生しない", async () => {
      const otherOwnerRowPostgrest = {
        ...OWNERSHIP_ROW_POSTGREST,
        streamers: { ...OWNERSHIP_ROW_POSTGREST.streamers, twitch_user_id: "someone-else" },
      };
      const otherOwnerRowPg = { ...OWNERSHIP_ROW_PG, twitch_user_id: "someone-else" };

      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ cards: [{ data: otherOwnerRowPostgrest }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(postgrestRes.status).toBe(403);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [otherOwnerRowPg] }] });
      primePgDb(pg);
      const pgRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(pgRes.status).toBe(403);
      expect(pg.updateCalls).toHaveLength(0);
    });

    it("card_pack_names列デプロイ窓フォールバック: 両経路とも他フィールド編集は継続し200を返す", async () => {
      const missingColumnErrorPostgrest = {
        code: "42703",
        message: "column streamers.card_pack_names does not exist",
      };
      const missingColumnErrorPg = {
        code: "42703",
        message: "column streamers.card_pack_names does not exist",
      };
      const ownershipWithoutPackNamesPostgrest = {
        ...OWNERSHIP_ROW_POSTGREST,
        streamers: { twitch_user_id: "user1", rarity_weights: null },
      };
      const ownershipWithoutPackNamesPg = { ...OWNERSHIP_ROW_PG };
      delete (ownershipWithoutPackNamesPg as Record<string, unknown>).card_pack_names;

      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        cards: [
          { data: null, error: missingColumnErrorPostgrest },
          { data: ownershipWithoutPackNamesPostgrest },
          { data: UPDATED_ROW },
        ],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(postgrestRes.status).toBe(200);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ error: missingColumnErrorPg }, { rows: [ownershipWithoutPackNamesPg] }],
        updates: [{ rows: [UPDATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      const pgJson = await pgRes.json();

      expect(pgRes.status).toBe(200);
      expect(pgJson).toEqual({ ...UPDATED_ROW, recalculatedCards: null });
    });

    it("card_number列デプロイ窓フォールバック(UPDATE): 両経路とも列を落として再試行し200を返す", async () => {
      const missingColumnErrorPostgrest = {
        code: "PGRST204",
        message: "Could not find the 'card_number' column of 'cards' in the schema cache",
      };
      const missingColumnErrorPg = {
        code: "42703",
        message: 'column "card_number" of relation "cards" does not exist',
      };

      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        cards: [
          { data: OWNERSHIP_ROW_POSTGREST },
          { data: null, error: missingColumnErrorPostgrest },
          { data: UPDATED_ROW },
        ],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await PUT(createPutRequest({ name: "Renamed", cardNumber: 3 }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(postgrestRes.status).toBe(200);
      expect(client.updateCalls[1].values).not.toHaveProperty("card_number");

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNERSHIP_ROW_PG] }],
        updates: [{ error: missingColumnErrorPg }, { rows: [UPDATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await PUT(createPutRequest({ name: "Renamed", cardNumber: 3 }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(pgRes.status).toBe(200);
      expect(pg.updateCalls).toHaveLength(2);
      expect(pg.updateCalls[1].values).not.toHaveProperty("card_number");
    });

    // self-review fix (#663): 本番 cards テーブルには card_number/hp/atk/def/spd/
    // skill_type/skill_name/skill_power の8列が実在しない(Issue #625)。無指定
    // `.returning()` は schema.ts の静的列リストを生成するため、リクエストが
    // card_number/max_issuance_count/collection_name のどれも変更していない
    // （updateData に含まれない）場合でも、RETURNING 自体は無条件に全列を
    // 要求するため hp 等の欠落で失敗する。この末尾フォールバック(SAFE_COLUMNS
    // への切替)が正しく発動することを検証する。
    it("本番未デプロイ8列(hp等)RETURNINGフォールバック: card_number等を一切変更しないUPDATEでもRETURNING失敗時に明示列リストで再試行し200を返す", async () => {
      const missingHpErrorPg = {
        code: "42703",
        message: 'column "hp" of relation "cards" does not exist',
      };
      const UPDATED_ROW_SAFE = {
        id: CARD_ID,
        streamer_id: "streamer-1",
        name: "Renamed",
        description: null,
        image_url: null,
        rarity: "common",
        rarity_order: null,
        max_issuance_count: null,
        collection_name: null,
        drop_rate: 0.5,
        intra_rarity_weight: 1,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      };

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNERSHIP_ROW_PG] }],
        updates: [
          { error: missingHpErrorPg }, // attempt1: 無指定RETURNINGがhpで失敗（updateDataはcard_number等を含まない）
          { rows: [UPDATED_ROW_SAFE] }, // attempt2: SAFE_COLUMNSで再試行し成功
        ],
      });
      primePgDb(pg);
      // name のみ変更。card_number/max_issuance_count/collection_name は
      // リクエストに含めない = updateData に含まれない。
      const pgRes = await PUT(createPutRequest({ name: "Renamed" }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual({ ...UPDATED_ROW_SAFE, recalculatedCards: null });
      expect(pg.updateCalls).toHaveLength(2);
      expect(pg.updateCalls[1].returningFields).toEqual(CARDS_SAFE_COLUMNS);
      expect(Object.keys(pg.updateCalls[1].returningFields ?? {})).not.toContain("card_number");
      expect(Object.keys(pg.updateCalls[1].returningFields ?? {})).not.toContain("hp");
    });

    it("card_number一意制約違反(23505): 両経路とも409を返す", async () => {
      const conflictError = {
        code: "23505",
        message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
      };

      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        cards: [{ data: OWNERSHIP_ROW_POSTGREST }, { data: null, error: conflictError }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await PUT(createPutRequest({ cardNumber: 3 }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(postgrestRes.status).toBe(409);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNERSHIP_ROW_PG] }],
        updates: [{ error: conflictError }],
      });
      primePgDb(pg);
      const pgRes = await PUT(createPutRequest({ cardNumber: 3 }), {
        params: Promise.resolve({ id: CARD_ID }),
      });
      expect(pgRes.status).toBe(409);
    });

    it("フラグ未設定時は getDb が呼ばれない（挙動不変の検証）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        cards: [{ data: OWNERSHIP_ROW_POSTGREST }, { data: UPDATED_ROW }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await PUT(createPutRequest({ name: "Renamed" }), { params: Promise.resolve({ id: CARD_ID }) });
      expect(getDb).not.toHaveBeenCalled();
    });

    it("pg-read では書き込み関数のため postgrest のまま（getDb が呼ばれない）", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const client = createSupabaseClientMock({
        cards: [{ data: OWNERSHIP_ROW_POSTGREST }, { data: UPDATED_ROW }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await PUT(createPutRequest({ name: "Renamed" }), { params: Promise.resolve({ id: CARD_ID }) });
      expect(getDb).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/cards/[id]（読み書き混在: isPgWriteEnabled で関数全体を分岐、DELETEはidempotent: true）", () => {
    // postgrest 経路: streamers は埋め込みオブジェクト。pg 経路: cards/streamers を
    // INNER JOIN したフラットな行を select し、selectCardOwnershipForDeletePg が
    // 同じネスト形状に再構成する。
    const OWNERSHIP_ROW_POSTGREST = {
      streamer_id: "streamer-1",
      image_url: null,
      streamers: { twitch_user_id: "user1", rarity_weights: null },
    };
    const OWNERSHIP_ROW_PG = {
      streamer_id: "streamer-1",
      image_url: null,
      twitch_user_id: "user1",
      rarity_weights: null,
    };

    it("成功時: 同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が id で DELETE する", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ cards: [{ data: OWNERSHIP_ROW_POSTGREST }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(postgrestRes.status).toBe(200);
      const postgrestJson = await postgrestRes.json();

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNERSHIP_ROW_PG] }],
        deletes: [{ rows: [{ id: CARD_ID }] }],
      });
      primePgDb(pg);
      const pgRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ success: true, recalculatedCards: null });
      expect(pg.deleteCalls).toHaveLength(1);
      expect(pg.selectCalls[0].joins).toHaveLength(1);
    });

    it("所有者不一致: 両経路とも403を返しDELETEは発生しない", async () => {
      const otherOwnerRowPostgrest = {
        ...OWNERSHIP_ROW_POSTGREST,
        streamers: { ...OWNERSHIP_ROW_POSTGREST.streamers, twitch_user_id: "someone-else" },
      };
      const otherOwnerRowPg = { ...OWNERSHIP_ROW_PG, twitch_user_id: "someone-else" };

      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ cards: [{ data: otherOwnerRowPostgrest }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(postgrestRes.status).toBe(403);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [otherOwnerRowPg] }] });
      primePgDb(pg);
      const pgRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(pgRes.status).toBe(403);
      expect(pg.deleteCalls).toHaveLength(0);
    });

    it("対象カードが存在しない: 両経路とも403を返す", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ cards: [{ data: null }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(postgrestRes.status).toBe(403);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(pgRes.status).toBe(403);
    });

    it("フラグ未設定時は getDb が呼ばれない（挙動不変の検証）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ cards: [{ data: OWNERSHIP_ROW_POSTGREST }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(getDb).not.toHaveBeenCalled();
    });

    it("pg-read では書き込み関数のため postgrest のまま（getDb が呼ばれない）", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const client = createSupabaseClientMock({ cards: [{ data: OWNERSHIP_ROW_POSTGREST }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await DELETE(createDeleteRequest(), { params: Promise.resolve({ id: CARD_ID }) });
      expect(getDb).not.toHaveBeenCalled();
    });
  });
});
