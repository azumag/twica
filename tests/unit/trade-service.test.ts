import { beforeEach, describe, expect, it, vi } from "vitest";

import { getTableName, sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
/** Render a captured Drizzle condition/field to parameterized SQL text. */
function render(fragment: unknown) {
  return new PgDialect().sqlToQuery(drizzleSql`${fragment as SQL}`);
}

vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

interface ResponseStep {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDbMock(config: {
  selects?: ResponseStep[];
  inserts?: ResponseStep[];
  updates?: ResponseStep[];
} = {}) {
  let selectIndex = 0;
  let insertIndex = 0;
  let updateIndex = 0;
  const selectCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  function resolve(step: ResponseStep | undefined) {
    if (step?.error) return Promise.reject(step.error);
    return Promise.resolve(step?.rows ?? []);
  }

  const db: any = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const call: Record<string, unknown> = { fields };
      selectCalls.push(call);
      const step = (config.selects ?? [])[selectIndex++] ?? { rows: [] };
      const builder: any = {
        from: vi.fn((table) => {
          call.from = table;
          return builder;
        }),
        innerJoin: vi.fn((table, on) => {
          call.innerJoin = { table, on };
          return builder;
        }),
        leftJoin: vi.fn((table, on) => {
          const joins = (call.leftJoins as Array<{ table: unknown; on: unknown }> | undefined) ?? [];
          joins.push({ table, on });
          call.leftJoins = joins;
          return builder;
        }),
        where: vi.fn((where) => {
          call.where = where;
          return builder;
        }),
        orderBy: vi.fn((...orderBy) => {
          call.orderBy = orderBy;
          return builder;
        }),
        limit: vi.fn((limit) => {
          call.limit = limit;
          return builder;
        }),
        offset: vi.fn((offset) => {
          call.offset = offset;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve(step).then(onFulfilled, onRejected),
      };
      return builder;
    }),
    insert: vi.fn((table) => {
      const call: Record<string, unknown> = { table };
      insertCalls.push(call);
      const step = (config.inserts ?? [])[insertIndex++] ?? { rows: [] };
      const builder: any = {
        values: vi.fn((values) => {
          call.values = values;
          return builder;
        }),
        returning: vi.fn(() => resolve(step)),
      };
      return builder;
    }),
    update: vi.fn((table) => {
      const call: Record<string, unknown> = { table };
      updateCalls.push(call);
      const step = (config.updates ?? [])[updateIndex++] ?? { rows: [] };
      const builder: any = {
        set: vi.fn((set) => {
          call.set = set;
          return builder;
        }),
        where: vi.fn((where) => {
          call.where = where;
          return builder;
        }),
        returning: vi.fn(() => resolve(step)),
      };
      return builder;
    }),
  };

  return { db, selectCalls, insertCalls, updateCalls };
}

function primeDb(mock: ReturnType<typeof createDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as never);
}

/**
 * Round-trip budget (see "Round-trip budget" in src/lib/trade.ts). Every
 * statement goes through withDbRetry and nothing runs in parallel, so the
 * number of withDbRetry calls equals the number of sequential DB round trips
 * of the call under test. Pinned per API so a regression that re-introduces
 * a follow-up query fails here.
 */
function roundTrips() {
  return vi.mocked(withDbRetry).mock.calls.length;
}

/** Alias names of the LEFT JOINed tables of a captured select. */
function joinedAliases(call: Record<string, unknown>) {
  const joins = (call.leftJoins as Array<{ table: unknown }> | undefined) ?? [];
  return joins.map((join) => getTableName(join.table as never));
}

const OFFER = {
  id: "10000000-0000-4000-8000-000000000001",
  offerer_user_id: "20000000-0000-4000-8000-000000000001",
  offered_user_card_id: "30000000-0000-4000-8000-000000000001",
  offered_card_id: "40000000-0000-4000-8000-000000000001",
  offered_streamer_id: "50000000-0000-4000-8000-000000000001",
  wanted_card_id: "40000000-0000-4000-8000-000000000002",
  wanted_streamer_id: "50000000-0000-4000-8000-000000000001",
  offered_card_snapshot: { name: "Offer", rarity: "rare", imageUrl: "https://example.test/a.png" },
  wanted_card_snapshot: { name: "Want", rarity: "epic", imageUrl: "https://example.test/b.png" },
  is_cross_channel: false,
  status: "open",
  accepted_by_user_id: null,
  accepted_user_card_id: null,
  completed_at: null,
  request_id: "60000000-0000-4000-8000-000000000001",
  accepted_request_id: null,
  created_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
};

const VIEWER_ID = "20000000-0000-4000-8000-000000000099";
const STREAMER_ID = OFFER.offered_streamer_id;

/** Row of the single create-time check statement (createTradeOffer). */
function checkRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: OFFER.offerer_user_id,
    replay: null,
    offeredUserCardId: OFFER.offered_user_card_id,
    offeredCardId: OFFER.offered_card_id,
    offeredStreamerId: OFFER.offered_streamer_id,
    offeredName: "Offer",
    offeredRarity: "rare",
    offeredImageUrl: "https://example.test/a.png",
    offeredIsActive: true,
    wantedCardId: OFFER.wanted_card_id,
    wantedStreamerId: OFFER.wanted_streamer_id,
    wantedName: "Want",
    wantedRarity: "epic",
    wantedImageUrl: "https://example.test/b.png",
    offeredTradeEnabled: true,
    offeredCrossEnabled: false,
    wantedTradeEnabled: true,
    wantedCrossEnabled: false,
    offeredCopyListed: false,
    openOfferCount: 0,
    ...overrides,
  };
}

const CHANNEL = {
  id: OFFER.offered_streamer_id,
  twitchUsername: "channel",
  twitchDisplayName: "Channel",
  twitchProfileImageUrl: null,
};
const OFFERER = {
  id: OFFER.offerer_user_id,
  twitchUsername: "offerer",
  twitchDisplayName: "Offerer",
  twitchProfileImageUrl: null,
};
/** Drizzle's shape of a LEFT JOINed nested object without a matching row. */
const NO_USER = { id: null, twitchUsername: null, twitchDisplayName: null, twitchProfileImageUrl: null };

/** Row of the single listing statement (board and /mine). */
function listRow(
  offer: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    offer,
    viewerUserId: null,
    offeredStreamer: CHANNEL,
    wantedStreamer: CHANNEL,
    offerer: OFFERER,
    acceptedBy: NO_USER,
    acceptState: null,
    ...overrides,
  };
}

describe("trade service (#723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a requestId replay before mutable ownership/gate validation", async () => {
    // Every other check would fail; the replay still wins.
    const pg = createDbMock({
      selects: [{
        rows: [checkRow({
          replay: OFFER,
          offeredIsActive: false,
          offeredTradeEnabled: false,
          offeredCopyListed: true,
        })],
      }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    const result = await createTradeOffer({
      twitchUserId: "viewer-1",
      offeredUserCardId: OFFER.offered_user_card_id,
      wantedCardId: OFFER.wanted_card_id!,
      requestId: OFFER.request_id!,
    });

    expect(result).toEqual({
      kind: "ok",
      offer: OFFER,
      idempotentReplay: true,
    });
    expect(roundTrips()).toBe(1);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it("derives snapshots and streamer ids from owned/current cards before INSERT in 2 round trips", async () => {
    const pg = createDbMock({
      selects: [{ rows: [checkRow()] }],
      inserts: [{ rows: [OFFER] }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    const result = await createTradeOffer({
      twitchUserId: "viewer-1",
      offeredUserCardId: OFFER.offered_user_card_id,
      wantedCardId: OFFER.wanted_card_id!,
      requestId: OFFER.request_id!,
    });

    expect(result.kind).toBe("ok");
    // Round-trip budget: 1 check statement + 1 INSERT (was 8).
    expect(roundTrips()).toBe(2);
    expect(pg.selectCalls).toHaveLength(1);
    expect(pg.insertCalls).toHaveLength(1);
    expect(pg.insertCalls[0].values).toMatchObject({
      offerer_user_id: OFFER.offerer_user_id,
      offered_user_card_id: OFFER.offered_user_card_id,
      offered_card_id: OFFER.offered_card_id,
      offered_streamer_id: OFFER.offered_streamer_id,
      wanted_card_id: OFFER.wanted_card_id,
      wanted_streamer_id: OFFER.wanted_streamer_id,
      offered_card_snapshot: {
        name: "Offer",
        rarity: "rare",
        imageUrl: "https://example.test/a.png",
      },
      wanted_card_snapshot: {
        name: "Want",
        rarity: "epic",
        imageUrl: "https://example.test/b.png",
      },
      request_id: OFFER.request_id,
    });
  });

  it("resolves the user and every check in one statement keyed by twitch_user_id", async () => {
    const pg = createDbMock({ selects: [{ rows: [checkRow()] }], inserts: [{ rows: [OFFER] }] });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await createTradeOffer({
      twitchUserId: "viewer-1",
      offeredUserCardId: OFFER.offered_user_card_id,
      wantedCardId: OFFER.wanted_card_id!,
      requestId: OFFER.request_id!,
    });

    const call = pg.selectCalls[0];
    expect(getTableName(call.from as never)).toBe("users");
    expect(render(call.where).params).toEqual(["viewer-1"]);
    expect(joinedAliases(call)).toEqual([
      "replay_offer",
      "offered_copy",
      "offered_card",
      "wanted_card",
      "offered_gate",
      "wanted_gate",
    ]);
    const joins = call.leftJoins as Array<{ on: unknown }>;
    // Replay is scoped to the user + requestId (unique index).
    expect(render(joins[0].on).params).toEqual([OFFER.request_id]);
    // The offered copy must belong to the same user.
    expect(render(joins[1].on).sql).toContain('"offered_copy"."user_id" = "users"."id"');
    // Inactive wanted cards never join (→ TRADE_WANTED_CARD_UNAVAILABLE).
    expect(render(joins[3].on).sql).toContain('"wanted_card"."is_active" = $');
    // Visibility is part of the wanted-card JOIN condition, so hidden card
    // names/images are never read into the Worker (Refs #1749 item 1).
    expect(render(joins[3].on).sql).toContain('visible_card.id = "wanted_card"."id"');
    expect(render(joins[3].on).sql).toContain('visible_owned.user_id = "users"."id"');

    const fields = call.fields as Record<string, unknown>;
    expect(render(fields.offeredCopyListed).sql).toContain("open_listing.status = 'open'");
    expect(render(fields.offeredCopyListed).params).toEqual([OFFER.offered_user_card_id]);
    expect(render(fields.openOfferCount).sql).toContain('open_offer.offerer_user_id = "users"."id"');
  });

  it.each([
    ["unknown user", { selects: [{ rows: [] }] }, "TRADE_CARD_NOT_OWNED"],
    ["copy not owned", { selects: [{ rows: [checkRow({ offeredUserCardId: null, offeredCardId: null, offeredStreamerId: null })] }] }, "TRADE_CARD_NOT_OWNED"],
    ["same card", { selects: [{ rows: [checkRow({ offeredCardId: OFFER.wanted_card_id })] }] }, "TRADE_SAME_CARD"],
    ["offered channel disabled", { selects: [{ rows: [checkRow({ offeredTradeEnabled: null })] }] }, "TRADE_DISABLED"],
    ["cross channel without cross permission", {
      selects: [{
        rows: [checkRow({
          wantedStreamerId: "50000000-0000-4000-8000-000000000002",
          offeredCrossEnabled: true,
          wantedCrossEnabled: false,
        })],
      }],
    }, "TRADE_DISABLED"],
    ["copy already listed", { selects: [{ rows: [checkRow({ offeredCopyListed: true, openOfferCount: 10 })] }] }, "TRADE_CARD_ALREADY_LISTED"],
    ["open-offer limit", { selects: [{ rows: [checkRow({ openOfferCount: 10 })] }] }, "TRADE_OFFER_LIMIT"],
  ])("rejects %s without INSERT (1 round trip)", async (_label, config, code) => {
    const pg = createDbMock(config);
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer({
      twitchUserId: "viewer-1",
      offeredUserCardId: OFFER.offered_user_card_id,
      wantedCardId: OFFER.wanted_card_id!,
      requestId: OFFER.request_id!,
    })).resolves.toEqual({ kind: "error", code });
    expect(roundTrips()).toBe(1);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it("recovers a post-COMMIT 23505 by requestId as an idempotent replay", async () => {
    const pg = createDbMock({
      selects: [{ rows: [checkRow()] }, { rows: [OFFER] }],
      inserts: [{
        error: {
          code: "23505",
          constraint: "idx_trade_offers_offerer_request",
        },
      }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    const result = await createTradeOffer({
      twitchUserId: "viewer-1",
      offeredUserCardId: OFFER.offered_user_card_id,
      wantedCardId: OFFER.wanted_card_id!,
      requestId: OFFER.request_id!,
    });

    expect(result).toEqual({
      kind: "ok",
      offer: OFFER,
      idempotentReplay: true,
    });
    expect(pg.insertCalls).toHaveLength(1);
    // The recovery lookup uses the users.id resolved by the check statement.
    expect(render(pg.selectCalls[1].where).params).toEqual([
      OFFER.offerer_user_id,
      OFFER.request_id,
    ]);
  });

  it("maps canAccept from the per-row SQL state for other people's offers only", async () => {
    const second = { ...OFFER, id: "10000000-0000-4000-8000-000000000002" };
    const third = { ...OFFER, id: "10000000-0000-4000-8000-000000000003" };
    const own = { ...OFFER, id: "10000000-0000-4000-8000-000000000004", offerer_user_id: VIEWER_ID };

    const pg = createDbMock({
      selects: [{
        rows: [
          listRow(OFFER, { viewerUserId: VIEWER_ID, acceptState: "not_owned" }),
          listRow(second, { viewerUserId: VIEWER_ID, acceptState: "all_listed" }),
          listRow(third, { viewerUserId: VIEWER_ID, acceptState: "yes" }),
          listRow(own, { viewerUserId: VIEWER_ID, acceptState: "yes" }),
        ],
      }],
    });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers({
      streamerId: OFFER.offered_streamer_id,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-2",
    });

    expect(result.offers.map((offer) => offer.canAccept)).toEqual([
      "not_owned",
      "all_listed",
      "yes",
      undefined,
    ]);
    // The board never reports tradeability: /mine owns that flag (#1754).
    expect(result.offers[0]).not.toHaveProperty("tradeable");
    expect((pg.selectCalls[0].fields as Record<string, unknown>).tradeableState).toBeUndefined();
    // Round-trip budget: one statement (was user + page + metadata + canAccept).
    expect(roundTrips()).toBe(1);
  });

  it("cancel is an open-state CAS keyed by the resolved owner and reports an owned completed offer as conflict", async () => {
    const pg = createDbMock({
      selects: [{ rows: [{ status: "completed" }] }],
      updates: [{ rows: [] }],
    });
    primeDb(pg);

    const { cancelTradeOffer } = await import("@/lib/trade");
    const result = await cancelTradeOffer({
      twitchUserId: "viewer-1",
      tradeOfferId: OFFER.id,
    });

    expect(result).toEqual({ kind: "error", code: "TRADE_OFFER_NOT_OPEN" });
    expect(pg.updateCalls[0].set).toEqual({ status: "cancelled" });
    const where = render(pg.updateCalls[0].where);
    expect(where.sql).toMatch(/"trade_offers"\."offerer_user_id" = \(\s*SELECT viewer\.id/);
    expect(where.params).toEqual([OFFER.id, "viewer-1", "open"]);
    // CAS + state read only on the failure path.
    expect(roundTrips()).toBe(2);
  });

  it("cancel succeeds in a single round trip", async () => {
    const pg = createDbMock({ updates: [{ rows: [{ id: OFFER.id }] }] });
    primeDb(pg);

    const { cancelTradeOffer } = await import("@/lib/trade");
    await expect(cancelTradeOffer({ twitchUserId: "viewer-1", tradeOfferId: OFFER.id }))
      .resolves.toEqual({ kind: "ok", id: OFFER.id });
    expect(roundTrips()).toBe(1);
    expect(pg.selectCalls).toHaveLength(0);
  });

  it("cancel by an unknown user ends as TRADE_OFFER_NOT_FOUND", async () => {
    const pg = createDbMock({ selects: [{ rows: [] }], updates: [{ rows: [] }] });
    primeDb(pg);

    const { cancelTradeOffer } = await import("@/lib/trade");
    await expect(cancelTradeOffer({ twitchUserId: "ghost", tradeOfferId: OFFER.id }))
      .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_NOT_FOUND" });
  });
});

// -----------------------------------------------------------------------------
// #715 PR-C: visibility / is_active rules, /mine paging, viewer UI helpers.
//
// These tests pin the *structure* of the SQL (rendered with PgDialect) because
// Drizzle is mocked here. Row-level correctness of the same predicates is
// proven against real PostgreSQL in tests/integration/trade-visibility-pg.test.ts.
// -----------------------------------------------------------------------------

describe("listTradeOffers visibility (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters both sides by visibility in SQL, keeps own offers, and gates is_active for everyone", async () => {
    const pg = createDbMock({ selects: [{ rows: [] }] });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 3,
      twitchUserId: "viewer-2",
    });

    expect(result).toEqual({ offers: [], page: 3, pageSize: 20, hasMore: false });
    expect(roundTrips()).toBe(1);
    const listCall = pg.selectCalls[0];
    // Pagination is applied by SQL over the already-filtered set.
    expect(listCall.limit).toBe(21);
    expect(listCall.offset).toBe(40);
    // Display metadata is joined in the same statement.
    expect(joinedAliases(listCall)).toEqual([
      "offered_streamer",
      "wanted_streamer",
      "offerer_user",
      "acceptor_user",
    ]);

    const where = render(listCall.where);
    // Own offers bypass only the reveal rule; the viewer is resolved in SQL.
    expect(where.sql).toMatch(
      /\("trade_offers"\."offerer_user_id" = \(\s*SELECT viewer\.id[\s\S]*?\) or \(EXISTS/,
    );
    expect(where.sql).toContain("viewer.twitch_user_id = $");
    expect(where.sql).toContain('visible_card.id = "trade_offers"."offered_card_id"');
    expect(where.sql).toContain('visible_card.id = "trade_offers"."wanted_card_id"');
    expect(where.sql).toContain("visible_streamer.show_unowned_cards = TRUE");
    expect(where.sql).toContain("visible_streamer.show_unowned_card_details = TRUE");
    expect(where.sql).toMatch(/visible_owned\.user_id = \(\s*SELECT viewer\.id/);
    // is_active is a separate AND condition (applies to own offers too).
    expect(where.sql).toContain('active_card.id = "trade_offers"."offered_card_id"');
    expect(where.sql).toContain('active_card.id = "trade_offers"."wanted_card_id"');
    // Existing trade_enabled gates are still present.
    expect(where.sql).toContain("trade_gate.trade_enabled = TRUE");
    // own-offer bypass + two ownership branches
    expect(where.params.filter((param) => param === "viewer-2")).toHaveLength(3);
  });

  it("anonymous viewers have no ownership branch and no own-offer bypass", async () => {
    const pg = createDbMock({ selects: [{ rows: [] }] });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "cross_channel",
      wantedCardId: OFFER.wanted_card_id,
      offeredCardId: OFFER.offered_card_id,
      page: 1,
    });

    expect(roundTrips()).toBe(1);
    const where = render(pg.selectCalls[0].where);
    expect(where.sql).not.toContain("offerer_user_id");
    expect(where.sql).not.toContain("visible_owned");
    expect(where.sql).not.toContain("viewer.");
    expect(where.sql).toContain("OR FALSE");
    expect(where.sql).toContain("cross_gate.cross_channel_trade_enabled = TRUE");
    // Card filters are part of the same WHERE (cannot probe hidden offers).
    expect(where.params).toContain(OFFER.wanted_card_id);
    expect(where.params).toContain(OFFER.offered_card_id);
    const fields = pg.selectCalls[0].fields as Record<string, unknown>;
    expect(render(fields.viewerUserId).sql).toBe("NULL::uuid");
    expect(render(fields.acceptState).sql).toBe("NULL");
  });

  it("exposes offeredUserCardId only for the viewer's own offers and acceptedBy for every row", async () => {
    const own = { ...OFFER, id: "10000000-0000-4000-8000-000000000010", offerer_user_id: VIEWER_ID };
    const pg = createDbMock({
      selects: [{
        rows: [
          listRow(OFFER, { viewerUserId: VIEWER_ID, acceptState: "not_owned" }),
          // Drizzle may also return a non-matching LEFT JOIN as null.
          listRow(own, { viewerUserId: VIEWER_ID, acceptState: "yes", acceptedBy: null }),
        ],
      }],
    });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    const { offers } = await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-2",
    });

    expect(offers[0]).not.toHaveProperty("offeredUserCardId");
    expect(offers[0]).toMatchObject({
      isOwnOffer: false,
      canAccept: "not_owned",
      acceptedBy: null,
      offerer: { twitchUsername: "offerer", twitchDisplayName: "Offerer", twitchProfileImageUrl: null },
      offeredStreamer: CHANNEL,
      wantedStreamer: CHANNEL,
    });
    expect(offers[0].offerer).not.toHaveProperty("id");
    expect(offers[1]).toMatchObject({
      isOwnOffer: true,
      offeredUserCardId: own.offered_user_card_id,
      acceptedBy: null,
    });
    expect(offers[1]).not.toHaveProperty("canAccept");
  });

  it("treats an unknown twitch user (viewer id NULL) like an anonymous viewer in the DTO", async () => {
    const pg = createDbMock({ selects: [{ rows: [listRow(OFFER, { acceptState: "not_owned" })] }] });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    const { offers } = await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 1,
      twitchUserId: "ghost",
    });
    expect(offers[0]).not.toHaveProperty("isOwnOffer");
    expect(offers[0]).not.toHaveProperty("canAccept");
    expect(offers[0]).not.toHaveProperty("offeredUserCardId");
  });

  it("computes canAccept with the RPC's listed-copy exclusion on aliased inner rows", async () => {
    const pg = createDbMock({ selects: [{ rows: [] }] });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-2",
    });

    const fields = pg.selectCalls[0].fields as Record<string, unknown>;
    const state = render(fields.acceptState);
    expect(state.sql).toContain('accept_owned.card_id = "trade_offers"."wanted_card_id"');
    expect(state.sql).toContain('accept_free.card_id = "trade_offers"."wanted_card_id"');
    // A bare "id" would bind to active_listing.id (trade_offers.id).
    expect(state.sql).toContain("active_listing.offered_user_card_id = accept_free.id");
    expect(state.sql).toContain("active_listing.status = 'open'");
    // Same exclusion rule as the accept RPC: only the viewer's own open
    // offers make a copy count as listed (Refs #1749 item 3).
    expect(state.sql).toContain("active_listing.offerer_user_id = ");
    expect(state.params).toEqual(["viewer-2", "viewer-2", "viewer-2"]);
  });
});

describe("createTradeOffer visibility / is_active (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const input = {
    twitchUserId: "viewer-1",
    offeredUserCardId: OFFER.offered_user_card_id,
    wantedCardId: OFFER.wanted_card_id!,
    requestId: OFFER.request_id!,
  };

  it.each([false, null])("rejects an offered card with is_active=%s before any other validation", async (isActive) => {
    const pg = createDbMock({
      selects: [{
        rows: [checkRow({
          offeredIsActive: isActive,
          offeredCardId: OFFER.wanted_card_id,
          offeredTradeEnabled: false,
        })],
      }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "error",
      code: "TRADE_OFFERED_CARD_INACTIVE",
    });
    expect(roundTrips()).toBe(1);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it.each([
    ["hidden from the offerer", {
      wantedCardId: null,
      wantedStreamerId: null,
      wantedName: null,
      wantedRarity: null,
      wantedImageUrl: null,
      wantedTradeEnabled: null,
      wantedCrossEnabled: null,
    }],
    ["missing or inactive", {
      wantedCardId: null,
      wantedStreamerId: null,
      wantedName: null,
      wantedTradeEnabled: null,
      wantedCrossEnabled: null,
    }],
  ])("answers TRADE_WANTED_CARD_UNAVAILABLE when the wanted card is %s, before the streamer gates", async (_label, overrides) => {
    // The gates would answer TRADE_DISABLED; the visibility decision comes
    // first so the response cannot confirm that a hidden card id exists.
    // Visibility is enforced in the wanted-card JOIN condition, so a hidden
    // card joins to NULL exactly like a missing/inactive one (Refs #1749).
    const pg = createDbMock({
      selects: [{ rows: [checkRow({ ...overrides, offeredTradeEnabled: false })] }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "error",
      code: "TRADE_WANTED_CARD_UNAVAILABLE",
    });
    expect(pg.insertCalls).toHaveLength(0);

    // The wanted-card JOIN condition carries the board's visibility predicate,
    // so hidden names/images are never selected into the Worker.
    const joins = pg.selectCalls[0].leftJoins as Array<{ on: unknown }>;
    const wantedOn = render(joins[3].on);
    expect(wantedOn.sql).toContain('visible_card.id = "wanted_card"."id"');
    // Ownership branch is evaluated for the outer users row of this statement.
    expect(wantedOn.sql).toContain('visible_owned.user_id = "users"."id"');
  });

  it("replays by requestId before the is_active / visibility checks", async () => {
    const pg = createDbMock({
      selects: [{ rows: [checkRow({ replay: OFFER, offeredIsActive: false })] }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "ok",
      offer: OFFER,
      idempotentReplay: true,
    });
    expect(roundTrips()).toBe(1);
  });
});

describe("listMyTradeOffers status filter / paging (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ACCEPTOR_ID = "20000000-0000-4000-8000-000000000077";

  it("filters by status in SQL, pages at 20 and resolves acceptedBy in one statement", async () => {
    const completed = {
      ...OFFER,
      status: "completed",
      accepted_by_user_id: ACCEPTOR_ID,
      completed_at: "2026-10-04T01:00:00.000Z",
    };
    const rows = Array.from({ length: 21 }, (_, index) => listRow(
      {
        ...completed,
        id: `10000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
      },
      {
        viewerUserId: OFFER.offerer_user_id,
        acceptedBy: {
          id: ACCEPTOR_ID,
          twitchUsername: "a",
          twitchDisplayName: "Acceptor",
          twitchProfileImageUrl: "https://example.test/a.png",
        },
      },
    ));
    const pg = createDbMock({ selects: [{ rows }] });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    const result = await listMyTradeOffers("viewer-1", { status: "completed", page: 2 });

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.hasMore).toBe(true);
    expect(result.offers).toHaveLength(20);
    expect(result.offers[0]).toMatchObject({
      mineRole: "offerer",
      isOwnOffer: true,
      offeredUserCardId: OFFER.offered_user_card_id,
      acceptedBy: {
        twitchUsername: "a",
        twitchDisplayName: "Acceptor",
        twitchProfileImageUrl: "https://example.test/a.png",
      },
    });
    expect(result.offers[0]).not.toHaveProperty("canAccept");
    // Round-trip budget: one statement (was user + page + metadata).
    expect(roundTrips()).toBe(1);

    const listCall = pg.selectCalls[0];
    expect(listCall.limit).toBe(21);
    expect(listCall.offset).toBe(20);
    expect(joinedAliases(listCall)).toEqual([
      "offered_streamer",
      "wanted_streamer",
      "offerer_user",
      "acceptor_user",
    ]);
    const where = render(listCall.where);
    expect(where.sql).toContain('"trade_offers"."status" = $');
    expect(where.params).toContain("completed");
    expect(where.sql).toMatch(/"trade_offers"\."offerer_user_id" = \(\s*SELECT viewer\.id/);
    expect(where.sql).toMatch(/"trade_offers"\."accepted_by_user_id" = \(\s*SELECT viewer\.id/);
    expect(where.params.filter((param) => param === "viewer-1")).toHaveLength(2);
  });

  it("reports tradeability for open offers in the same statement as the page (#1754 item 4)", async () => {
    const open = { ...OFFER, id: "10000000-0000-4000-8000-000000000011" };
    const notTradeable = { ...OFFER, id: "10000000-0000-4000-8000-000000000012" };
    const completed = {
      ...OFFER,
      id: "10000000-0000-4000-8000-000000000013",
      status: "completed",
      accepted_by_user_id: ACCEPTOR_ID,
    };
    const pg = createDbMock({
      selects: [{
        rows: [
          listRow(open, { viewerUserId: OFFER.offerer_user_id, tradeableState: true }),
          listRow(notTradeable, { viewerUserId: OFFER.offerer_user_id, tradeableState: false }),
          // A finished offer is not acceptable, whatever the gate state is.
          listRow(completed, { viewerUserId: OFFER.offerer_user_id, tradeableState: true }),
        ],
      }],
    });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    const { offers } = await listMyTradeOffers("viewer-1", { status: "open" });

    expect(offers.map((offer) => offer.tradeable)).toEqual([true, false, false]);
    // Round-trip budget: the flag rides along in the page statement.
    expect(roundTrips()).toBe(1);

    // The gates mirror the board's SQL predicates (an active card definition
    // on both sides, trade_enabled on both channels, and — for cross-channel
    // offers — cross_channel_trade_enabled on both).
    const state = render((pg.selectCalls[0].fields as Record<string, unknown>).tradeableState);
    expect(state.params).toEqual([]);
    expect(state.sql).toMatch(
      /"cards" AS active_card\s+WHERE active_card\.id = "trade_offers"\."offered_card_id"\s+AND active_card\.is_active = TRUE/,
    );
    expect(state.sql).toMatch(
      /"cards" AS active_card\s+WHERE active_card\.id = "trade_offers"\."wanted_card_id"\s+AND active_card\.is_active = TRUE/,
    );
    expect(state.sql).toMatch(
      /"streamers" AS trade_gate\s+WHERE trade_gate\.id = "trade_offers"\."offered_streamer_id"\s+AND trade_gate\.trade_enabled = TRUE/,
    );
    expect(state.sql).toMatch(
      /"streamers" AS trade_gate\s+WHERE trade_gate\.id = "trade_offers"\."wanted_streamer_id"\s+AND trade_gate\.trade_enabled = TRUE/,
    );
    expect(state.sql).toMatch(
      /"streamers" AS cross_gate\s+WHERE cross_gate\.id = "trade_offers"\."offered_streamer_id"\s+AND cross_gate\.cross_channel_trade_enabled = TRUE/,
    );
    expect(state.sql).toMatch(
      /"streamers" AS cross_gate\s+WHERE cross_gate\.id = "trade_offers"\."wanted_streamer_id"\s+AND cross_gate\.cross_channel_trade_enabled = TRUE/,
    );
    expect(state.sql).toContain('"trade_offers"."is_cross_channel" IS NOT TRUE');
  });

  it("marks offers the viewer accepted as acceptor rows", async () => {
    const accepted = { ...OFFER, status: "completed", accepted_by_user_id: VIEWER_ID };
    const pg = createDbMock({ selects: [{ rows: [listRow(accepted, { viewerUserId: VIEWER_ID })] }] });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    const { offers } = await listMyTradeOffers("viewer-2", { status: "completed" });
    expect(offers[0]).toMatchObject({
      mineRole: "acceptor",
      isOwnOffer: false,
      // Every /mine row keeps the copy id (the viewer received it).
      offeredUserCardId: OFFER.offered_user_card_id,
    });
  });

  it("omits the status condition when no status is given and returns an empty page for unknown users", async () => {
    const pg = createDbMock({ selects: [{ rows: [] }] });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    await expect(listMyTradeOffers("viewer-1")).resolves.toEqual({
      offers: [],
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    expect(render(pg.selectCalls[0].where).sql).not.toContain('"status"');

    vi.clearAllMocks();
    const unknown = createDbMock({ selects: [{ rows: [] }] });
    primeDb(unknown);
    await expect(listMyTradeOffers("ghost", { status: "open", page: 3 })).resolves.toEqual({
      offers: [],
      page: 3,
      pageSize: 20,
      hasMore: false,
    });
    expect(roundTrips()).toBe(1);
  });
});

describe("viewer UI server helpers (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const streamerRow = (overrides: Record<string, unknown> = {}) => ({
    id: STREAMER_ID,
    twitchUsername: "channel",
    twitchDisplayName: "Channel",
    twitchProfileImageUrl: null,
    showUnownedCards: true,
    showUnownedCardDetails: true,
    tradeEnabled: true,
    crossChannelTradeEnabled: true,
    ...overrides,
  });

  describe("getTradeBoardStreamer", () => {
    it("returns null for a malformed id without touching the database", async () => {
      const pg = createDbMock();
      primeDb(pg);
      const { getTradeBoardStreamer } = await import("@/lib/trade");
      await expect(getTradeBoardStreamer("nope")).resolves.toBeNull();
      expect(pg.selectCalls).toHaveLength(0);
    });

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ])("show_unowned_cards=%s details=%s → revealsUnownedCards=%s", async (unowned, details, reveals) => {
      const pg = createDbMock({
        selects: [{ rows: [streamerRow({ showUnownedCards: unowned, showUnownedCardDetails: details })] }],
      });
      primeDb(pg);
      const { getTradeBoardStreamer } = await import("@/lib/trade");
      await expect(getTradeBoardStreamer(STREAMER_ID)).resolves.toEqual({
        id: STREAMER_ID,
        twitchUsername: "channel",
        twitchDisplayName: "Channel",
        twitchProfileImageUrl: null,
        tradeEnabled: true,
        crossChannelTradeEnabled: true,
        revealsUnownedCards: reveals,
      });
      expect(roundTrips()).toBe(1);
    });

    it("fails closed when trade columns are missing during the deploy window", async () => {
      const pg = createDbMock({
        selects: [
          { error: { code: "42703", message: 'column "trade_enabled" does not exist' } },
          { rows: [streamerRow({ tradeEnabled: false, crossChannelTradeEnabled: false })] },
        ],
      });
      primeDb(pg);
      const { getTradeBoardStreamer } = await import("@/lib/trade");
      await expect(getTradeBoardStreamer(STREAMER_ID)).resolves.toMatchObject({
        tradeEnabled: false,
        crossChannelTradeEnabled: false,
      });
      const retryFields = pg.selectCalls[1].fields as Record<string, unknown>;
      expect(render(retryFields.tradeEnabled).sql).toBe("FALSE");
      expect(render(retryFields.crossChannelTradeEnabled).sql).toBe("FALSE");
    });
  });

  describe("listTradeableOwnedCopies", () => {
    it("returns [] for malformed ids or unknown users", async () => {
      const pg = createDbMock({ selects: [{ rows: [] }] });
      primeDb(pg);
      const { listTradeableOwnedCopies } = await import("@/lib/trade");
      await expect(listTradeableOwnedCopies("viewer-1", "bad")).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(0);
      await expect(listTradeableOwnedCopies("ghost", STREAMER_ID)).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(1);
    });

    it("selects only the viewer's active copies of the channel in one statement and maps counts/flags", async () => {
      const pg = createDbMock({
        selects: [
          {
            rows: [{
              userCardId: OFFER.offered_user_card_id,
              cardId: OFFER.offered_card_id,
              name: "Offer",
              rarity: "rare",
              imageUrl: null,
              obtainedAt: "2026-10-01T00:00:00.000Z",
              isListed: true,
              ownedCount: "2",
            }],
          },
        ],
      });
      primeDb(pg);
      const { listTradeableOwnedCopies } = await import("@/lib/trade");
      await expect(listTradeableOwnedCopies("viewer-2", STREAMER_ID)).resolves.toEqual([{
        userCardId: OFFER.offered_user_card_id,
        cardId: OFFER.offered_card_id,
        name: "Offer",
        rarity: "rare",
        imageUrl: null,
        obtainedAt: "2026-10-01T00:00:00.000Z",
        isListed: true,
        ownedCount: 2,
      }]);
      expect(roundTrips()).toBe(1);

      const call = pg.selectCalls[0];
      const where = render(call.where);
      expect(where.sql).toMatch(/"user_cards"\."user_id" = \(\s*SELECT viewer\.id/);
      expect(where.sql).toContain('"cards"."streamer_id" = $');
      expect(where.sql).toContain('"cards"."is_active" = $');
      expect(where.params).toEqual(["viewer-2", STREAMER_ID, true]);
      const fields = call.fields as Record<string, unknown>;
      expect(render(fields.isListed).sql).toContain(
        'copy_listing.offered_user_card_id = "user_cards"."id"',
      );
      expect(render(fields.ownedCount).sql).toContain("OVER (PARTITION BY");
    });
  });

  describe("listWantableCards", () => {
    it("anonymous: no user lookup and only revealed cards (no ownership branch)", async () => {
      const pg = createDbMock({ selects: [{ rows: [] }] });
      primeDb(pg);
      const { listWantableCards } = await import("@/lib/trade");
      await expect(listWantableCards(null, STREAMER_ID)).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(1);
      const where = render(pg.selectCalls[0].where);
      expect(where.sql).toContain('visible_card.id = "cards"."id"');
      expect(where.sql).toContain("OR FALSE");
      expect(where.sql).not.toContain("visible_owned");
      const fields = pg.selectCalls[0].fields as Record<string, unknown>;
      expect(render(fields.isOwned).sql).toBe("FALSE");
    });

    it("logged in: visibility includes the viewer's ownership (resolved in SQL) and maps isOwned", async () => {
      const pg = createDbMock({
        selects: [
          { rows: [{ cardId: OFFER.wanted_card_id, name: "Want", rarity: "epic", imageUrl: null, isOwned: true }] },
        ],
      });
      primeDb(pg);
      const { listWantableCards } = await import("@/lib/trade");
      await expect(listWantableCards("viewer-2", STREAMER_ID)).resolves.toEqual([
        { cardId: OFFER.wanted_card_id, name: "Want", rarity: "epic", imageUrl: null, isOwned: true },
      ]);
      expect(roundTrips()).toBe(1);
      const where = render(pg.selectCalls[0].where);
      expect(where.sql).toMatch(/visible_owned\.user_id = \(\s*SELECT viewer\.id/);
      expect(where.params).toContain("viewer-2");
      const fields = pg.selectCalls[0].fields as Record<string, unknown>;
      const isOwned = render(fields.isOwned);
      expect(isOwned.sql).toContain('wanted_owned.card_id = "cards"."id"');
      expect(isOwned.params).toEqual(["viewer-2"]);
    });

    it("returns [] for a malformed streamer id without querying", async () => {
      const pg = createDbMock();
      primeDb(pg);
      const { listWantableCards } = await import("@/lib/trade");
      await expect(listWantableCards("viewer-2", "bad")).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(0);
    });
  });

  describe("listCrossTradePartnerStreamers", () => {
    it("returns [] for a malformed base id without querying", async () => {
      const pg = createDbMock();
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", "bad")).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(0);
    });

    it("selects active-owned ∩ trade+cross channels, excluding the base, gated on the base in the same statement", async () => {
      const partner = {
        id: "50000000-0000-4000-8000-000000000002",
        twitchUsername: "partner",
        twitchDisplayName: "Partner",
        twitchProfileImageUrl: null,
      };
      const pg = createDbMock({ selects: [{ rows: [partner] }] });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", STREAMER_ID)).resolves.toEqual([partner]);
      // Round-trip budget: one statement (was base streamer + user + partners).
      expect(roundTrips()).toBe(1);

      const where = render(pg.selectCalls[0].where);
      expect(where.sql).toContain('"streamers"."id" <> $');
      expect(where.sql).toContain('"streamers"."trade_enabled" = $');
      expect(where.sql).toContain('"streamers"."cross_channel_trade_enabled" = $');
      // A base channel without trade or cross permission yields no rows.
      expect(where.sql).toContain("base_streamer.trade_enabled = TRUE");
      expect(where.sql).toContain("base_streamer.cross_channel_trade_enabled = TRUE");
      expect(where.sql).toContain('partner_card.streamer_id = "streamers"."id"');
      expect(where.sql).toContain("partner_card.is_active = TRUE");
      expect(where.sql).toMatch(/partner_owned\.user_id = \(\s*SELECT viewer\.id/);
      expect(where.params).toEqual([STREAMER_ID, true, true, STREAMER_ID, "viewer-2"]);
    });

    it("fails closed to [] when the trade columns are missing during the deploy window", async () => {
      const pg = createDbMock({
        selects: [{ error: { code: "42703", message: 'column "cross_channel_trade_enabled" does not exist' } }],
      });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", STREAMER_ID)).resolves.toEqual([]);
    });

    it("rethrows unrelated database errors", async () => {
      const error = Object.assign(new Error("boom"), { code: "08006" });
      const pg = createDbMock({ selects: [{ error }] });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", STREAMER_ID)).rejects.toBe(error);
    });
  });
});
