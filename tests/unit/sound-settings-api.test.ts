import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/streamer/[streamerId]/sound-settings/route";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// rarity-styles と同じく、公開GETの境界は canonical UUID を前提にする（#1334/#908）。
const STREAMER_ID = "123e4567-e89b-42d3-a456-426614174000";

/**
 * 公開routeが使うDrizzleのselect/from/where/limitチェインを再現する。
 * 所有権ではなくstreamer IDそのものを問い合わせるAPIなので、対象行の有無と
 * DB例外だけをfixtureとして注入し、廃止済みPostgREST clientには依存しない。
 */
function primeSoundSettingsDb(response: {
  row?: {
    id?: string;
    gacha_sound_url: string | null;
    gacha_sound_enabled: boolean | null;
    gacha_sound_rules?: unknown;
  };
  error?: unknown;
}) {
  const select = vi.fn((fields: Record<string, unknown>) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
        if (response.error) return Promise.reject(response.error).then(resolve, reject);
        const rows = response.row
          ? [
              Object.fromEntries(
                Object.keys(fields).map((key) => [
                  key,
                  key === "id"
                    ? (response.row?.id ?? STREAMER_ID)
                    : (response.row?.[key as keyof typeof response.row] ?? null),
                ])
              ),
            ]
          : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  });
  vi.mocked(getDb).mockResolvedValue({
    db: { select } as never,
    sql: {} as never,
  });
  return {
    select,
  };
}

function request(streamerId = STREAMER_ID) {
  return new NextRequest(`http://localhost:3000/api/streamer/${streamerId}/sound-settings`);
}

describe("GET /api/streamer/[streamerId]/sound-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the configured sound settings with a tag derived from the normalized DB id", async () => {
    const pg = primeSoundSettingsDb({
      row: {
        // DB が返す id（正規化済み）がタグに使われることを固定する（#1334）。
        id: STREAMER_ID,
        gacha_sound_url: "https://cdn.example.com/sound.mp3",
        gacha_sound_enabled: true,
      },
    });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=1");
    expect(response.headers.get("Cache-Tag")).toBe(`sound-settings-${STREAMER_ID}`);
    await expect(response.json()).resolves.toEqual({
      soundUrl: "https://cdn.example.com/sound.mp3",
      soundEnabled: true,
      soundRules: [
        expect.objectContaining({
          targetType: "all",
          url: "https://cdn.example.com/sound.mp3",
          enabled: true,
        }),
      ],
    });
    expect(pg.select).toHaveBeenCalledTimes(1);
  });

  it("keeps missing streamerId as a non-cacheable 400", async () => {
    const response = await GET(request(""), {
      params: Promise.resolve({ streamerId: "" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("rejects non-canonical UUIDs as 404 before DB access (22P02 guard, #1334/#908)", async () => {
    const pg = primeSoundSettingsDb({});

    const response = await GET(request("streamer-1"), {
      params: Promise.resolve({ streamerId: "streamer-1" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Tag")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "Streamer not found" });
    // 不正な UUID を DB の uuid 列へ渡さない（SQLSTATE 22P02 を公開面で起こさない）。
    expect(pg.select).not.toHaveBeenCalled();
  });

  it("keeps unexpected catch responses non-cacheable and untagged", async () => {
    const response = await GET(request(), {
      params: Promise.reject(new Error("params failed")),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("keeps a valid but missing streamer as a non-cacheable 404", async () => {
    primeSoundSettingsDb({});

    const response = await GET(request("123e4567-e89b-42d3-a456-426614174001"), {
      params: Promise.resolve({ streamerId: "123e4567-e89b-42d3-a456-426614174001" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Tag")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "Streamer not found" });
  });

  it("falls back to non-cacheable disabled sound settings when PlanetScale returns a transient connection error", async () => {
    primeSoundSettingsDb({
      error: { code: "08006", message: "connection failure" },
    });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Tag")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      soundUrl: null,
      soundEnabled: false,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
