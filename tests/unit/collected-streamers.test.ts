import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

/**
 * #2079: "持っているコレクション" の単一の定義。
 *
 * /dashboard/collection と /trade のコレクション別一覧が同じ結果になるよう、
 * user_cards → cards の所有関係を1か所（collected-streamers.ts）に閉じ込める。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

function render(fragment: unknown) {
  return new PgDialect().sqlToQuery(drizzleSql`${fragment as SQL}`);
}

function prime(rows: unknown[]) {
  const calls: Array<{ fields: Record<string, unknown>; where?: unknown }> = [];
  const db = {
    selectDistinct: vi.fn((fields: Record<string, unknown>) => {
      const call = { fields, where: undefined as unknown };
      calls.push(call);
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn((where: unknown) => {
          call.where = where;
          return builder;
        }),
        then: (ok: never, bad: never) => Promise.resolve(rows).then(ok, bad),
      };
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCollectedStreamerIds (#2079)", () => {
  it("returns the distinct streamers whose cards the viewer owns, using user_cards → cards", async () => {
    const calls = prime([{ streamerId: "streamer-a" }, { streamerId: "streamer-b" }]);
    const { getCollectedStreamerIds } = await import("@/lib/collected-streamers");

    const result = await getCollectedStreamerIds("twitch-user-1");

    expect(result).toEqual(new Set(["streamer-a", "streamer-b"]));
    expect(calls).toHaveLength(1);
    const where = render(calls[0].where).sql;
    expect(where).toContain("collected_owned");
    expect(where).toContain("collected_user.twitch_user_id");
    expect(where).toContain("collected_card.streamer_id");
    expect(where).toContain("collected_card.id = collected_owned.card_id");
  });

  it("can restrict the same definition to one streamer", async () => {
    const calls = prime([{ streamerId: "streamer-a" }]);
    const { getCollectedStreamerIds } = await import("@/lib/collected-streamers");

    const result = await getCollectedStreamerIds("twitch-user-1", "streamer-a");

    expect(result).toEqual(new Set(["streamer-a"]));
    expect(render(calls[0].where).params).toContain("streamer-a");
  });
});
