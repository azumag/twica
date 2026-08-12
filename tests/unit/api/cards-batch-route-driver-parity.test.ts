/**
 * #663: POST /api/cards/batch のPlanetScale契約テスト
 *
 * 現行 Drizzle 実装の戻り値・所有権・一括 INSERT 値と、
 * 本番スキーマ移行中の RETURNING フォールバックを検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cards/batch/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getDb } from "@/lib/db/client";
import { sha256Prefix } from "@/lib/crypto-utils";
import { CARDS_COLUMNS_WITHOUT_PADDING_COLOR } from "@/lib/db/cards-safe-columns";

// #830: 画像URLの所有権判定は R2 の公開URLに依存するため、テストでは固定値を与える
const R2_PUBLIC_URL = "https://images.example.test";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/r2-client", () => ({
  getR2PublicUrl: vi.fn(() => R2_PUBLIC_URL),
}));
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
// pg 経路のモック
// ---------------------------------------------------------------------------

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; inserts?: PgResponse[] } = {}) {
  let selectIndex = 0;
  let insertIndex = 0;
  const selectCalls: Array<{ where?: unknown }> = [];
  const insertCalls: Array<{
    table: unknown;
    values?: Record<string, unknown>[];
    returningFields?: Record<string, unknown>;
  }> = [];

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
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [] }];
      const response = responses[Math.min(insertIndex, responses.length - 1)];
      insertIndex += 1;
      const call: {
        table: unknown;
        values?: Record<string, unknown>[];
        returningFields?: Record<string, unknown>;
      } = { table };
      insertCalls.push(call);
      const resolve = () => {
        if (response.error) return Promise.reject(response.error);
        const rows = response.rows ?? [];
        // returning(fields) が指定された場合は select(fields) と同じ「fields の
        // キーだけを持つ行にマップする」フェイクを行う汎用モック（現状このファイル
        // の POST /api/cards/batch は無指定 .returning() のみを使うため常に rows
        // をそのまま返す経路を通る）。
        const fields = call.returningFields;
        return Promise.resolve(
          fields ? rows.map((row) => Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))) : rows
        );
      };
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>[]) => {
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

function createBatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/cards/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cards/batch: PlanetScale契約 (#663)", () => {
  // rarity_weights: null にして recalculateIfAutoMode を即 return null（DB非到達）にする
  const STREAMER_ROW = { id: "streamer-1", rarity_weights: null };
  const REQUEST_BODY = {
    streamerId: "streamer-1",
    cards: [
      { name: "Card A", imageUrl: "https://example.com/a.png", rarity: "common", dropRate: 0.5 },
      { name: "Card B", imageUrl: "https://example.com/b.png", rarity: "rare", dropRate: 0.2, description: "desc" },
    ],
  };
  const CREATED_ROWS = [
    {
      id: "card-1",
      streamer_id: "streamer-1",
      name: "Card A",
      description: "",
      image_url: "https://example.com/a.png",
      rarity: "common",
      drop_rate: 0.5,
    },
    {
      id: "card-2",
      streamer_id: "streamer-1",
      name: "Card B",
      description: "desc",
      image_url: "https://example.com/b.png",
      rarity: "rare",
      drop_rate: 0.2,
    },
  ];
  const EXPECTED_INSERT_VALUES = [
    {
      streamer_id: "streamer-1",
      name: "Card A",
      description: "",
      image_url: "https://example.com/a.png",
      rarity: "common",
      drop_rate: 0.5,
    },
    {
      streamer_id: "streamer-1",
      name: "Card B",
      description: "desc",
      image_url: "https://example.com/b.png",
      rarity: "rare",
      drop_rate: 0.2,
    },
  ];

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
  });

  it("成功時は正しい一括INSERT値と作成結果を返す", async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ rows: CREATED_ROWS }],
    });
    primePgDb(pg);
    const pgRes = await POST(createBatchRequest(REQUEST_BODY));
    expect(pgRes.status).toBe(200);
    const pgJson = await pgRes.json();

    expect(pgJson).toEqual({
      success: true,
      created: 2,
      cards: CREATED_ROWS,
      recalculatedCards: null,
    });
    expect(pg.insertCalls[0].table).toBeDefined();
    expect(pg.insertCalls[0].values).toEqual(EXPECTED_INSERT_VALUES);
  });

  // #834 自己レビュー指摘: batch route の cardsToInsert は image_padding_color を
  // 一切含まない(BatchCardInputに無い)が、無指定 `.returning()` は VALUES の内容と
  // 無関係に schema.ts の全列を要求するため、この列が未適用の環境では一括作成が
  // 全滅しうる(cards/route.ts の insertCardPg と同じ構造の欠落)。
  // CARDS_COLUMNS_WITHOUT_PADDING_COLOR への切替フォールバックを検証する。
  it("本番未デプロイのimage_padding_color列: RETURNING失敗時に明示列リストで再試行し200を返す (#899)", async () => {
    const missingPaddingErrorPg = {
      code: "42703",
      message: 'column "image_padding_color" of relation "cards" does not exist',
    };

    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [
        { error: missingPaddingErrorPg }, // attempt1: 無指定RETURNINGがimage_padding_colorで失敗
        { rows: CREATED_ROWS }, // attempt2: CARDS_COLUMNS_WITHOUT_PADDING_COLORで再試行し成功
      ],
    });
    primePgDb(pg);
    const pgRes = await POST(createBatchRequest(REQUEST_BODY));
    expect(pgRes.status).toBe(200);
    const pgJson = await pgRes.json();

    expect(pgJson).toMatchObject({ success: true, created: 2 });
    expect(pg.insertCalls).toHaveLength(2);
    expect(pg.insertCalls[1].returningFields).toEqual(CARDS_COLUMNS_WITHOUT_PADDING_COLOR);
  });

  it("streamer所有権なしでは403を返しINSERTしない", async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
    primePgDb(pg);
    const pgRes = await POST(createBatchRequest(REQUEST_BODY));
    expect(pgRes.status).toBe(403);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it("INSERT失敗時は500を返す", async () => {
    const dbError = { code: "XX000", message: "unexpected database error" };

    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ error: dbError }],
    });
    primePgDb(pg);
    const pgRes = await POST(createBatchRequest(REQUEST_BODY));
    expect(pgRes.status).toBe(500);
  });

  // #830: 他人のストレージURLをカードへ紐付けると、以降のカード削除時の
  // クリーンアップで他人のR2オブジェクトが消えるため、作成時点で拒否する。
  it("他人のストレージURLを含むカードは400で拒否しINSERTしない (#830)", async () => {
    const victimPrefix = await sha256Prefix("victim-user-id");
    const pg = createDrizzleDbMock({ selects: [{ rows: [STREAMER_ROW] }] });
    primePgDb(pg);

    const pgRes = await POST(
      createBatchRequest({
        streamerId: "streamer-1",
        cards: [
          {
            name: "Card A",
            imageUrl: `${R2_PUBLIC_URL}/${victimPrefix}_deadbeef.png`,
            rarity: "common",
            dropRate: 0.5,
          },
        ],
      })
    );

    expect(pgRes.status).toBe(400);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it("自分のストレージURLを含むカードは従来どおり作成できる (#830)", async () => {
    const ownPrefix = await sha256Prefix("user1");
    const imageUrl = `${R2_PUBLIC_URL}/${ownPrefix}_deadbeef.png`;
    const pg = createDrizzleDbMock({
      selects: [{ rows: [STREAMER_ROW] }],
      inserts: [{ rows: [{ id: "card-1", streamer_id: "streamer-1", name: "Card A", image_url: imageUrl }] }],
    });
    primePgDb(pg);

    const pgRes = await POST(
      createBatchRequest({
        streamerId: "streamer-1",
        cards: [{ name: "Card A", imageUrl, rarity: "common", dropRate: 0.5 }],
      })
    );

    expect(pgRes.status).toBe(200);
    expect(pg.insertCalls).toHaveLength(1);
  });


  it("500字を超える description は400で拒否しINSERTしない (#836)", async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [STREAMER_ROW] }] });
    primePgDb(pg);

    const pgRes = await POST(
      createBatchRequest({
        streamerId: "streamer-1",
        cards: [
          {
            name: "Card A",
            imageUrl: "https://example.com/a.png",
            rarity: "common",
            dropRate: 0.5,
            description: "あ".repeat(501),
          },
        ],
      })
    );

    expect(pgRes.status).toBe(400);
    expect(pg.insertCalls).toHaveLength(0);
  });
})
