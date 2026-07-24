/**
 * #663: レイドガチャAPIのPlanetScale回帰テスト
 *
 * 対象: GET/POST /api/streamer/raid-gacha
 * 認証・境界値・所有権・更新の契約をPlanetScale経路で固定する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getDb } from "@/lib/db/client";
import { streamers as streamersTable } from "@/lib/db/schema";

vi.mock("@/lib/session");
vi.mock("@/lib/csrf");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

describe("streamer/raid-gacha: PlanetScale契約 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(STREAMER_SESSION as any);
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 } as any);
    mockGetRateLimitIdentifier.mockResolvedValue("user:streamer1");
    mockValidateCSRFToken.mockResolvedValue({ valid: true } as any);
  });

  describe("GET", () => {
    it("401 (未認証)", async () => {
      mockGetSession.mockResolvedValue(null);
      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      expect(response.status).toBe(401);
    });

    it("設定済みfixtureを公開レスポンスへ正規化する", async () => {
      const FIXTURE = { id: "streamer-id-1", raid_gacha_active_until: "2999-01-01T00:00:00.000+00:00", raid_gacha_draw_count: 5 };

      const pg = createDrizzleDbMock({ selects: [{ rows: [FIXTURE] }] });
      primePgDb(pg);
      const { GET: pgGET } = await loadRoute();
      const pgResponse = await pgGET(getRequest());
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(200);
      expect(pgBody).toEqual({ active: true, activeUntil: FIXTURE.raid_gacha_active_until, drawCount: 5 });
      expect(getDb).toHaveBeenCalled();
      expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.twitch_user_id, "streamer1"));
    });

    it("streamerが見つからなければ404", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      expect(response.status).toBe(404);
    });

    it("raid列欠落エラー時は列を落としてフォールバックし、デフォルト値を返す", async () => {
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
    it("drawCount が範囲外なら400", async () => {
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 16 }));
      expect(response.status).toBe(400);
    });

    it("所有権確認 + UPDATE が正しいテーブル/条件/値で実行される", async () => {
      const OWNED_STREAMER = { id: "streamer-id-1", raid_gacha_active_until: null, raid_gacha_draw_count: 0 };
      const UPDATED = { raid_gacha_active_until: null, raid_gacha_draw_count: 7 };

      const pg = createDrizzleDbMock({
        selects: [{ rows: [OWNED_STREAMER] }],
        updates: [{ rows: [UPDATED] }],
      });
      primePgDb(pg);
      const { POST: pgPOST } = await loadRoute();
      const pgResponse = await pgPOST(postRequest({ drawCount: 7 }));
      const pgBody = await pgResponse.json();

      expect(pgResponse.status).toBe(200);
      expect(pgBody).toEqual({ success: true, active: false, activeUntil: null, drawCount: 7 });
      expect(getDb).toHaveBeenCalled();
      expect(pg.updateCalls[0].set).toEqual({ raid_gacha_draw_count: 7 });
      expect(pg.updateCalls[0].where).toEqual(eq(streamersTable.id, "streamer-id-1"));
    });

    it("streamerが見つからなければ404", async () => {
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
      primePgDb(pg);

      const { POST } = await loadRoute();
      const response = await POST(postRequest({ drawCount: 1 }));
      expect(response.status).toBe(404);
    });
  });
});
