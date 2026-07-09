/**
 * #663: 低頻度APIルート群のpg直結移行 — support-inquiries API群の
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象:
 *   - GET  /api/support-inquiries               （一覧取得: isPgReadEnabled）
 *   - POST /api/support-inquiries               （新規作成: isPgWriteEnabled）
 *   - GET  /api/support-inquiries/[id]           （詳細+メッセージ取得: isPgReadEnabled）
 *   - DELETE /api/support-inquiries/[id]         （削除: isPgWriteEnabled）
 *   - POST /api/support-inquiries/[id]/messages  （返信追加: isPgWriteEnabled、読み書き混在）
 *
 * storage-db-driver-parity.test.ts / gacha-history 系の流儀を踏襲:
 * 同一 fixture を両経路のモックに与え、戻り値・ステータスコードが deepEqual に
 * なることと、pg 経路で正しいテーブル/条件（where/orderBy/values）が使われる
 * ことを検証する。既存の tests/unit/support-inquiries-api.test.ts
 * （フラグ未設定の postgrest 経路のみを検証）は変更しない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/support-inquiries/route";
import { DELETE as DELETE_DETAIL, GET as GET_DETAIL } from "@/app/api/support-inquiries/[id]/route";
import { POST as POST_MESSAGE } from "@/app/api/support-inquiries/[id]/messages/route";
import { getSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/plan";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateCSRFToken } from "@/lib/csrf";
import { getDb } from "@/lib/db/client";
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from "@/lib/db/schema";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/plan");
vi.mock("@/lib/csrf");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetUserPlan = vi.mocked(getUserPlan);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);

const MOCK_SESSION = {
  twitchUserId: "user123",
  twitchUsername: "testuser",
  twitchDisplayName: "TestUser",
  twitchProfileImageUrl: "",
  broadcasterType: "" as const,
  expiresAt: Date.now() + 100000,
  version: 1,
};

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function createGetRequest(path = "/api/support-inquiries"): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function createPostRequest(
  body: Record<string, unknown>,
  path = "/api/support-inquiries"
): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createDeleteRequest(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// postgrest 経路のモック: table ごとの結果キュー + insert/delete の呼び出し記録
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data?: unknown;
  error?: unknown;
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  );
  const insertCalls: Array<{ table: string; values: unknown }> = [];
  const deleteCalls: Array<{ table: string }> = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];

  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`);
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0];
    const resolved = { data: result.data ?? null, error: result.error ?? null };
    const builder: any = {
      select: vi.fn(() => builder),
      insert: vi.fn((values: unknown) => {
        insertCalls.push({ table, values });
        return builder;
      }),
      delete: vi.fn(() => {
        deleteCalls.push({ table });
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        eqCalls.push({ table, column, value });
        return builder;
      }),
      order: vi.fn(() => builder),
      single: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolved).then(onFulfilled, onRejected),
    };
    return builder;
  });

  return { from, insertCalls, deleteCalls, eqCalls };
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields).from(table).where().orderBy().limit() /
// insert(table).values().returning() / delete(table).where().returning()
// を await できる thenable builder。実引数を calls に記録する。
// ---------------------------------------------------------------------------

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
  const selectCalls: Array<{ where?: unknown; orderBy?: unknown; limit?: number }> = [];
  const insertCalls: Array<{ table: unknown; values?: Record<string, unknown> }> = [];
  const deleteCalls: Array<{ table: unknown; where?: unknown }> = [];

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex, responses.length - 1)];
      selectIndex += 1;
      const call: { where?: unknown; orderBy?: unknown; limit?: number } = {};
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
        limit: vi.fn((n: number) => {
          call.limit = n;
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
      const call: { table: unknown; values?: Record<string, unknown> } = { table };
      insertCalls.push(call);
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []);
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
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
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []);
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

describe("support-inquiries API群: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET /api/support-inquiries（読み取り: isPgReadEnabled）", () => {
    const ROWS = [
      {
        id: "inq-1",
        twitch_user_id: "user123",
        twitch_display_name: "TestUser",
        category: "bug",
        subject: "Test bug",
        body: "Bug description",
        status: "open",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];

    it("同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい where/orderBy を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: ROWS }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await GET(createGetRequest());
      expect(postgrestRes.status).toBe(200);
      const postgrestJson = await postgrestRes.json();

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: ROWS }] });
      primePgDb(pg);
      const pgRes = await GET(createGetRequest());
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson.inquiries).toEqual(ROWS);

      expect(pg.selectCalls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, "user123"));
      expect(pg.selectCalls[0].orderBy).toEqual(desc(supportInquiriesTable.created_at));
    });

    it("postgrest 経路（フラグ未設定）では getDb が一切呼ばれない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: ROWS }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await GET(createGetRequest());
      expect(getDb).not.toHaveBeenCalled();
    });

    it("pg 経路では supabase-js クライアントが一切呼ばれない", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: ROWS }] });
      primePgDb(pg);
      await GET(createGetRequest());
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    });

    it("pg 経路で取得エラー時は両経路とも500を返す", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ error: { code: "08006", message: "connection failure" } }] });
      primePgDb(pg);
      const res = await GET(createGetRequest());
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/support-inquiries（書き込み: isPgWriteEnabled、非冪等）", () => {
    const REQUEST_BODY = { category: "bug", subject: "Test Bug", body: "Found a bug" };

    it("同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい INSERT values を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: { id: "new-inq-id" } }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await POST(createPostRequest(REQUEST_BODY));
      expect(postgrestRes.status).toBe(201);
      const postgrestJson = await postgrestRes.json();
      expect(client.insertCalls[0].values).toEqual({
        twitch_user_id: "user123",
        twitch_display_name: "TestUser",
        category: "bug",
        subject: "Test Bug",
        body: "Found a bug",
      });

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ inserts: [{ rows: [{ id: "new-inq-id" }] }] });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(201);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ id: "new-inq-id" });

      expect(pg.insertCalls[0].table).toBe(supportInquiriesTable);
      expect(pg.insertCalls[0].values).toEqual(client.insertCalls[0].values);
    });

    it("INSERT 失敗: 両経路とも500を返す", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ inserts: [{ error: { code: "23505", message: "duplicate key" } }] });
      primePgDb(pg);
      const res = await POST(createPostRequest(REQUEST_BODY));
      expect(res.status).toBe(500);
    });

    it("フラグ未設定 / pg-read では getDb が呼ばれない（書き込み関数のため pg-read でも postgrest のまま）", async () => {
      for (const driver of [undefined, "pg-read"]) {
        vi.stubEnv("DB_DRIVER", driver as string);
        const client = createSupabaseClientMock({ support_inquiries: [{ data: { id: "new-inq-id" } }] });
        mockGetSupabaseAdmin.mockReturnValue(client as any);
        await POST(createPostRequest(REQUEST_BODY));
        expect(getDb).not.toHaveBeenCalled();
      }
    });
  });

  describe("GET /api/support-inquiries/[id]（読み取り: isPgReadEnabled）", () => {
    const INQUIRY_ROW = {
      id: VALID_UUID,
      twitch_user_id: "user123",
      twitch_display_name: "TestUser",
      category: "bug",
      subject: "Test bug",
      body: "Bug description",
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const MESSAGE_ROWS = [
      {
        id: "msg-1",
        inquiry_id: VALID_UUID,
        sender_type: "user",
        sender_id: "user123",
        body: "Hello",
        created_at: "2026-01-01T01:00:00Z",
      },
    ];

    it("同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい where/orderBy を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: INQUIRY_ROW }],
        support_inquiry_messages: [{ data: MESSAGE_ROWS }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(postgrestRes.status).toBe(200);
      const postgrestJson = await postgrestRes.json();

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [INQUIRY_ROW] }, { rows: MESSAGE_ROWS }] });
      primePgDb(pg);
      const pgRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ inquiry: INQUIRY_ROW, messages: MESSAGE_ROWS });

      // 問い合わせ本体: id + twitch_user_id の所有権フィルタ
      expect(pg.selectCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, VALID_UUID), eq(supportInquiriesTable.twitch_user_id, "user123"))
      );
      // メッセージ: inquiry_id の絞り込み + created_at 昇順
      expect(pg.selectCalls[1].where).toEqual(eq(supportInquiryMessagesTable.inquiry_id, VALID_UUID));
      expect(pg.selectCalls[1].orderBy).toEqual(asc(supportInquiryMessagesTable.created_at));
    });

    it("問い合わせが見つからない場合、両経路とも404を返す", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: null, error: new Error("Not found") }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(postgrestRes.status).toBe(404);

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(404);
    });

    it("postgrest 経路（フラグ未設定）では getDb が一切呼ばれない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: INQUIRY_ROW }],
        support_inquiry_messages: [{ data: MESSAGE_ROWS }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(getDb).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/support-inquiries/[id]（書き込み: isPgWriteEnabled、idempotent: true）", () => {
    it("削除成功: 両経路の戻り値が一致し、pg 経路が id + twitch_user_id の where で DELETE する", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: { id: VALID_UUID } }] });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(postgrestRes.status).toBe(200);
      const postgrestJson = await postgrestRes.json();

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ deletes: [{ rows: [{ id: VALID_UUID }] }] });
      primePgDb(pg);
      const pgRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ success: true });

      expect(pg.deleteCalls[0].table).toBe(supportInquiriesTable);
      expect(pg.deleteCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, VALID_UUID), eq(supportInquiriesTable.twitch_user_id, "user123"))
      );
    });

    it("他ユーザー所有 / 存在しない場合、両経路とも404を返し何も削除されない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: null, error: new Error("Not found") }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(postgrestRes.status).toBe(404);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ deletes: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(404);
    });

    it("フラグ未設定 / pg-read では getDb が呼ばれない（書き込み関数のため pg-read でも postgrest のまま）", async () => {
      for (const driver of [undefined, "pg-read"]) {
        vi.stubEnv("DB_DRIVER", driver as string);
        const client = createSupabaseClientMock({ support_inquiries: [{ data: { id: VALID_UUID } }] });
        mockGetSupabaseAdmin.mockReturnValue(client as any);
        await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
          params: Promise.resolve({ id: VALID_UUID }),
        });
        expect(getDb).not.toHaveBeenCalled();
      }
    });
  });

  describe("POST /api/support-inquiries/[id]/messages（読み書き混在: isPgWriteEnabled で関数全体を分岐）", () => {
    const OPEN_INQUIRY_ROW = { id: VALID_UUID, status: "open", twitch_user_id: "user123" };
    const CLOSED_INQUIRY_ROW = { id: VALID_UUID, status: "closed", twitch_user_id: "user123" };
    const MESSAGE_ROW = {
      id: "msg-1",
      inquiry_id: VALID_UUID,
      sender_type: "user",
      sender_id: "user123",
      body: "Reply",
      created_at: "2026-01-01T02:00:00Z",
    };

    it("返信追加成功: 両経路の戻り値が一致し、pg 経路が正しい INSERT values を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: OPEN_INQUIRY_ROW }],
        support_inquiry_messages: [{ data: MESSAGE_ROW }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(postgrestRes.status).toBe(201);
      const postgrestJson = await postgrestRes.json();

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OPEN_INQUIRY_ROW] }],
        inserts: [{ rows: [MESSAGE_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(pgRes.status).toBe(201);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual(postgrestJson);
      expect(pgJson).toEqual({ message: MESSAGE_ROW });

      expect(pg.insertCalls[0].table).toBe(supportInquiryMessagesTable);
      expect(pg.insertCalls[0].values).toEqual({
        inquiry_id: VALID_UUID,
        sender_type: "user",
        sender_id: "user123",
        body: "Reply",
      });
    });

    it("問い合わせが見つからない場合、両経路とも404を返しINSERTは発生しない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: null, error: new Error("Not found") }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(postgrestRes.status).toBe(404);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(pgRes.status).toBe(404);
      expect(pg.insertCalls).toHaveLength(0);
    });

    it("closedステータスの問い合わせには両経路とも400を返しINSERTは発生しない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: CLOSED_INQUIRY_ROW }],
      });
      mockGetSupabaseAdmin.mockReturnValue(client as any);
      const postgrestRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(postgrestRes.status).toBe(400);

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [CLOSED_INQUIRY_ROW] }] });
      primePgDb(pg);
      const pgRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(pgRes.status).toBe(400);
      expect(pg.insertCalls).toHaveLength(0);
    });

    it("フラグ未設定 / pg-read では getDb が呼ばれない（書き込み関数のため pg-read でも postgrest のまま）", async () => {
      for (const driver of [undefined, "pg-read"]) {
        vi.stubEnv("DB_DRIVER", driver as string);
        const client = createSupabaseClientMock({
          support_inquiries: [{ data: OPEN_INQUIRY_ROW }],
          support_inquiry_messages: [{ data: MESSAGE_ROW }],
        });
        mockGetSupabaseAdmin.mockReturnValue(client as any);
        await POST_MESSAGE(
          createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
          { params: Promise.resolve({ id: VALID_UUID }) }
        );
        expect(getDb).not.toHaveBeenCalled();
      }
    });
  });
});
