/**
 * Issue #571 (#570 パイロット踏襲): overlay ポーリング API の pg 直結経路テスト。
 *
 * tests/unit/overlay-events-api.test.ts (既存 postgrest 経路のテスト、無変更) と
 * tests/unit/announcements-driver-parity.test.ts (pg/postgrest 形状互換テストの
 * 確立パターン) の両方を踏襲する。DB_DRIVER フラグで分岐する pg 経路について:
 *   1. 応答形状が既存 postgrest 経路と deepEqual であること
 *   2. reward_id 列欠落(42703, Issue #591 デプロイ窓)フォールバック
 *   3. 0 イベント時
 *   4. since カーソルの往復互換(pg のテキスト形式 redeemedAt がクライアント側
 *      Date.parse 正規化を経て次回 since として問題なく受理されること)
 * を検証する。フルスイートは実行せず、このファイル(と関連する変更分)のみを対象とする。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/overlay/[streamerId]/events/route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db/client";
import { createMockQueryBuilder } from "../utils/supabase-mock";

vi.mock("@/lib/rate-limit");
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
// @/lib/db/client の getDb は tests/setup.ts でグローバルに throw するスタブとして
// モック済み(DB_DRIVER 既定=postgrestでは呼ばれないことを保証するため)。
// pg 経路をテストする本ファイルでは vi.mocked(getDb).mockResolvedValue(...) で
// 個別に上書きする(announcements-driver-parity.test.ts と同じ方式)。

const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

function createRequest(streamerId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/overlay/${streamerId}/events`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function createRouteParams(streamerId: string) {
  return { params: Promise.resolve({ streamerId }) };
}

/** postgrest(supabase-js) 経路の gacha_history クエリモック。既存テストと同形式。 */
function createHistoryQuery(response: { data: unknown; error: unknown }) {
  const q = createMockQueryBuilder();
  (q as unknown as Record<string, unknown>).then = (resolve: (value: unknown) => void) => {
    resolve(response);
    return q;
  };
  return q;
}

/**
 * pg 直結(Drizzle)経路のモック。
 * db.select(fields).from(table).leftJoin(table2, cond).where(cond).orderBy(cond).limit(n)
 * を await できる thenable にする。fixture 行(あらかじめ gacha_history + cards を
 * 手動 join した flat 行)から fields のキーだけを射影して返すことで、実装が
 * 列を選び忘れた場合にテストが落ちるようにする
 * (announcements-driver-parity.test.ts の createDrizzleDbMock と同じ方針)。
 * responses は呼び出し回数ごとの応答(行 or エラー)を並べた配列で、
 * reward_id 列欠落フォールバックの「1回目失敗・2回目成功」を再現できる。
 */
function createDrizzleOverlayDbMock(
  responses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>
) {
  let callCount = 0;
  const select = vi.fn((fields: Record<string, unknown>) => {
    const builder: any = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => {
        const response = responses[Math.min(callCount, responses.length - 1)];
        callCount += 1;
        if (response.error) {
          return Promise.reject(response.error);
        }
        const projected = (response.rows ?? []).map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
        );
        return Promise.resolve(projected);
      }),
    };
    return builder;
  });
  return { select };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 120,
    remaining: 119,
    reset: Date.now() + 60000,
  });
});

afterEach(() => {
  // db-flags.test.ts 等と同じ変数を扱うため、他テストへ漏れないよう必ず復元する
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. 応答形状: postgrest 経路と pg 経路で deepEqual
// ---------------------------------------------------------------------------
describe("GET /api/overlay/[streamerId]/events: pg 経路の応答形状互換 (#571)", () => {
  // 同一の論理データを postgrest 用(nested cards)・pg 用(flat 列)それぞれの
  // fixture として用意する。h3 は一致するカードが無い行(cards/card_id が null)で、
  // 両経路とも resolveCard によりフィルタされ events に含まれないことも検証する。
  const POSTGREST_ROWS = [
    {
      id: "h1",
      event_id: "event-1",
      redeemed_at: "2026-01-01T00:00:01.000Z",
      user_twitch_username: "viewer1",
      reward_id: "reward-abc",
      cards: { id: "c1", name: "Card1", description: "desc1", image_url: "https://example.com/1.png", rarity: "rare" },
    },
    {
      id: "h2",
      event_id: null,
      redeemed_at: "2026-01-01T00:00:02.000Z",
      user_twitch_username: null,
      reward_id: null,
      cards: { id: "c2", name: "Card2", description: null, image_url: null, rarity: "common" },
    },
    {
      id: "h3",
      event_id: "event-3",
      redeemed_at: "2026-01-01T00:00:03.000Z",
      user_twitch_username: "viewer3",
      reward_id: null,
      cards: null,
    },
  ];

  const PG_ROWS = [
    {
      id: "h1",
      event_id: "event-1",
      redeemed_at: "2026-01-01T00:00:01.000Z",
      user_twitch_username: "viewer1",
      reward_id: "reward-abc",
      card_id: "c1",
      card_name: "Card1",
      card_description: "desc1",
      card_image_url: "https://example.com/1.png",
      card_rarity: "rare",
    },
    {
      id: "h2",
      event_id: null,
      redeemed_at: "2026-01-01T00:00:02.000Z",
      user_twitch_username: null,
      reward_id: null,
      card_id: "c2",
      card_name: "Card2",
      card_description: null,
      card_image_url: null,
      card_rarity: "common",
    },
    {
      id: "h3",
      event_id: "event-3",
      redeemed_at: "2026-01-01T00:00:03.000Z",
      user_twitch_username: "viewer3",
      reward_id: null,
      card_id: null,
      card_name: null,
      card_description: null,
      card_image_url: null,
      card_rarity: null,
    },
  ];

  const EXPECTED_EVENTS = [
    {
      id: "h1",
      eventId: "event-1",
      redeemedAt: "2026-01-01T00:00:01.000Z",
      userTwitchUsername: "viewer1",
      rewardId: "reward-abc",
      card: { id: "c1", name: "Card1", description: "desc1", image_url: "https://example.com/1.png", rarity: "rare" },
    },
    {
      id: "h2",
      eventId: null,
      redeemedAt: "2026-01-01T00:00:02.000Z",
      userTwitchUsername: "Unknown",
      rewardId: null,
      card: { id: "c2", name: "Card2", description: null, image_url: null, rarity: "common" },
    },
  ];

  async function runPostgrestPath() {
    vi.stubEnv("DB_DRIVER", undefined);
    const historyQuery = createHistoryQuery({ data: POSTGREST_ROWS, error: null });
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => historyQuery),
    } as unknown as ReturnType<typeof getSupabaseAdmin>);
    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );
    return { res, body: await res.json() };
  }

  async function runPgPath() {
    vi.stubEnv("DB_DRIVER", "pg-read");
    const db = createDrizzleOverlayDbMock([{ rows: PG_ROWS }]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);
    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );
    return { res, body: await res.json(), db };
  }

  it("同一データで両経路の応答 JSON が deepEqual になる(card入れ子・キー名・日付文字列含む)", async () => {
    const { res: postgrestRes, body: postgrestBody } = await runPostgrestPath();
    const { res: pgRes, body: pgBody } = await runPgPath();

    expect(postgrestRes.status).toBe(200);
    expect(pgRes.status).toBe(200);
    expect(pgBody.events).toEqual(postgrestBody.events);
    expect(postgrestBody.events).toEqual(EXPECTED_EVENTS);

    // redeemedAt は両経路とも文字列(Dateオブジェクトではない)
    for (const body of [postgrestBody, pgBody]) {
      for (const event of body.events) {
        expect(typeof event.redeemedAt).toBe("string");
      }
    }
  });

  it("postgrest 経路(フラグ未設定)では getDb が一切呼ばれない(挙動不変の検証)", async () => {
    await runPostgrestPath();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("pg 経路では supabase-js クライアントが一切呼ばれない", async () => {
    const { db } = await runPgPath();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. reward_id 列欠落フォールバック (Issue #591 相当, pg版)
// ---------------------------------------------------------------------------
describe("GET /api/overlay/[streamerId]/events: pg経路のreward_id列欠落フォールバック (Issue #591)", () => {
  it("42703(列欠落)時は列無しクエリへフォールバックしrewardId:nullを返す", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    const db = createDrizzleOverlayDbMock([
      { error: { code: "42703", message: 'column "reward_id" of relation "gacha_history" does not exist' } },
      {
        rows: [
          {
            id: "h4",
            event_id: "event-4",
            redeemed_at: "2026-01-01T00:00:04.000Z",
            user_twitch_username: "viewer4",
            card_id: "c4",
            card_name: "Card4",
            card_description: null,
            card_image_url: null,
            card_rarity: "epic",
          },
        ],
      },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].rewardId).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("列欠落以外のエラーはフォールバックせずhandleDatabaseError経由で500を返す", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    // 42601(syntax_error)は retry.ts の RETRYABLE_SQLSTATES に含まれない
    // 恒久的エラーの例(08006 等の一時障害系コードだと withDbRetry が
    // 正しくリトライしてしまい、このテストの意図(列欠落以外は即エラー)
    // と噛み合わないため、恒久的エラーを選ぶ)。
    const db = createDrizzleOverlayDbMock([
      { error: { code: "42601", message: "syntax error" } },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(500);
    // フォールバックは発生せず、withDbRetry も恒久的エラーとしてリトライせず
    // 1回で即 throw する(isRetryableDbError が 42601 を非対象と判定するため)。
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("接続断等の一時障害(08006)はmaxRetries:1の設定どおり1回だけ再試行して500を返す", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    vi.useFakeTimers();
    try {
      // 08006(connection_failure)は retry.ts の RETRYABLE_SQLSTATES に含まれる
      // 一時障害系コード。自己レビュー指摘への対応として、既存postgrest経路と
      // 同じ maxRetries: 1(このエンドポイント固有のチューニング。3秒間隔の
      // ポーリングで既定の3回リトライだと最大約1.4秒応答が遅延するため)を
      // pg経路にも明示指定している。ここでは「1回だけ」再試行して打ち切る
      // ことを検証する(fake timers で実時間の遅延を待たずに検証)。
      const db = createDrizzleOverlayDbMock([
        { error: { code: "08006", message: "connection reset" } },
      ]);
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const resPromise = GET(
        createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
        createRouteParams("streamer-1")
      );
      await vi.runAllTimersAsync();
      const res = await resPromise;

      expect(res.status).toBe(500);
      // 初回 + リトライ1回(maxRetries:1) = 2回
      expect(db.select).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reward_id以外の列が欠落した42703(想定外のスキーマドリフト)はフォールバックしない", async () => {
    // 自己レビュー指摘への対応: isPgMissingColumnError() だけで判定すると
    // 列名を問わず true になり、reward_id とは無関係な列欠落まで
    // 「reward_id フォールバック」だと誤認して無駄なフォールバッククエリを
    // 発行してしまう。isMissingRewardIdColumnErrorPg はエラーメッセージに
    // "reward_id" を含むかを追加で見るため、この誤発火が起きないことを検証する。
    vi.stubEnv("DB_DRIVER", "pg-read");
    const db = createDrizzleOverlayDbMock([
      { error: { code: "42703", message: 'column "user_twitch_username" of relation "gacha_history" does not exist' } },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(500);
    // フォールバッククエリは発行されない(1回のみ)
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 0 イベント時 (pg版)
// ---------------------------------------------------------------------------
describe("GET /api/overlay/[streamerId]/events: pg経路の0件応答", () => {
  it("新着イベントが無い場合 events: [] を返す", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    const db = createDrizzleOverlayDbMock([{ rows: [] }]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.overlayVersion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. since カーソルの往復互換
// ---------------------------------------------------------------------------
describe("GET /api/overlay/[streamerId]/events: pg経路のredeemedAt/sinceカーソル往復互換", () => {
  it("PGテキスト形式のredeemedAtがクライアント正規化(Date.parse→toISOString)を経て次回sinceとして受理される", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    // pg 直結はスペース区切り・マイクロ秒精度の PG テキスト形式で timestamptz を返す
    // (drizzle-orm/postgres-js がパーサをパススルーに上書きするため。
    // src/lib/db/client.ts のコメント参照)。PostgREST の T区切りISO8601とは
    // 表現が異なるが、overlay クライアント(page.tsx の pollOverlayEvents)は
    // Date.parse() 経由でのみこの値を消費するため、ここでは同じ正規化ロジックを
    // 再現して破綻しないことを検証する。
    const db = createDrizzleOverlayDbMock([
      {
        rows: [
          {
            id: "h5",
            event_id: "event-5",
            redeemed_at: "2026-01-01 00:00:01.654321+00",
            user_twitch_username: "viewer5",
            reward_id: null,
            card_id: "c5",
            card_name: "Card5",
            card_description: null,
            card_image_url: null,
            card_rarity: "legendary",
          },
        ],
      },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const res = await GET(
      createRequest("streamer-1", { since: "2026-01-01T00:00:00.000Z" }),
      createRouteParams("streamer-1")
    );
    const body = await res.json();
    const redeemedAt: string = body.events[0].redeemedAt;

    // overlay クライアントの pollOverlayEvents と同じ正規化: Date.parse が
    // 有限値を返すこと(=パース破綻しないこと)、かつ toISOString() で
    // 意図した瞬間に一致すること。
    const ms = Date.parse(redeemedAt);
    expect(Number.isFinite(ms)).toBe(true);
    const nextSince = new Date(ms).toISOString();
    expect(nextSince).toBe("2026-01-01T00:00:01.654Z");

    // その nextSince を次回ポーリングの ?since= としてそのまま渡しても
    // 400(Invalid since parameter)にならず正常に受理されること
    // (normalizeDateParam との往復互換。既存の共有ロジックで無変更)。
    const db2 = createDrizzleOverlayDbMock([{ rows: [] }]);
    vi.mocked(getDb).mockResolvedValue({ db: db2, sql: {} } as any);
    const res2 = await GET(
      createRequest("streamer-1", { since: nextSince }),
      createRouteParams("streamer-1")
    );
    expect(res2.status).toBe(200);
  });
});
