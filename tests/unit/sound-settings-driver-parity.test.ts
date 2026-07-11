/**
 * #663: 低頻度APIルート群のpg直結移行 — 配信者効果音設定(公開エンドポイント)の
 * postgrest経路 / pg経路パリティテスト
 *
 * 対象: GET /api/streamer/[streamerId]/sound-settings（認証不要の公開API）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { streamers as streamersTable } from "@/lib/db/schema";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
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

function createSoundSettingsSupabaseMock(response: { data: unknown; error: unknown; status?: number }) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(response),
  };
  return { from: vi.fn(() => query), query };
}

async function loadRoute() {
  const mod = await import("@/app/api/streamer/[streamerId]/sound-settings/route");
  return mod.GET;
}

function request() {
  return new NextRequest("http://localhost:3000/api/streamer/streamer-1/sound-settings");
}

describe("GET /api/streamer/[streamerId]/sound-settings: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("フラグ未設定時は getDb が呼ばれない（挙動不変の検証）", async () => {
    vi.stubEnv("DB_DRIVER", undefined);
    const mockSupabase = createSoundSettingsSupabaseMock({
      data: { gacha_sound_url: "https://cdn.example.com/sound.mp3", gacha_sound_enabled: true, gacha_sound_rules: [] },
      error: null,
      status: 200,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

    const GET = await loadRoute();
    const response = await GET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });

    expect(response.status).toBe(200);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("DB_DRIVER=pg-read: 同一fixtureで両経路の戻り値が一致する", async () => {
    const FIXTURE = { gacha_sound_url: "https://cdn.example.com/sound.mp3", gacha_sound_enabled: true, gacha_sound_rules: [] };

    vi.stubEnv("DB_DRIVER", undefined);
    const client = createSoundSettingsSupabaseMock({ data: FIXTURE, error: null, status: 200 });
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);
    const postgrestGET = await loadRoute();
    const postgrestResponse = await postgrestGET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });
    const postgrestBody = await postgrestResponse.json();

    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({ selects: [{ rows: [FIXTURE] }] });
    primePgDb(pg);
    const pgGET = await loadRoute();
    const pgResponse = await pgGET(request(), { params: Promise.resolve({ streamerId: "streamer-1" }) });
    const pgBody = await pgResponse.json();

    expect(pgResponse.status).toBe(postgrestResponse.status);
    expect(pgBody).toEqual(postgrestBody);
    expect(getDb).toHaveBeenCalled();
    expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.id, "streamer-1"));
  });

  it("DB_DRIVER=pg-read: streamerが見つからなければ両経路とも404", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] });
    primePgDb(pg);

    const GET = await loadRoute();
    const response = await GET(request(), { params: Promise.resolve({ streamerId: "missing-streamer" }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Streamer not found" });
  });

  it("DB_DRIVER=pg-read: gacha_sound_rules列欠落エラーからのフォールバックが両経路で一致する", async () => {
    const LEGACY_FIXTURE = { gacha_sound_url: "https://cdn.example.com/legacy.mp3", gacha_sound_enabled: true };

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

  it("DB_DRIVER=pg-read: 未分類のDBエラーは両経路とも安全側デフォルト（効果音無効）に落ちる", async () => {
    vi.stubEnv("DB_DRIVER", "pg-read");
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
