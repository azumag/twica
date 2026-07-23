import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createPgSelectMock(responses: unknown[][]) {
  let responseIndex = 0;
  const select = vi.fn(() => {
    const rows = responses[responseIndex] ?? [];
    responseIndex += 1;

    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  });

  return { db: { select }, select };
}

function createSqlMock(results: Array<{ updated_count: number }>) {
  let resultIndex = 0;
  return vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = results[resultIndex] ?? results[results.length - 1];
    resultIndex += 1;
    return Promise.resolve([{ result }]);
  });
}

function createPostgrestCardsMock(
  activeCards: unknown[],
  recalculatedCards: unknown[]
) {
  let cardsCallIndex = 0;
  const from = vi.fn((table: string) => {
    expect(table).toBe("cards");
    const result =
      cardsCallIndex === 0
        ? { data: activeCards, error: null }
        : { data: recalculatedCards, error: null };
    cardsCallIndex += 1;

    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.in = vi.fn(() => builder);
    builder.then = (
      resolve: (value: typeof result) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });

  return {
    from,
    rpc: vi.fn().mockResolvedValue({
      data: { updated_count: activeCards.length },
      error: null,
    }),
  };
}

describe("recalculateIfAutoMode DB driver consistency (#794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("postgrest mode keeps all reads and the update RPC on Supabase", async () => {
    const activeCards = [
      {
        id: "card-old",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
      },
      {
        id: "card-new",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
      },
    ];
    const recalculatedCards = [
      { id: "card-old", drop_rate: 0.5 },
      { id: "card-new", drop_rate: 0.5 },
    ];
    const supabaseAdmin = createPostgrestCardsMock(
      activeCards,
      recalculatedCards
    );

    const result = await recalculateIfAutoMode(
      supabaseAdmin as never,
      "streamer-1",
      { common: 100 }
    );

    expect(result).toEqual(recalculatedCards);
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "batch_update_card_drop_rates",
      {
        p_streamer_id: "streamer-1",
        p_updates: [
          { id: "card-old", drop_rate: 0.5 },
          { id: "card-new", drop_rate: 0.5 },
        ],
      }
    );
    expect(getDb).not.toHaveBeenCalled();
  });

  it("pg mode reads, updates, and re-reads cards only from PlanetScale", async () => {
    vi.stubEnv("DB_DRIVER", "pg");

    const activeCards = [
      {
        id: "card-old",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
      },
      {
        id: "card-after-cutover",
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
      },
    ];
    const recalculatedCards = [
      { id: "card-old", drop_rate: 0.5 },
      { id: "card-after-cutover", drop_rate: 0.5 },
    ];
    const pg = createPgSelectMock([activeCards, recalculatedCards]);
    const sql = createSqlMock([{ updated_count: 2 }]);
    vi.mocked(getDb).mockResolvedValue({
      db: pg.db,
      sql,
    } as never);

    const supabaseAdmin = {
      from: vi.fn(() => {
        throw new Error("Supabase cards read must not run in pg mode");
      }),
      rpc: vi.fn(() => {
        throw new Error("Supabase RPC must not run in pg mode");
      }),
    };

    const result = await recalculateIfAutoMode(
      supabaseAdmin as never,
      "streamer-1",
      { common: 100 }
    );

    expect(result).toEqual(recalculatedCards);
    expect(pg.select).toHaveBeenCalledTimes(2);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(sql).toHaveBeenCalledTimes(1);

    const [, ...values] = sql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(values).toEqual([
      "streamer-1",
      JSON.stringify([
        { id: "card-old", drop_rate: 0.5 },
        { id: "card-after-cutover", drop_rate: 0.5 },
      ]),
    ]);
  });
});
