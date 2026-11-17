import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";

/**
 * #2079: the per-collection reads are the first queries in this codebase that
 * combine a UNION with window functions. The Drizzle mock in
 * trade-collection-list-service.test.ts pins the conditions, but it cannot
 * catch builder-level mistakes such as a raw SQL field in a subquery without
 * an alias (which throws before any SQL is sent). This suite therefore runs
 * the REAL Drizzle query builder against `pg-proxy`, captures the SQL, and
 * asserts the executable shape without a database.
 */
const state = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getDb: state.getDb }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

function primeRealBuilder() {
  const statements: string[] = [];
  const db = drizzle(async (sql) => {
    statements.push(sql);
    return { rows: [] };
  });
  state.getDb.mockResolvedValue({ db, sql: {} });
  return statements;
}

describe("collection list SQL builder (#2079)", () => {
  it("renders the offer UNION + window query without builder errors", async () => {
    const statements = primeRealBuilder();
    const { listTradeOffersByCollection } = await import("@/lib/trade");

    await listTradeOffersByCollection({ twitchUserId: "viewer-1" });

    expect(statements).toHaveLength(1);
    const sql = statements[0];
    expect(sql).toContain("union all");
    expect(sql).toMatch(/row_number\(\) OVER \(\s*PARTITION BY/);
    expect(sql).toMatch(/count\(\*\) OVER \(\s*PARTITION BY/);
    expect(sql).toMatch(/max\("created_at"\) OVER/);
    expect(sql).toContain('"rn" <= $');
    // The union's first branch is the offered placement, the second the
    // cross-channel wanted placement.
    expect(sql).toMatch(/select "id", "offered_streamer_id", "created_at"/);
    expect(sql).toMatch(/select "id", "wanted_streamer_id", "created_at"/);
    // No dangling alias: the ranked subquery is joined back on its id.
    expect(sql).toContain('"trade_offers"."id" = "ranked_collection_offers"."id"');
  });

  it("renders the shared owned-collection lookup", async () => {
    const statements = primeRealBuilder();
    const { getCollectedStreamerIds } = await import("@/lib/collected-streamers");

    await getCollectedStreamerIds("viewer-1", "streamer-a");

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/select distinct "streamer_id" from "cards"/);
    expect(statements[0]).toContain('"cards"."streamer_id" IN');
    expect(statements[0]).toContain("collected_owned");
  });

  it("renders the auction window query with bidding before selecting for ending_soon", async () => {
    const statements = primeRealBuilder();
    const { listTradeAuctionsByCollection } = await import("@/lib/trade-auction");

    await listTradeAuctionsByCollection({ twitchUserId: "viewer-1", sort: "ending_soon" });

    expect(statements).toHaveLength(1);
    const sql = statements[0];
    expect(sql).toMatch(/row_number\(\) OVER \(\s*PARTITION BY/);
    // 入札中（ends_at 前）を先にするバケット。DB 関数と同じ
    // clock_timestamp() で判定する（now() はトランザクション開始時刻で固定）。
    expect(sql).toContain('("trade_auctions"."ends_at" <= clock_timestamp()) ASC');
    // 入札中は締切が近い順（ASC）、選択待ちは直近に終わった順（DESC）。
    expect(sql).toMatch(
      /CASE WHEN \("trade_auctions"\."ends_at" <= clock_timestamp\(\)\) THEN "trade_auctions"\."ends_at" END DESC/,
    );
    expect(sql).toMatch(
      /CASE WHEN "trade_auctions"\."ends_at" > clock_timestamp\(\) THEN "trade_auctions"\."ends_at" END ASC/,
    );
    expect(sql).toContain('"rn" <= $');
    expect(sql).toContain('"trade_auctions"."id" = "ranked_collection_auctions"."id"');
  });
});
