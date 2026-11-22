import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

/**
 * #2079: ハブの「コレクション別出品」の読み取り。
 *
 * ここでは Drizzle をモックして、生成される SQL の形（配置先ごとの
 * ROW_NUMBER / COUNT / MAX、rn <= 5 の SQL 内絞り込み、クロスの2配置）と
 * DTO の組み立てを固定する。実データでの可視性は既存の
 * tests/integration/trade-visibility-pg.test.ts と同じ規則を使うため、
 * ここでは条件が既存の共通関数から出ていることを SQL で確認する。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function render(fragment: unknown) {
  return new PgDialect().sqlToQuery(drizzleSql`${fragment as SQL}`);
}

type SelectCall = {
  fields: Record<string, unknown>;
  from?: unknown;
  where?: unknown;
  leftJoins: Array<{ table: unknown; on: unknown }>;
  innerJoins: Array<{ table: unknown; on: unknown }>;
  orderBy?: unknown[];
  alias?: string;
  union?: SelectCall;
};

type FinalResolver = (call: SelectCall) => unknown[];

/**
 * Minimal Drizzle select/union builder. The production code builds:
 *
 *   select(branch1).where(...).unionAll(select(branch2).where(...)).as(...)
 *     -> select(ranked fields).from(placed).as(...)
 *       -> select(final fields).from(ranked).innerJoin(...).where(...)
 *
 * Only the last select is awaited, so only calls that define `then` resolve.
 * `as()` returns SQL identifiers for the selected fields, which is enough for
 * the window expressions and the outer predicates to be rendered by PgDialect.
 */
function createDbMock(resolveFinal: FinalResolver) {
  const selectCalls: SelectCall[] = [];
  const select = vi.fn((fields: Record<string, unknown>) => {
    const call: SelectCall = { fields, leftJoins: [], innerJoins: [] };
    selectCalls.push(call);
    const builder: Record<string, unknown> & { __call: SelectCall } = {
        __call: call,
        from: vi.fn((table: unknown) => {
          call.from = table;
          return builder;
        }),
        where: vi.fn((where: unknown) => {
          call.where = where;
          return builder;
        }),
        leftJoin: vi.fn((table: unknown, on: unknown) => {
          call.leftJoins.push({ table, on });
          return builder;
        }),
        innerJoin: vi.fn((table: unknown, on: unknown) => {
          call.innerJoins.push({ table, on });
          return builder;
        }),
        orderBy: vi.fn((...orderBy: unknown[]) => {
          call.orderBy = orderBy;
          return builder;
        }),
        unionAll: vi.fn((other: { __call?: SelectCall }) => {
          call.union = other.__call;
          return builder;
        }),
        as: vi.fn((alias: string) => {
          call.alias = alias;
          return Object.fromEntries(
            Object.keys(fields).map((key) => [
              key,
              drizzleSql`${drizzleSql.identifier(alias)}.${drizzleSql.identifier(key)}`,
            ]),
          );
        }),
        then: (onFulfilled: never, onRejected: never) =>
          Promise.resolve(resolveFinal(call)).then(onFulfilled, onRejected),
    };
    return builder;
  });
  // getCollectedStreamerIds uses selectDistinct; the builder is identical.
  const db = { select, selectDistinct: select };
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);
  return { db, selectCalls };
}

const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COLLECTION_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";
const OFFER_ID = "44444444-4444-4444-8444-444444444444";
const OFFERED_CARD_ID = "55555555-5555-4555-8555-555555555555";
const WANTED_CARD_ID = "66666666-6666-4666-8666-666666666666";
const SECRET = "https://secret.example/wanted.png";

const COLLECTION = {
  id: COLLECTION_ID,
  twitchUsername: "collection",
  twitchDisplayName: "Collection",
  twitchProfileImageUrl: null,
};
const OTHER_COLLECTION = { ...COLLECTION, id: OTHER_COLLECTION_ID, twitchDisplayName: "Other" };
const OFFERER = {
  id: VIEWER_ID,
  twitchUsername: "viewer",
  twitchDisplayName: "Viewer",
  twitchProfileImageUrl: null,
};
const NO_USER = { id: null, twitchUsername: null, twitchDisplayName: null, twitchProfileImageUrl: null };

const OFFER = {
  id: OFFER_ID,
  offerer_user_id: OFFERER.id,
  offered_user_card_id: "77777777-7777-4777-8777-777777777777",
  offered_card_id: OFFERED_CARD_ID,
  offered_streamer_id: COLLECTION_ID,
  wanted_card_id: WANTED_CARD_ID,
  wanted_streamer_id: OTHER_COLLECTION_ID,
  offered_card_snapshot: { name: "Offered", rarity: "rare", imageUrl: "https://example.test/offered.png" },
  wanted_card_snapshot: { name: "Wanted", rarity: "mythic", imageUrl: SECRET },
  wanted_quantity: 1,
  is_cross_channel: true,
  status: "open",
  accepted_by_user_id: null,
  accepted_user_card_id: null,
  completed_at: null,
  request_id: "88888888-8888-4888-8888-888888888888",
  accepted_request_id: null,
  created_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
};

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    offer: OFFER,
    viewerUserId: VIEWER_ID,
    offeredStreamer: COLLECTION,
    wantedStreamer: OTHER_COLLECTION,
    offerer: OFFERER,
    acceptedBy: NO_USER,
    acceptState: "yes",
    placement: COLLECTION,
    placementStreamerId: COLLECTION_ID,
    rn: 1,
    total: 1,
    latestCreatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function auctionRow(overrides: Record<string, unknown> = {}) {
  return {
    auction: {
      id: "99999999-9999-4999-8999-999999999999",
      seller_user_id: OFFERER.id,
      offered_user_card_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      offered_card_id: OFFERED_CARD_ID,
      offered_streamer_id: COLLECTION_ID,
      offered_card_snapshot: { name: "Auction card", rarity: "rare", imageUrl: null },
      ends_at: "2026-10-05T00:00:00.000Z",
      selection_deadline: "2026-10-08T00:00:00.000Z",
      status: "open",
      winning_bid_id: null,
      request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      settle_request_id: null,
      completed_at: null,
      created_at: "2026-10-03T00:00:00.000Z",
      updated_at: "2026-10-03T00:00:00.000Z",
    },
    phase: "bidding",
    bidCount: 2,
    viewerUserId: VIEWER_ID,
    myBid: null,
    seller: OFFERER,
    offeredStreamer: COLLECTION,
    placement: COLLECTION,
    placementStreamerId: COLLECTION_ID,
    rn: 1,
    total: 3,
    latestCreatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseTradeCollectionSort (#2079)", () => {
  it("accepts only newest | ending_soon and falls back to newest", async () => {
    const { parseTradeCollectionSort } = await import("@/lib/trade");
    expect(parseTradeCollectionSort("newest")).toBe("newest");
    expect(parseTradeCollectionSort("ending_soon")).toBe("ending_soon");
    expect(parseTradeCollectionSort("rarity")).toBe("newest");
    expect(parseTradeCollectionSort("")).toBe("newest");
    expect(parseTradeCollectionSort(undefined)).toBe("newest");
    expect(parseTradeCollectionSort(["ending_soon", "newest"])).toBe("newest");
  });
});

describe("listTradeOffersByCollection (#2079)", () => {
  it("uses ONE union query with both cross placements, the shared visibility/gates, and rn <= 5 in SQL", async () => {
    const pg = createDbMock(() => []);

    const { listTradeOffersByCollection, TRADE_COLLECTION_PREVIEW_SIZE } = await import("@/lib/trade");
    await listTradeOffersByCollection({ twitchUserId: "viewer-1" });

    const baseCalls = pg.selectCalls.filter(
      (call) => "offerId" in call.fields && "createdAt" in call.fields && !("rn" in call.fields),
    );
    expect(baseCalls).toHaveLength(2);
    const [offeredBranch, wantedBranch] = baseCalls;
    expect(render(offeredBranch.fields.placementStreamerId).sql).toContain(
      '"trade_offers"."offered_streamer_id"',
    );
    expect(render(wantedBranch.fields.placementStreamerId).sql).toContain(
      '"trade_offers"."wanted_streamer_id"',
    );
    expect(wantedBranch.union).toBeUndefined();
    // The two branches are combined with UNION ALL by the first select.
    expect(offeredBranch.union).toBe(wantedBranch);

    const offeredWhere = render(offeredBranch.where).sql;
    const wantedWhere = render(wantedBranch.where).sql;
    for (const where of [offeredWhere, wantedWhere]) {
      expect(where).toContain("collected_owned");
      expect(where).toContain("collected_card.streamer_id");
      expect(where).toContain('visible_card.id = "trade_offers"."offered_card_id"');
      expect(where).toContain('visible_card.id = "trade_offers"."wanted_card_id"');
      expect(where).toContain("trade_gate.trade_enabled = TRUE");
      expect(where).toContain("wantable_card.trade_wantable = TRUE");
      expect(where).toContain("active_card.id = \"trade_offers\".\"offered_card_id\"");
      // Cross-channel offers need both channels' cross flag; in-channel
      // offers do not (same shared predicate as the board).
      expect(where).toContain("cross_gate.cross_channel_trade_enabled = TRUE");
      expect(where).toContain('"trade_offers"."is_cross_channel" IS NOT TRUE');
    }
    // The wanted placement exists only for cross offers, and the inequality
    // prevents the same offer being counted twice if malformed data marks a
    // same-streamer offer as cross-channel.
    expect(wantedWhere).toContain('"trade_offers"."is_cross_channel" = $');
    expect(wantedWhere).toContain(
      '"trade_offers"."wanted_streamer_id" <> "trade_offers"."offered_streamer_id"',
    );
    // The offered branch does not require is_cross_channel (in-channel offers too).
    expect(offeredWhere).not.toContain('"trade_offers"."is_cross_channel" = $');

    const ranked = pg.selectCalls.find((call) => "rn" in call.fields);
    expect(ranked).toBeDefined();
    // Window fields are SQL.Aliased in the ranked subquery (`.as("rn")`),
    // so inspect the underlying SQL rather than the outer alias reference.
    const rn = render((ranked!.fields.rn as { sql: SQL }).sql).sql;
    expect(rn).toMatch(/row_number\(\) OVER \(\s*PARTITION BY/);
    expect(rn).toContain("ORDER BY");
    expect(rn).toContain("DESC");
    expect(render((ranked!.fields.total as { sql: SQL }).sql).sql).toMatch(/count\(\*\) OVER \(\s*PARTITION BY/);
    expect(render((ranked!.fields.latestCreatedAt as { sql: SQL }).sql).sql).toContain("max(");

    // rn <= 5 is part of the outer SQL, not a TypeScript slice.
    const finalCall = pg.selectCalls.find((call) => "acceptState" in call.fields);
    expect(finalCall).toBeDefined();
    expect(render(finalCall!.where).sql).toMatch(/"rn" <= \$/);
    // The preview size is a named constant shared with the auction list.
    expect(render(finalCall!.where).params).toContain(TRADE_COLLECTION_PREVIEW_SIZE);
    expect(finalCall!.orderBy).toBeDefined();
  });

  it("normalizes the raw MAX(timestamptz) value (Date from postgres.js) to an ISO string", async () => {
    const latest = new Date("2026-10-04T00:00:00.000Z");
    createDbMock((call) => ("offer" in call.fields ? [offerRow({ latestCreatedAt: latest })] : []));

    const { listTradeOffersByCollection } = await import("@/lib/trade");
    const groups = await listTradeOffersByCollection({ twitchUserId: "viewer-1" });

    // Drizzle's raw SQL does not run the column decoder, so a driver can hand
    // back a Date. The service must hand the UI a string that Date.parse can
    // read (timeOf in trade-collections.ts).
    expect(groups[0].latestCreatedAt).toBe(latest.toISOString());
    expect(Number.isNaN(Date.parse(groups[0].latestCreatedAt))).toBe(false);
  });

  it("returns the total and the first rows with wanted-side images masked", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      offerRow({
        offer: { ...OFFER, offerer_user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        rn: index + 1,
        total: 7,
        latestCreatedAt: "2026-10-04T00:00:00.000Z",
      }),
    );
    createDbMock((call) => {
      if ("offer" in call.fields) return rows;
      // The image mask query: deny everything, so the secret URL cannot leak.
      return [];
    });

    const { listTradeOffersByCollection } = await import("@/lib/trade");
    const groups = await listTradeOffersByCollection({
      twitchUserId: "viewer-1",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(7);
    expect(groups[0].offers).toHaveLength(5);
    expect(groups[0].latestCreatedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(groups[0].offers[0].wantedCard).toEqual({
      // マスククエリが空 = deny-by-default。名前も画像も番号も証明できない。
      name: "",
      rarity: "mythic",
      imageUrl: null,
      collectionNumber: null,
    });
    expect(groups[0].offers[0].offeredCard.imageUrl).toBeNull();
    expect(JSON.stringify(groups[0].offers)).not.toContain(SECRET);
    // canAccept rides along with the list so the existing accept modal works.
    expect(groups[0].offers[0].canAccept).toBe("yes");
    // /mine-only flags are not introduced here.
    expect(groups[0].offers[0]).not.toHaveProperty("tradeable");
  });


  it("masks each side independently: a wanted-side image may stay when the offered side is hidden", async () => {
    createDbMock((call) => {
      if ("offer" in call.fields) return [offerRow({ total: 1 })];
      // The mask query is evaluated per card id by maskTradeCards. Return the
      // wanted card as visible: the wanted snapshot (owned/revealed by its own
      // streamer) keeps its name/image, while the offered side is nulled.
      return [{
        cardId: WANTED_CARD_ID,
        streamerId: OTHER_COLLECTION_ID,
        nameVisible: true,
        imageVisible: true,
      }];
    });

    const { listTradeOffersByCollection } = await import("@/lib/trade");
    const groups = await listTradeOffersByCollection({ twitchUserId: "viewer-1" });

    expect(groups[0].offers[0].wantedCard.imageUrl).toBe(SECRET);
    expect(groups[0].offers[0].offeredCard.imageUrl).toBeNull();
    // The name-level visibility is decided by the list SQL, not by the mask.
    expect(groups[0].offers[0].wantedCard.name).toBe("Wanted");
  });

  it("places a cross offer under BOTH owned collections, once per placement", async () => {
    const rows = [
      offerRow({ placement: COLLECTION, placementStreamerId: COLLECTION_ID, total: 1 }),
      offerRow({ placement: OTHER_COLLECTION, placementStreamerId: OTHER_COLLECTION_ID, total: 1 }),
    ];
    createDbMock((call) => ("offer" in call.fields ? rows : []));

    const { listTradeOffersByCollection } = await import("@/lib/trade");
    const groups = await listTradeOffersByCollection({ twitchUserId: "viewer-1" });

    expect(groups.map((group) => group.streamer.id)).toEqual([
      COLLECTION_ID,
      OTHER_COLLECTION_ID,
    ]);
    for (const group of groups) {
      expect(group.total).toBe(1);
      expect(group.offers.map((offer) => offer.id)).toEqual([OFFER_ID]);
    }
  });

  it("uses rn ranges for an expanded collection page (TRADE_PAGE_SIZE rows)", async () => {
    const pg = createDbMock((call) => ("offer" in call.fields ? [offerRow({ rn: 21, total: 41 })] : []));

    const { listTradeOffersByCollection } = await import("@/lib/trade");
    const groups = await listTradeOffersByCollection({
      twitchUserId: "viewer-1",
      streamerId: COLLECTION_ID,
      page: 2,
    });

    expect(groups[0].offers).toHaveLength(1);
    const finalCall = pg.selectCalls.find((call) => "acceptState" in call.fields);
    const where = render(finalCall!.where).sql;
    // page 2 of TRADE_PAGE_SIZE = 20 → rn in (20, 40].
    expect(where).toMatch(/"rn" > \$/);
    expect(where).toMatch(/"rn" <= \$/);
    const params = render(finalCall!.where).params;
    expect(params).toContain(20);
    expect(params).toContain(40);
    expect(where).toContain('"ranked_collection_offers"."placementStreamerId" = $');
  });

  it("keeps offers in newest order (the deadline sort only applies to auctions)", async () => {
    const pg = createDbMock(() => []);
    const { listTradeOffersByCollection } = await import("@/lib/trade");
    await listTradeOffersByCollection({ twitchUserId: "viewer-1" });
    const ranked = pg.selectCalls.find((call) => "rn" in call.fields);
    const rn = render((ranked!.fields.rn as { sql: SQL }).sql).sql;
    expect(rn).toContain("DESC");
    expect(rn).not.toContain("ASC");
  });
});



describe("listTradeCollections merge (#2079)", () => {
  it("combines offers and auctions of one collection and keeps the latest created_at", async () => {
    createDbMock((call) => {
      if ("offer" in call.fields) {
        return [offerRow({ total: 2, latestCreatedAt: "2026-10-04T00:00:00.000Z" })];
      }
      if ("auction" in call.fields) {
        return [auctionRow({ total: 1, latestCreatedAt: "2026-10-05T00:00:00.000Z" })];
      }
      return [];
    });
    const { listTradeCollections } = await import("@/lib/trade-collections");

    const sections = await listTradeCollections({ twitchUserId: "viewer-1", sort: "newest" });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      streamer: { id: COLLECTION_ID },
      offerTotal: 2,
      auctionTotal: 1,
      latestCreatedAt: "2026-10-05T00:00:00.000Z",
    });
    expect(sections[0].offers).toHaveLength(1);
    expect(sections[0].auctions).toHaveLength(1);
  });
});

describe("listTradeCollectionPage ownership (#2079)", () => {
  it("returns null when the viewer does not own the collection (API → 404)", async () => {
    createDbMock((call) => {
      if ("streamerId" in call.fields) return [];
      return [];
    });
    const { listTradeCollectionPage } = await import("@/lib/trade-collections");

    await expect(listTradeCollectionPage({
      twitchUserId: "viewer-1",
      streamerId: COLLECTION_ID,
      kind: "offer",
      sort: "newest",
      page: 1,
    })).resolves.toBeNull();
  });

  it("returns an empty page (not 404) when the collection is owned but has no rows", async () => {
    createDbMock((call) => {
      if ("streamerId" in call.fields) return [{ streamerId: COLLECTION_ID }];
      return [];
    });
    const { listTradeCollectionPage } = await import("@/lib/trade-collections");

    await expect(listTradeCollectionPage({
      twitchUserId: "viewer-1",
      streamerId: COLLECTION_ID,
      kind: "auction",
      sort: "ending_soon",
      page: 1,
    })).resolves.toEqual({
      kind: "auction",
      streamer: null,
      auctions: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });
});

describe("listTradeAuctionsByCollection (#2079)", () => {
  it("partitions by the offered streamer and orders by ends_at only for ending_soon", async () => {
    const pg = createDbMock((call) => ("auction" in call.fields ? [auctionRow()] : []));
    const { listTradeAuctionsByCollection } = await import("@/lib/trade-auction");

    const groups = await listTradeAuctionsByCollection({
      twitchUserId: "viewer-1",
      sort: "ending_soon",
    });

    const base = pg.selectCalls.find((call) => "auctionId" in call.fields);
    expect(base).toBeDefined();
    expect(render(base!.fields.placementStreamerId).sql).toContain(
      '"trade_auctions"."offered_streamer_id"',
    );
    const rn = render((base!.fields.rn as { sql: SQL }).sql).sql;
    expect(rn).toMatch(/row_number\(\) OVER \(\s*PARTITION BY/);
    // Bidding auctions first (the bucket is false before true), then the
    // soonest deadline. Selecting auctions follow, most recently ended first.
    expect(rn).toContain('("trade_auctions"."ends_at" <= clock_timestamp()) ASC');
    expect(rn).toMatch(
      /CASE WHEN \("trade_auctions"\."ends_at" <= clock_timestamp\(\)\) THEN "trade_auctions"\."ends_at" END DESC/,
    );
    expect(rn).toMatch(
      /CASE WHEN "trade_auctions"\."ends_at" > clock_timestamp\(\) THEN "trade_auctions"\."ends_at" END ASC/,
    );
    expect(render(base!.where).sql).toContain("collected_card.streamer_id");
    expect(render(base!.where).sql).toContain("trade_auction_holds_cards");

    const finalCall = pg.selectCalls.find((call) => "auction" in call.fields);
    expect(render(finalCall!.where).sql).toMatch(/"rn" <= \$/);
    expect(groups[0].total).toBe(3);
  });

  it("normalizes the auction MAX(timestamptz) value to an ISO string", async () => {
    const latest = new Date("2026-10-03T00:00:00.000Z");
    createDbMock((call) => ("auction" in call.fields ? [auctionRow({ latestCreatedAt: latest })] : []));

    const { listTradeAuctionsByCollection } = await import("@/lib/trade-auction");
    const groups = await listTradeAuctionsByCollection({ twitchUserId: "viewer-1", sort: "newest" });

    expect(groups[0].latestCreatedAt).toBe(latest.toISOString());
    expect(Number.isNaN(Date.parse(groups[0].latestCreatedAt))).toBe(false);
  });

  it("uses created_at DESC for the newest sort", async () => {
    const pg = createDbMock((call) => ("auction" in call.fields ? [auctionRow()] : []));
    const { listTradeAuctionsByCollection } = await import("@/lib/trade-auction");
    await listTradeAuctionsByCollection({ twitchUserId: "viewer-1", sort: "newest" });
    const base = pg.selectCalls.find((call) => "auctionId" in call.fields);
    const rn = render((base!.fields.rn as { sql: SQL }).sql).sql;
    expect(rn).toContain('"trade_auctions"."created_at" DESC');
    expect(rn).not.toContain('"trade_auctions"."ends_at" ASC');
  });
});

describe("collection ordering (#2079)", () => {
  it("sorts by the latest listing created_at DESC, then streamer id ASC", async () => {
    const { sortTradeCollectionSections } = await import("@/lib/trade-collections");
    const sections = [
      { streamer: { id: "b" }, latestCreatedAt: "2026-10-04T00:00:00.000Z" },
      { streamer: { id: "a" }, latestCreatedAt: "2026-10-04T00:00:00.000Z" },
      { streamer: { id: "c" }, latestCreatedAt: "2026-10-05T00:00:00.000Z" },
      { streamer: { id: "d" }, latestCreatedAt: "2026-10-03T00:00:00.000Z" },
    ];

    expect(
      sortTradeCollectionSections(sections).map((section) => section.streamer.id),
    ).toEqual(["c", "a", "b", "d"]);
  });
});
