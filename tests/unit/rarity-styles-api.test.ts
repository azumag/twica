import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/streamer/[streamerId]/rarity-styles/route";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { streamers as streamersTable } from "@/lib/db/schema";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/**
 * 公開routeが使うDrizzleのselect/from/where/limitチェインを再現する。
 * sound-settings と同じく所有者ではなく streamer ID そのものを問い合わせる
 * パブリックAPIなので、対象行の有無とDB例外だけを注入する。
 */
function primeRarityStylesDb(response: { row?: { rarity_styles: unknown }; error?: unknown }) {
  const selectCalls: Array<{ where?: unknown }> = [];
  const select = vi.fn((fields: Record<string, unknown>) => {
    const call: { where?: unknown } = {};
    selectCalls.push(call);
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn((condition: unknown) => {
        call.where = condition;
        return builder;
      }),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
        if (response.error) return Promise.reject(response.error).then(resolve, reject);
        const rows = response.row
          ? [Object.fromEntries(Object.keys(fields).map((key) => [key, response.row?.[key as keyof typeof response.row] ?? null]))]
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
  return { select, selectCalls };
}

const STREAMER_ID = "123e4567-e89b-42d3-a456-426614174000";

function request(streamerId = STREAMER_ID) {
  return new NextRequest(`http://localhost:3000/api/streamer/${streamerId}/rarity-styles`);
}

/** デプロイ窓（列未作成）を再現する SQLSTATE 42703。 */
function missingColumnError(column: string) {
  return Object.assign(new Error(`column "${column}" does not exist`), { code: "42703" });
}

describe("GET /api/streamer/[streamerId]/rarity-styles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("保存済みのスタイルを返し、edge cache 用ヘッダを付ける", async () => {
    const stored = { mythic: { color: "#ff0000" } };
    const pg = primeRarityStylesDb({ row: { rarity_styles: stored } });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=1");
    expect(response.headers.get("Cache-Tag")).toBe(`rarity-styles-${STREAMER_ID}`);
    await expect(response.json()).resolves.toEqual({ rarityStyles: stored });
    // 誤った列・誤ったキーで引かないことを固定する（sound-settings の同種テストに倣う）。
    expect(pg.selectCalls[0].where).toEqual(eq(streamersTable.id, STREAMER_ID));
  });

  it("未設定（{}）でも 200 で空マップを返す", async () => {
    primeRarityStylesDb({ row: { rarity_styles: {} } });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rarityStyles: {} });
  });

  it.each([
    ["配列", []],
    ["文字列", "unexpected"],
    ["null", null],
  ])("JSONB が %s でも空マップへ正規化する", async (_label, value) => {
    primeRarityStylesDb({ row: { rarity_styles: value } });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rarityStyles: {} });
  });

  it("rarity_styles 列が未デプロイ（42703）なら空マップへ縮退する", async () => {
    primeRarityStylesDb({ error: missingColumnError("rarity_styles") });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=1");
    await expect(response.json()).resolves.toEqual({ rarityStyles: {} });
  });

  it("別列の欠落（42703）や接続障害はキャッシュ不可の空マップへ縮退する", async () => {
    primeRarityStylesDb({ error: missingColumnError("gacha_sound_url") });

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ rarityStyles: {} });
  });

  it("配信者が存在しなければ 404 を返す", async () => {
    primeRarityStylesDb({});

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: STREAMER_ID }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("streamerId が空なら 400 を返し DB へ問い合わせない", async () => {
    const pg = primeRarityStylesDb({});

    const response = await GET(request(""), {
      params: Promise.resolve({ streamerId: "" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(pg.select).not.toHaveBeenCalled();
  });

  it("UUID 形式でない streamerId は DB へ渡さず 404 にする", async () => {
    // Issue #908: 不正な uuid 文字列は PostgreSQL で 22P02 になる。公開エンドポイントは
    // 誰でも叩けるため、DBアクセスとログを発生させず未登録IDと同じ 404 へ落とす。
    const pg = primeRarityStylesDb({});

    const response = await GET(request("not-a-uuid"), {
      params: Promise.resolve({ streamerId: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(pg.select).not.toHaveBeenCalled();
  });
});
