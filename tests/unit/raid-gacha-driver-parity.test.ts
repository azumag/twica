/**
 * #663: 低頻度APIルート群のpg直結移行 — レイドガチャAPIの
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象: GET/POST /api/streamer/raid-gacha
 * この API には既存の専用テストファイルが無いため、postgrest経路のベースライン
 * カバレッジも本ファイルでまとめて用意する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db/client";
import { streamers as streamersTable } from "@/lib/db/schema";

vi.mock("@/lib/session");
vi.mock("@/lib/csrf");
vi.mock("@/lib/rate-limit");
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
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);

const STREAMER_SESSION = {
  twitchUserId: "streamer1",
  twitchUsername: "streamer1",
  twitchDisplayName: "Streamer 1",
  twitchProfileImageUrl: "",
  broadcasterType: "affiliate",
  expiresAt: Date.now() + 100000,
  version: 1,
};

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(config: { selects?: PgResponse[]; updates?: PgResponse[] } = {}) {
  let selectIndex = 0;
  let updateIndex = 0;
  const selectCalls: Array<{ where?: unknown }> = [];
  const updateCalls: Array<{ set?: unknown; where?: unknown }> = [];

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
    update: vi.fn(() => {
      const responses = config.updates ?? [{ rows: [] }];
      const response = responses[Math.min(updateIndex, responses.length - 1)];
      updateIndex += 1;
      const call: { set?: unknown; where?: unknown } = {};
      updateCalls.push(call);
      const resolve = () => (response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? []));
      const builder: any = {
        set: vi.fn((values: unknown) => {
          call.set = values;
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
  return { db, selectCalls, updateCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

function createStreamersSupabaseMock(selectResult: { data: unknown; error: unknown }, updateResult?: { data: unknown; error: unknown }) {
  const selectMaybeSingle = vi.fn().mockResolvedValue(selectResult);
  const selectEq = vi.fn(() => ({ maybeSingle: selectMaybeSingle }));
  const select = vi.fn(() => ({ eq: selectEq }));

  const updateMaybeSingle = vi.fn().mockResolvedValue(updateResult ?? { data: null, error: null });
  const updateSelect = vi.fn(() => ({ maybeSingle: updateMaybeSingle }));
  const updateEq = vi.fn(() => ({ select: updateSelect }));
  const update = vi.fn(() => ({ eq: updateEq }));

  return { from: vi.fn(() => ({ select, update })), select, update };
}

async function loadRoute() {
  return import("@/app/api/streamer/raid-gacha/route");
}

function getRequest() {
  return new NextRequest("http://localhost/api/streamer/raid-gacha");
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/streamer/raid-gacha", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("streamer/raid-gacha: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 } as any);
    mockGetRateLimitIdentifier.mockResolvedValue("user:streamer1");
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET", () => {
    it("フラグ未設定時は getDb が呼ばれない（postgrest 経路のベースライン）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const supabase = createStreamersSupabaseMock({
        data: { id: "streamer-id-1", raid_gacha_active_until: null, raid_gacha_draw_count: 0 },
        error: null,
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabase as any);

      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ active: false, activeUntil: null, drawCount: 0 });
      expect(getDb).not.toHaveBeenCalled();
    });

    it("postgrest 経路: 401 (未認証)", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      mockGetSession.mockResolvedValue(null);
      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      expect(response.status).toBe(401);
    });

    it("DB_DRIVER=pg-read: 同一fixtureで両経路の戻り値が一致する", async () => {
      const FIXTURE = { id: "streamer-id-1", raid_gacha_active_until: "2999-01-01T00:00:00.000+00:00", raid_gacha_draw_count: 5 };

      vi.stubEnv("DB_DRIVER", undefined);
      const supabase = createStreamersSupabaseMock({ data: FIXTURE, error: null });
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabase as any);
      const { GET: postgrestGET } = await loadRoute();
      const postgrestResponse = await postgrestGET(getRequest());
      const postgrestBody = await postgrestResponse.json();

      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [FIXTURE] }] });
      primePgDb(pg);
      const { GET: pgGET } = await loadRoute();
      const pgResponse = await pgGET(getRequest());
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(postgrestResponse.status);
      expect(pgBody).toEqual(postgrestBody);
      expect(getDb).toHaveBeenCalled();
      expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, "streamer1"));
    });

    it("DB_DRIVER=pg-read: streamerが見つからなければ両経路とも404", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      expect(response.status).toBe(404);
    });

    it("DB_DRIVER=pg-read: raid列欠落エラー時は列を落としてフォールバックし、デフォルト値を返す", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      let call = 0;
      const db = {
        select: vi.fn((fields: Record<string, unknown>) => {
          call += 1;
          const builder: any = {
            from: vi.fn(() => builder),
            where: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            then: (onFulfilled: any, onRejected: any) => {
              if (call === 1) {
                return Promise.reject({
                  code: "42703",
                  message: 'column "raid_gacha_active_until" of relation "streamers" does not exist',
                }).then(onFulfilled, onRejected);
              }
              return Promise.resolve(
                Object.keys(fields).includes("id") && Object.keys(fields).length === 1
                  ? [{ id: "streamer-id-1" }]
                  : []
              ).then(onFulfilled, onRejected);
            },
          };
          return builder;
        }),
      };
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ active: false, activeUntil: null, drawCount: 0 });
    });
  });

  describe("POST", () => {
    it("フラグ未設定時は getDb が呼ばれない（postgrest 経路のベースライン）", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const supabase = createStreamersSupabaseMock(
        { data: { id: "streamer-id-1", raid_gacha_active_until: null, raid_gacha_draw_count: 0 }, error: null },
        { data: { raid_gacha_active_until: null, raid_gacha_draw_count: 3 }, error: null }
      );
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabase as any);

      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 3 }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, active: false, activeUntil: null, drawCount: 3 });
      expect(getDb).not.toHaveBeenCalled();
    });

    it("postgrest 経路: drawCount が範囲外なら400", async () => {
      vi.stubEnv("DB_DRIVER", undefined);
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 16 }));
      expect(response.status).toBe(400);
    });

    it("DB_DRIVER=pg: 所有権確認 + UPDATE が正しいテーブル/条件/値で実行され、戻り値が postgrest 経路と一致する", async () => {
      const OWNED_STREAMER = { id: "streamer-id-1", raid_gacha_active_until: null, raid_gacha_draw_count: 0 };
      const UPDATED = { raid_gacha_active_until: null, raid_gacha_draw_count: 7 };

      vi.stubEnv("DB_DRIVER", undefined);
      const supabase = createStreamersSupabaseMock({ data: OWNED_STREAMER, error: null }, { data: UPDATED, error: null });
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabase as any);
      const { POST: postgrestPOST } = await loadRoute();
      const postgrestResponse = await postgrestPOST(postRequest({ drawCount: 7 }));
      const postgrestBody = await postgrestResponse.json();

      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNED_STREAMER] }],
        updates: [{ rows: [UPDATED] }],
      });
      primePgDb(pg);
      const { POST: pgPOST } = await loadRoute();
      const pgResponse = await pgPOST(postRequest({ drawCount: 7 }));
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(postgrestResponse.status);
      expect(pgBody).toEqual(postgrestBody);
      expect(getDb).toHaveBeenCalled();
      expect(pg.updateCalls[0].set).toEqual({ raid_gacha_draw_count: 7 });
      expect(pg.updateCalls[0].where).toEqual(eq(streamersTable.id, "streamer-id-1"));
    });

    it("DB_DRIVER=pg-read (書き込みは postgrest のまま): POST の UPDATE は getDb を呼ばない", async () => {
      vi.stubEnv("DB_DRIVER", "pg-read");
      const pg = createDrizzleDbMock({ selects: [{ rows: [{ id: "streamer-id-1", raid_gacha_active_until: null, raid_gacha_draw_count: 0 }] }] });
      primePgDb(pg);
      const supabase = createStreamersSupabaseMock(
        { data: null, error: null },
        { data: { raid_gacha_active_until: null, raid_gacha_draw_count: 2 }, error: null }
      );
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabase as any);

      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 2 }));

      expect(response.status).toBe(200);
      // 所有権確認(読み取り)は pg-read で pg 経由、UPDATE(書き込み)は postgrest 経由
      expect(getDb).toHaveBeenCalledTimes(1);
      expect(supabase.update).toHaveBeenCalled();
    });

    it("DB_DRIVER=pg: streamerが見つからなければ両経路とも404", async () => {
      vi.stubEnv("DB_DRIVER", "pg");
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 1 }));
      expect(response.status).toBe(404);
    });
  });
});
