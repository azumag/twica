/**
 * #663: POST/GET /api/cards のPlanetScale契約テスト
 *
 * 現行 Drizzle 実装の所有権・読み書き・競合応答と、
 * 本番スキーマ移行中の安全な列フォールバックを検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/cards/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getStorageUsage } from "@/lib/storage-usage";
import { getDb } from "@/lib/db/client";
import { CARDS_COLUMNS_WITHOUT_PADDING_COLOR } from "@/lib/db/card-padding-color-errors";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/storage-usage");
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
// GET は unstable_cache でラップされているため、bypass して直接実行させる
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockGetStorageUsage = vi.mocked(getStorageUsage);

const SESSION = {
  twitchUserId: "user1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: "",
  broadcasterType: "affiliate" as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
};

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields?).from(table).where().orderBy().limit().offset() /
// insert(table).values().returning() を await できる thenable builder
// ---------------------------------------------------------------------------

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(
  config: { selects?: PgResponse[]; inserts?: PgResponse[] } = {}
) {
  let selectIndex = 0;
  let insertIndex = 0;
  const selectCalls: Array<{ where?: unknown; orderBy?: unknown[]; limit?: number; offset?: number }> = [];
  const insertCalls: Array<{
    table: unknown;
    values?: Record<string, unknown>;
    returningFields?: Record<string, unknown>;
  }> = [];

  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex, responses.length - 1)];
      selectIndex += 1;
      const call: { where?: unknown; orderBy?: unknown[]; limit?: number; offset?: number } = {};
      selectCalls.push(call);
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              fields
                ? (response.rows ?? []).map((row) =>
                    Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
                  )
                : (response.rows ?? [])
            );
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((condition: unknown) => {
          call.where = condition;
          return builder;
        }),
        orderBy: vi.fn((...conditions: unknown[]) => {
          call.orderBy = conditions;
          return builder;
        }),
        limit: vi.fn((n: number) => {
          call.limit = n;
          return builder;
        }),
        offset: vi.fn((n: number) => {
          call.offset = n;
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
      const call: { table: unknown; values?: Record<string, unknown>; returningFields?: Record<string, unknown> } = {
        table,
      };
      insertCalls.push(call);
      const resolve = () => {
        if (response.error) return Promise.reject(response.error);
        const rows = response.rows ?? [];
        // #899: .returning(CARDS_COLUMNS_WITHOUT_PADDING_COLOR) のような明示列指定時は、
        // select(fields) と同じ「fields のキーだけを持つ行にマップする」フェイクを行い、
        // image_padding_color が実際に応答から除外されることをテストで検証できるようにする。
        const fields = call.returningFields;
        return Promise.resolve(
          fields ? rows.map((row) => Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))) : rows
        );
      };
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values;
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
  };

  return { db, selectCalls, insertCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

function createPostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/cards");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return new NextRequest(url);
}

describe("POST/GET /api/cards: PlanetScale契約 (#663)", () => {
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
    mockGetStorageUsage.mockResolvedValue({ planOverLimit: false } as Awaited<ReturnType<typeof getStorageUsage>>);
  });

  describe("POST /api/cards", () => {
    // rarity_weights: null にして recalculateIfAutoMode を即 return null（DB非到達）にする
    const STREAMER_ROW = { id: "streamer-1", rarity_weights: null, card_pack_names: [] };
    const REQUEST_BODY = {
      streamerId: "streamer-1",
      name: "Test Card",
      description: "desc",
      imageUrl: "https://example.com/a.png",
      rarity: "common",
      dropRate: 0.5,
    };
    const CREATED_ROW = {
      id: "card-1",
      streamer_id: "streamer-1",
      name: "Test Card",
      description: "desc",
      image_url: "https://example.com/a.png",
      rarity: "common",
      card_number: null,
      max_issuance_count: null,
      collection_name: null,
      drop_rate: 0.5,
      intra_rarity_weight: 1,
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const EXPECTED_INSERT_VALUES = {
      streamer_id: "streamer-1",
      name: "Test Card",
      description: "desc",
      image_url: "https://example.com/a.png",
      rarity: "common",
      card_number: null,
      max_issuance_count: null,
      drop_rate: 0.5,
    };

    it("成功時は正しいINSERT値と作成結果を返す", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ rows: [CREATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson).toEqual({ ...CREATED_ROW, recalculatedCards: null });
      expect(pg.insertCalls[0].values).toEqual(EXPECTED_INSERT_VALUES);
    });

    it("imagePaddingColor 指定時は INSERT 値に余白色が含まれる (#899)", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ rows: [CREATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST(
        createPostRequest({ ...REQUEST_BODY, imagePaddingColor: "black" })
      );
      expect(pgRes.status).toBe(200);
      expect(pg.insertCalls[0].values).toMatchObject({
        image_padding_color: "black",
      });
    });

    it("不正な余白色は400で拒否する (#899)", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ rows: [CREATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST(
        createPostRequest({ ...REQUEST_BODY, imagePaddingColor: "url(javascript:alert(1))" })
      );
      expect(pgRes.status).toBe(400);
      expect(pg.insertCalls).toHaveLength(0);
    });

    it("imagePaddingColor が空文字なら余白色は null として保存される (#899)", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ rows: [CREATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST(
        createPostRequest({ ...REQUEST_BODY, imagePaddingColor: "" })
      );
      expect(pgRes.status).toBe(200);
      expect(pg.insertCalls[0].values).toMatchObject({
        image_padding_color: null,
      });
    });

    it("streamer所有権なしでは403を返しINSERTしない", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(403);
      expect(pg.insertCalls).toHaveLength(0);
    });

    it("card_number列デプロイ窓では列を落として再試行し200を返す", async () => {
      const missingColumnErrorPg = {
        code: "42703",
        message: 'column "card_number" of relation "cards" does not exist',
      };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ error: missingColumnErrorPg }, { rows: [CREATED_ROW] }],
      });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(200);
      expect(pg.insertCalls).toHaveLength(2);
      expect(pg.insertCalls[1].values).not.toHaveProperty("card_number");
    });

    it("card_number一意制約違反(23505)は409を返す", async () => {
      const conflictErrorPg = {
        code: "23505",
        message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
      };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [{ error: conflictErrorPg }],
      });
      primePgDb(pg);
      const pgRes = await POST(createPostRequest({ ...REQUEST_BODY, cardNumber: 5 }));
      expect(pgRes.status).toBe(409);
    });

    // Fable厳格レビュー指摘(#899 PR #903)対応の回帰テスト。修正前は
    // isMissingCardsBattleColumnError のみを見る末尾フォールバックが
    // image_padding_color 欠落エラーを拾えず、imagePaddingColor を一切
    // 指定しない（=insertDataに含まれない）POSTまでもがmigration未適用の
    // デプロイ窓で全て失敗していた。#834 で「本番未デプロイ8列」フォールバック
    // 自体は撤去されたが、image_padding_color 専用の末尾フォールバック
    // （CARDS_COLUMNS_WITHOUT_PADDING_COLOR への切替）は引き続き必要なため残す。
    it("本番未デプロイのimage_padding_color列: imagePaddingColorを指定しないPOSTでもRETURNING失敗時に明示列リストで再試行し200を返す (#899)", async () => {
      const missingPaddingErrorPg = {
        code: "42703",
        message: 'column "image_padding_color" of relation "cards" does not exist',
      };
      const CREATED_ROW_SAFE = {
        id: "card-1",
        streamer_id: "streamer-1",
        name: "Test Card",
        description: "desc",
        image_url: "https://example.com/a.png",
        rarity: "common",
        rarity_order: null,
        max_issuance_count: null,
        collection_name: null,
        drop_rate: 0.5,
        intra_rarity_weight: 1,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_ROW] }],
        inserts: [
          { error: missingPaddingErrorPg }, // attempt1: 無指定RETURNINGがimage_padding_colorで失敗
          { rows: [CREATED_ROW_SAFE] }, // attempt2: SAFE_COLUMNSで再試行し成功
        ],
      });
      primePgDb(pg);
      // imagePaddingColor はリクエストに含めない = insertData に含まれない
      // ため、途中の「列を落として再試行」フォールバックはスキップされる。
      const pgRes = await POST(createPostRequest(REQUEST_BODY));
      expect(pgRes.status).toBe(200);
      expect(pg.insertCalls).toHaveLength(2);
      expect(pg.insertCalls[1].returningFields).toEqual(CARDS_COLUMNS_WITHOUT_PADDING_COLOR);
    });
  });

  describe("GET /api/cards", () => {
    const STREAMER_OWNERSHIP_ROW = { id: "streamer-1" };
    const CARD_ROWS = [
      {
        id: "card-1",
        streamer_id: "streamer-1",
        name: "Card A",
        description: null,
        image_url: null,
        rarity: "common",
        rarity_order: 4,
        card_number: null,
        max_issuance_count: null,
        collection_name: null,
        drop_rate: 0.5,
        intra_rarity_weight: 1,
        is_active: true,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "card-2",
        streamer_id: "streamer-1",
        name: "Card B",
        description: null,
        image_url: null,
        rarity: "rare",
        rarity_order: 3,
        card_number: null,
        max_issuance_count: null,
        collection_name: null,
        drop_rate: 0.2,
        intra_rarity_weight: 1,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];

    it("成功時はカードとページネーションを返す", async () => {
      const pg = createDrizzleDbMock({
        selects: [{ rows: [STREAMER_OWNERSHIP_ROW] }, { rows: [{ count: 2 }] }, { rows: CARD_ROWS }],
      });
      primePgDb(pg);
      const pgRes = await GET(createGetRequest({ streamerId: "streamer-1" }));
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson.cards).toHaveLength(2);
      expect(pgJson.pagination).toEqual({ total: 2, limit: 12, offset: 0, hasMore: false });
    });

    it("streamer所有権なしでは403を返す", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);
      const pgRes = await GET(createGetRequest({ streamerId: "streamer-1" }));
      expect(pgRes.status).toBe(403);
    });

    it("card_numberソート列デプロイ窓ではcreated_atへフォールバックする", async () => {
      const missingColumnErrorPg = {
        code: "42703",
        message: 'column "card_number" does not exist',
      };

      const pg = createDrizzleDbMock({
        selects: [
          { rows: [STREAMER_OWNERSHIP_ROW] },
          { rows: [{ count: 2 }] },
          { error: missingColumnErrorPg },
          { rows: CARD_ROWS },
        ],
      });
      primePgDb(pg);
      const pgRes = await GET(createGetRequest({ streamerId: "streamer-1", sortField: "card_number" }));
      expect(pgRes.status).toBe(200);
      const pgJson = await pgRes.json();

      expect(pgJson.cards).toHaveLength(2);
      expect(pgJson.pagination.total).toBe(2);
    });

  });
});
