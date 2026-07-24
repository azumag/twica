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

describe("recalculateIfAutoMode PlanetScale transaction consistency (#794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads, updates, and re-reads cards only from PlanetScale", async () => {

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

    const result = await recalculateIfAutoMode(
      "streamer-1",
      { common: 100 }
    );

    expect(result).toEqual(recalculatedCards);
    expect(pg.select).toHaveBeenCalledTimes(2);
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
