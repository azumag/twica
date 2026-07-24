/**
 * #663: 配信者効果音設定（公開エンドポイント）のPlanetScale回帰テスト
 *
 * 対象: GET /api/streamer/[streamerId]/sound-settings（認証不要の公開API）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { streamers as streamersTable } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface PgResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDrizzleDbMock(config: { selects?: PgResponse[] } = {}) {
  let selectIndex = 0;
  const selectCalls: Array<{ where?: unknown }> = [];

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
  };
  return { db, selectCalls };
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any);
}

async function loadRoute() {
  const mod = await import("@/app/api/streamer/[streamerId]/sound-settings/route");
  return mod.GET;
}

function request() {
  return new NextRequest("http://localhost:3000/api/streamer/streamer-1/sound-settings");
}

describe("GET /api/streamer/[streamerId]/sound-settings: PlanetScale契約 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("設定済みfixtureを公開レスポンスへ正規化する", async () => {
    const FIXTURE = { gacha_sound_url: "https://cdn.example.com/sound.mp3", gacha_sound_enabled: true, gacha_sound_rules: [] };

    const pg = createDrizzleDbMock({ selects: [{ rows: [FIXTURE] }] });
    primePgDb(pg);
    const pgGET = await loadRoute();
    const pgResponse = await pgGET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });
    const pgBody = await pgResponse.json();

    expect(pgResponse.status).toBe(200);
    expect(pgBody).toMatchObject({
      soundUrl: FIXTURE.gacha_sound_url,
      soundEnabled: true,
    });
    expect(getDb).toHaveBeenCalled();
    expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.id, "streamer-1"));
  });

  it("streamerが見つからなければ404", async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
    primePgDb(pg);

    const GET = await loadRoute();
    const response = await GET(request(), { params: Promise.resolve({ streamerId: "missing-streamer" }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Streamer not found" });
  });

  it("gacha_sound_rules列欠落エラーではlegacy列へフォールバックする", async () => {
    const LEGACY_FIXTURE = { gacha_sound_url: "https://cdn.example.com/legacy.mp3", gacha_sound_enabled: true };

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
              // フル select は gacha_sound_rules 列欠落で失敗（pg ネイティブの 42703 相当）
              return Promise.reject({
                code: "42703",
                message: 'column "gacha_sound_rules" of relation "streamers" does not exist',
              }).then(onFulfilled, onRejected);
            }
            return Promise.resolve(
              Object.keys(fields).map(() => LEGACY_FIXTURE)[0]
                ? [Object.fromEntries(Object.keys(fields).map((k) => [k, (LEGACY_FIXTURE as any)[k] ?? null]))]
                : []
            ).then(onFulfilled, onRejected);
          },
        };
        return builder;
      }),
    };
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any);

    const GET = await loadRoute();
    const response = await GET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.soundUrl).toBe("https://cdn.example.com/legacy.mp3");
    expect(body.soundEnabled).toBe(true);
  });

  it("未分類のDBエラーは安全側デフォルト（効果音無効）に落ちる", async () => {
    const pg = createDrizzleDbMock({ selects: [{ error: { code: "08006", message: "connection failure" } }] });
    primePgDb(pg);

    const GET = await loadRoute();
    const response = await GET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ soundUrl: null, soundEnabled: false });
    expect(logger.warn).toHaveBeenCalled();
  });
});
