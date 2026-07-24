/**
 * #663: 低頻度APIルート群のPlanetScale直結移行 — support-inquiries API群
 *
 * 対象:
 *   - GET  /api/support-inquiries               （一覧取得）
 *   - POST /api/support-inquiries               （新規作成）
 *   - GET  /api/support-inquiries/[id]           （詳細+メッセージ取得）
 *   - DELETE /api/support-inquiries/[id]         （削除）
 *   - POST /api/support-inquiries/[id]/messages  （返信追加、読み書き混在）
 *
 * 旧 PostgREST 経路は廃止済みのため、現行 Drizzle 実装が正しいテーブル・
 * 所有権条件・並び順・書き込み値を使うことを API 境界で検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/support-inquiries/route";
import { DELETE as DELETE_DETAIL, GET as GET_DETAIL } from "@/app/api/support-inquiries/[id]/route";
import { POST as POST_MESSAGE } from "@/app/api/support-inquiries/[id]/messages/route";
import { getSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/plan";
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
// PlanetScale 経路のモック: select(fields).from(table).where().orderBy().limit() /
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

describe("support-inquiries API群: PlanetScale契約 (#663)", () => {
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

  describe("GET /api/support-inquiries", () => {
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

    it("一覧を返し、所有者と作成日時降順で絞り込む", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: ROWS }] });
      primePgDb(pg);
      const pgRes = await GET(createGetRequest());
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson.inquiries).toEqual(ROWS);

      expect(pg.selectCalls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, "user123"));
      expect(pg.selectCalls[0].orderBy).toEqual(desc(supportInquiriesTable.created_at));
    });

    it("取得エラー時は500を返す", async () => {
      const pg = createDrizzleDbMock({ selects: [{ error: { code: "08006", message: "connection failure" } }] });
      primePgDb(pg);
      const res = await GET(createGetRequest());
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/support-inquiries", () => {
    const REQUEST_BODY = { category: "bug", subject: "Test Bug", body: "Found a bug" };

    it("作成結果を返し、セッション由来の所有者情報を含めてINSERTする", async () => {
      const pg = createDrizzleDbMock({ inserts: [{ rows: [{ id: "new-inq-id" }] }] });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(201);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual({ id: "new-inq-id" });

      expect(pg.insertCalls[0].table).toBe(supportInquiriesTable);
      expect(pg.insertCalls[0].values).toEqual({
        twitch_user_id: "user123",
        twitch_display_name: "TestUser",
        category: "bug",
        subject: "Test Bug",
        body: "Found a bug",
      });
    });

    it("INSERT 失敗時は500を返す", async () => {
      const pg = createDrizzleDbMock({ inserts: [{ error: { code: "23505", message: "duplicate key" } }] });
      primePgDb(pg);
      const res = await POST(createPostRequest(REQUEST_BODY));
      expect(res.status).toBe(500);
    });

  });

  describe("GET /api/support-inquiries/[id]", () => {
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

    it("詳細とメッセージを返し、所有権条件と時系列順を使う", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [INQUIRY_ROW] }, { rows: MESSAGE_ROWS }] });
      primePgDb(pg);
      const pgRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual({ inquiry: INQUIRY_ROW, messages: MESSAGE_ROWS });

      // 問い合わせ本体: id + twitch_user_id の所有権フィルタ
      expect(pg.selectCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, VALID_UUID), eq(supportInquiriesTable.twitch_user_id, "user123"))
      );
      // メッセージ: inquiry_id の絞り込み + created_at 昇順
      expect(pg.selectCalls[1].where).toEqual(eq(supportInquiryMessagesTable.inquiry_id, VALID_UUID));
      expect(pg.selectCalls[1].orderBy).toEqual(asc(supportInquiryMessagesTable.created_at));
    });

    it("問い合わせが見つからない場合は404を返す", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await GET_DETAIL(createGetRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(404);
    });

  });

  describe("DELETE /api/support-inquiries/[id]", () => {
    it("削除成功時は、idと所有者の両方を条件にDELETEする", async () => {
      const pg = createDrizzleDbMock({ deletes: [{ rows: [{ id: VALID_UUID }] }] });
      primePgDb(pg);
      const pgRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual({ success: true });

      expect(pg.deleteCalls[0].table).toBe(supportInquiriesTable);
      expect(pg.deleteCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, VALID_UUID), eq(supportInquiriesTable.twitch_user_id, "user123"))
      );
    });

    it("他ユーザー所有 / 存在しない場合は404を返す", async () => {
      const pg = createDrizzleDbMock({ deletes: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await DELETE_DETAIL(createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(pgRes.status).toBe(404);
    });

  });

  describe("POST /api/support-inquiries/[id]/messages", () => {
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

    it("返信追加成功時は、所有者確認後に正しい送信者情報でINSERTする", async () => {
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

      expect(pgJson).toEqual({ message: MESSAGE_ROW });

      expect(pg.insertCalls[0].table).toBe(supportInquiryMessagesTable);
      expect(pg.insertCalls[0].values).toEqual({
        inquiry_id: VALID_UUID,
        sender_type: "user",
        sender_id: "user123",
        body: "Reply",
      });
    });

    it("問い合わせが見つからない場合は404を返しINSERTしない", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(pgRes.status).toBe(404);
      expect(pg.insertCalls).toHaveLength(0);
    });

    it("closedステータスの問い合わせには400を返しINSERTしない", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [CLOSED_INQUIRY_ROW] }] });
      primePgDb(pg);
      const pgRes = await POST_MESSAGE(
        createPostRequest({ body: "Reply" }, `/api/support-inquiries/${VALID_UUID}/messages`),
        { params: Promise.resolve({ id: VALID_UUID }) }
      );
      expect(pgRes.status).toBe(400);
      expect(pg.insertCalls).toHaveLength(0);
    });

  });
});
