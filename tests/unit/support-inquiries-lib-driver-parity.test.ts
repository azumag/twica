/**
 * #663: 低頻度APIルート群のpg直結移行 — src/lib/support-inquiries.ts の
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象:
 *   - getUserInquiries        （一覧取得: isPgReadEnabled）
 *   - getInquiryWithMessages  （詳細+メッセージ取得: isPgReadEnabled、
 *                                メッセージ取得だけの部分失敗を messages: [] にフォールバック）
 *
 * これらは src/app/api/support-inquiries/ 配下のルートハンドラとは独立した
 * データアクセス関数（ダッシュボードの Server Component から呼ばれる）。
 * クエリ形状はルート側の実装とほぼ同じだが、意図的に別実装として保守する方針
 * （brief 記載のとおり、共有ヘルパーへの統合はスコープ外）。
 *
 * announcements-driver-parity.test.ts / storage-db-driver-parity.test.ts の流儀を踏襲。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import { getUserInquiries, getInquiryWithMessages } from "@/lib/support-inquiries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db/client";
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from "@/lib/db/schema";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TWITCH_USER_ID = "user123";
const INQUIRY_ID = "550e8400-e29b-41d4-a716-446655440000";

const INQUIRY_ROWS = [
  {
    id: INQUIRY_ID,
    twitch_user_id: TWITCH_USER_ID,
    twitch_display_name: "TestUser",
    category: "bug",
    subject: "Test bug",
    body: "Bug description",
    status: "open",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const MESSAGE_ROWS = [
  {
    id: "msg-1",
    inquiry_id: INQUIRY_ID,
    sender_type: "user",
    sender_id: TWITCH_USER_ID,
    body: "Hello",
    created_at: "2026-01-01T01:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// postgrest 経路のモック: table ごとの結果キュー
// ---------------------------------------------------------------------------

interface PostgrestResult {
  data?: unknown;
  error?: unknown;
}

function createSupabaseClientMock(resultsByTable: Record<string, PostgrestResult[]>) {
  const queues = Object.fromEntries(
    Object.entries(resultsByTable).map(([table, results]) => [table, [...results]])
  );
  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`no mock result configured for table: ${table}`);
    }
    const result = queue.length > 1 ? (queue.shift() as PostgrestResult) : queue[0];
    const resolved = { data: result.data ?? null, error: result.error ?? null };
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      single: vi.fn(() => Promise.resolve(resolved)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolved).then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { from };
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields).from(table).where().orderBy().limit()
// を await できる thenable builder
// ---------------------------------------------------------------------------

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(config: { selects?: PgResponse[] } = {}) {
  let selectIndex = 0;
  const selectCalls: Array<{ where?: unknown; orderBy?: unknown; limit?: number }> = [];
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
  };
  return { db, selectCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

describe("support-inquiries lib: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getUserInquiries（読み取り: isPgReadEnabled）", () => {
    it("同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい where/orderBy を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: INQUIRY_ROWS }] });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      const postgrestResult = await getUserInquiries(TWITCH_USER_ID);

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: INQUIRY_ROWS }] });
      primePgDb(pg);
      const pgResult = await getUserInquiries(TWITCH_USER_ID);

      expect(pgResult).toEqual(postgrestResult);
      expect(pgResult).toEqual(INQUIRY_ROWS);

      expect(pg.selectCalls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, TWITCH_USER_ID));
      expect(pg.selectCalls[0].orderBy).toEqual(desc(supportInquiriesTable.created_at));
    });

    it("取得失敗時は両経路とも空配列を返す（安全側デグレード）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: null, error: new Error("db error") }],
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      const postgrestResult = await getUserInquiries(TWITCH_USER_ID);
      expect(postgrestResult).toEqual([]);

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ error: { code: "08006", message: "connection failure" } }] });
      primePgDb(pg);
      const pgResult = await getUserInquiries(TWITCH_USER_ID);
      expect(pgResult).toEqual([]);
    });

    it("postgrest 経路（フラグ未設定）では getDb が一切呼ばれない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({ support_inquiries: [{ data: INQUIRY_ROWS }] });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      await getUserInquiries(TWITCH_USER_ID);
      expect(getDb).not.toHaveBeenCalled();
    });
  });

  describe("getInquiryWithMessages（読み取り: isPgReadEnabled）", () => {
    it("同一 fixture で両経路の戻り値が deepEqual になり、pg 経路が正しい where/orderBy を使う", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: INQUIRY_ROWS[0] }],
        support_inquiry_messages: [{ data: MESSAGE_ROWS }],
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      const postgrestResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [INQUIRY_ROWS[0]] }, { rows: MESSAGE_ROWS }],
      });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);

      expect(pgResult).toEqual(postgrestResult);
      expect(pgResult).toEqual({ inquiry: INQUIRY_ROWS[0], messages: MESSAGE_ROWS });

      expect(pg.selectCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, INQUIRY_ID), eq(supportInquiriesTable.twitch_user_id, TWITCH_USER_ID))
      );
      expect(pg.selectCalls[1].where).toEqual(eq(supportInquiryMessagesTable.inquiry_id, INQUIRY_ID));
      expect(pg.selectCalls[1].orderBy).toEqual(asc(supportInquiryMessagesTable.created_at));
    });

    it("問い合わせが見つからない場合、両経路とも null を返す", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: null, error: new Error("Not found") }],
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      const postgrestResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(postgrestResult).toBeNull();

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(pgResult).toBeNull();
    });

    it("問い合わせ本体は取得できるがメッセージ取得だけ失敗した場合、両経路とも messages: [] にフォールバックする（部分失敗）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: INQUIRY_ROWS[0] }],
        support_inquiry_messages: [{ data: null, error: new Error("messages query failed") }],
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      const postgrestResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(postgrestResult).toEqual({ inquiry: INQUIRY_ROWS[0], messages: [] });

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [INQUIRY_ROWS[0]] },
          { error: { code: "08006", message: "connection failure" } },
        ],
      });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(pgResult).toEqual({ inquiry: INQUIRY_ROWS[0], messages: [] });

      expect(pgResult).toEqual(postgrestResult);
    });

    it("postgrest 経路（フラグ未設定）では getDb が一切呼ばれない", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const client = createSupabaseClientMock({
        support_inquiries: [{ data: INQUIRY_ROWS[0] }],
        support_inquiry_messages: [{ data: MESSAGE_ROWS }],
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
      await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(getDb).not.toHaveBeenCalled();
    });
  });
});
