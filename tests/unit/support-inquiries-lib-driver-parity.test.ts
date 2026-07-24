/**
 * #663: src/lib/support-inquiries.ts のPlanetScale回帰テスト
 *
 * 対象:
 *   - getUserInquiries        （一覧取得）
 *   - getInquiryWithMessages  （詳細+メッセージ取得、
 *                                メッセージ取得だけの部分失敗を messages: [] にフォールバック）
 *
 * これらは src/app/api/support-inquiries/ 配下のルートハンドラとは独立した
 * データアクセス関数（ダッシュボードの Server Component から呼ばれる）。
 * クエリ形状はルート側の実装とほぼ同じだが、意図的に別実装として保守する方針
 * （brief 記載のとおり、共有ヘルパーへの統合はスコープ外）。
 *
 * announcements-driver-parity.test.ts / storage-db-driver-parity.test.ts の流儀を踏襲。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import { getUserInquiries, getInquiryWithMessages } from "@/lib/support-inquiries";
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

describe("support-inquiries lib: PlanetScale契約 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getUserInquiries", () => {
    it("fixtureを返し、正しいwhere/orderByを使う", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: INQUIRY_ROWS }] });
      primePgDb(pg);
      const pgResult = await getUserInquiries(TWITCH_USER_ID);

      expect(pgResult).toEqual(INQUIRY_ROWS);

      expect(pg.selectCalls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, TWITCH_USER_ID));
      expect(pg.selectCalls[0].orderBy).toEqual(desc(supportInquiriesTable.created_at));
    });

    it("取得失敗時は空配列を返す（安全側デグレード）", async () => {
      const pg = createDrizzleDbMock({ selects: [{ error: { code: "08006", message: "connection failure" } }] });
      primePgDb(pg);
      const pgResult = await getUserInquiries(TWITCH_USER_ID);
      expect(pgResult).toEqual([]);
    });
  });

  describe("getInquiryWithMessages", () => {
    it("問い合わせとメッセージを返し、正しいwhere/orderByを使う", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [INQUIRY_ROWS[0]] }, { rows: MESSAGE_ROWS }],
      });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);

      expect(pgResult).toEqual({ inquiry: INQUIRY_ROWS[0], messages: MESSAGE_ROWS });

      expect(pg.selectCalls[0].where).toEqual(
        and(eq(supportInquiriesTable.id, INQUIRY_ID), eq(supportInquiriesTable.twitch_user_id, TWITCH_USER_ID))
      );
      expect(pg.selectCalls[1].where).toEqual(eq(supportInquiryMessagesTable.inquiry_id, INQUIRY_ID));
      expect(pg.selectCalls[1].orderBy).toEqual(asc(supportInquiryMessagesTable.created_at));
    });

    it("問い合わせが見つからない場合はnullを返す", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(pgResult).toBeNull();
    });

    it("メッセージ取得だけ失敗した場合はmessages: []へフォールバックする", async () => {
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [INQUIRY_ROWS[0]] },
          { error: { code: "08006", message: "connection failure" } },
        ],
      });
      primePgDb(pg);
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, TWITCH_USER_ID);
      expect(pgResult).toEqual({ inquiry: INQUIRY_ROWS[0], messages: [] });
    });
  });
});
