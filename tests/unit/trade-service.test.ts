import { beforeEach, describe, expect, it, vi } from "vitest";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

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
          call.leftJoin = { table, on };
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

describe("trade service (#723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a requestId replay before mutable ownership/gate validation", async () => {
    const pg = createDbMock({
      selects: [
        { rows: [{ id: OFFER.offerer_user_id, twitch_user_id: "viewer-1" }] },
        { rows: [OFFER] },
      ],
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
    expect(pg.selectCalls).toHaveLength(2);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it("derives snapshots and streamer ids from owned/current cards before INSERT", async () => {
    const pg = createDbMock({
      selects: [
        { rows: [{ id: OFFER.offerer_user_id, twitch_user_id: "viewer-1" }] },
        { rows: [] },
        {
          rows: [{
            userCardId: OFFER.offered_user_card_id,
            cardId: OFFER.offered_card_id,
            streamerId: OFFER.offered_streamer_id,
            name: "Offer",
            rarity: "rare",
            imageUrl: "https://example.test/a.png",
            isActive: true,
          }],
        },
        {
          rows: [{
            id: OFFER.wanted_card_id,
            streamerId: OFFER.wanted_streamer_id,
            name: "Want",
            rarity: "epic",
            imageUrl: "https://example.test/b.png",
            visible: true,
          }],
        },
        {
          rows: [{
            id: OFFER.offered_streamer_id,
            tradeEnabled: true,
            crossEnabled: false,
          }],
        },
        { rows: [] },
        { rows: [{ value: 0 }] },
      ],
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

  it("recovers a post-COMMIT 23505 by requestId as an idempotent replay", async () => {
    const pg = createDbMock({
      selects: [
        { rows: [{ id: OFFER.offerer_user_id, twitch_user_id: "viewer-1" }] },
        { rows: [] },
        {
          rows: [{
            userCardId: OFFER.offered_user_card_id,
            cardId: OFFER.offered_card_id,
            streamerId: OFFER.offered_streamer_id,
            name: "Offer",
            rarity: "rare",
            imageUrl: "https://example.test/a.png",
            isActive: true,
          }],
        },
        {
          rows: [{
            id: OFFER.wanted_card_id,
            streamerId: OFFER.wanted_streamer_id,
            name: "Want",
            rarity: "epic",
            imageUrl: "https://example.test/b.png",
            visible: true,
          }],
        },
        {
          rows: [{
            id: OFFER.offered_streamer_id,
            tradeEnabled: true,
            crossEnabled: false,
          }],
        },
        { rows: [] },
        { rows: [{ value: 0 }] },
        { rows: [OFFER] },
      ],
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
  });

  it("distinguishes not_owned / all_listed / yes with the same exclusion rule as the accept RPC", async () => {
    const second = {
      ...OFFER,
      id: "10000000-0000-4000-8000-000000000002",
      wanted_card_id: "40000000-0000-4000-8000-000000000003",
    };
    const third = {
      ...OFFER,
      id: "10000000-0000-4000-8000-000000000003",
      wanted_card_id: "40000000-0000-4000-8000-000000000004",
    };

    const pg = createDbMock({
      selects: [
        { rows: [{ id: "20000000-0000-4000-8000-000000000099", twitch_user_id: "viewer-2" }] },
        { rows: [OFFER, second, third] },
        {
          rows: [{
            id: OFFER.offered_streamer_id,
            twitchUsername: "channel",
            twitchDisplayName: "Channel",
            twitchProfileImageUrl: null,
          }],
        },
        {
          rows: [{
            id: OFFER.offerer_user_id,
            twitchUsername: "offerer",
            twitchDisplayName: "Offerer",
            twitchProfileImageUrl: null,
          }],
        },
        {
          rows: [
            { id: "70000000-0000-4000-8000-000000000001", cardId: second.wanted_card_id, listed: true },
            { id: "70000000-0000-4000-8000-000000000002", cardId: third.wanted_card_id, listed: true },
            { id: "70000000-0000-4000-8000-000000000003", cardId: third.wanted_card_id, listed: false },
          ],
        },
      ],
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
    ]);
  });

  it("cancel is an open-state CAS and reports an owned completed offer as conflict", async () => {
    const pg = createDbMock({
      selects: [
        { rows: [{ id: OFFER.offerer_user_id, twitch_user_id: "viewer-1" }] },
        { rows: [{ status: "completed" }] },
      ],
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
  });
});

// -----------------------------------------------------------------------------
// #715 PR-C: visibility / is_active rules, /mine paging, viewer UI helpers.
//
// These tests pin the *structure* of the SQL (rendered with PgDialect) because
// Drizzle is mocked here. Row-level correctness of the same predicates is
// proven against real PostgreSQL in tests/integration/trade-visibility-pg.test.ts.
// -----------------------------------------------------------------------------

const VIEWER_ID = "20000000-0000-4000-8000-000000000099";
const STREAMER_ID = OFFER.offered_streamer_id;

function userRow(idValue: string, twitchUserId: string) {
  return { rows: [{ id: idValue, twitch_user_id: twitchUserId }] };
}

describe("listTradeOffers visibility (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters both sides by visibility in SQL, keeps own offers, and gates is_active for everyone", async () => {
    const pg = createDbMock({ selects: [userRow(VIEWER_ID, "viewer-2"), { rows: [] }] });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 3,
      twitchUserId: "viewer-2",
    });

    expect(result).toEqual({ offers: [], page: 3, pageSize: 20, hasMore: false });
    const listCall = pg.selectCalls[1];
    // Pagination is applied by SQL over the already-filtered set.
    expect(listCall.limit).toBe(21);
    expect(listCall.offset).toBe(40);

    const where = render(listCall.where);
    // Own offers bypass only the reveal rule.
    expect(where.sql).toMatch(/\("trade_offers"\."offerer_user_id" = \$\d+ or \(EXISTS/);
    expect(where.sql).toContain('visible_card.id = "trade_offers"."offered_card_id"');
    expect(where.sql).toContain('visible_card.id = "trade_offers"."wanted_card_id"');
    expect(where.sql).toContain("visible_streamer.show_unowned_cards = TRUE");
    expect(where.sql).toContain("visible_streamer.show_unowned_card_details = TRUE");
    expect(where.sql).toContain("visible_owned.user_id = $");
    // is_active is a separate AND condition (applies to own offers too).
    expect(where.sql).toContain('active_card.id = "trade_offers"."offered_card_id"');
    expect(where.sql).toContain('active_card.id = "trade_offers"."wanted_card_id"');
    // Existing trade_enabled gates are still present.
    expect(where.sql).toContain("trade_gate.trade_enabled = TRUE");
    expect(where.params.filter((param) => param === VIEWER_ID)).toHaveLength(3);
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

    // No users lookup for anonymous viewers: the first select is the list.
    const where = render(pg.selectCalls[0].where);
    expect(where.sql).not.toContain("offerer_user_id");
    expect(where.sql).not.toContain("visible_owned");
    expect(where.sql).toContain("OR FALSE");
    expect(where.sql).toContain("cross_gate.cross_channel_trade_enabled = TRUE");
    // Card filters are part of the same WHERE (cannot probe hidden offers).
    expect(where.params).toContain(OFFER.wanted_card_id);
    expect(where.params).toContain(OFFER.offered_card_id);
  });

  it("exposes offeredUserCardId only for the viewer's own offers and acceptedBy for every row", async () => {
    const own = { ...OFFER, id: "10000000-0000-4000-8000-000000000010", offerer_user_id: VIEWER_ID };
    const pg = createDbMock({
      selects: [
        userRow(VIEWER_ID, "viewer-2"),
        { rows: [OFFER, own] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
      ],
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
    expect(offers[0]).toMatchObject({ isOwnOffer: false, canAccept: "not_owned", acceptedBy: null });
    expect(offers[1]).toMatchObject({
      isOwnOffer: true,
      offeredUserCardId: own.offered_user_card_id,
      acceptedBy: null,
    });
    expect(offers[1]).not.toHaveProperty("canAccept");
  });

  it("checks listed copies against the outer user_cards row (qualified column)", async () => {
    const pg = createDbMock({
      selects: [
        userRow(VIEWER_ID, "viewer-2"),
        { rows: [OFFER] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
      ],
    });
    primeDb(pg);

    const { listTradeOffers } = await import("@/lib/trade");
    await listTradeOffers({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-2",
    });

    const fields = pg.selectCalls[4].fields as Record<string, unknown>;
    // A bare "id" would bind to active_listing.id (trade_offers.id).
    expect(render(fields.listed).sql).toContain(
      'active_listing.offered_user_card_id = "user_cards"."id"',
    );
  });
});

describe("createTradeOffer visibility / is_active (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const offeredRow = (overrides: Record<string, unknown> = {}) => ({
    rows: [{
      userCardId: OFFER.offered_user_card_id,
      cardId: OFFER.offered_card_id,
      streamerId: OFFER.offered_streamer_id,
      name: "Offer",
      rarity: "rare",
      imageUrl: null,
      isActive: true,
      ...overrides,
    }],
  });
  const input = {
    twitchUserId: "viewer-1",
    offeredUserCardId: OFFER.offered_user_card_id,
    wantedCardId: OFFER.wanted_card_id!,
    requestId: OFFER.request_id!,
  };

  it.each([false, null])("rejects an offered card with is_active=%s before any other validation", async (isActive) => {
    const pg = createDbMock({
      selects: [
        userRow(OFFER.offerer_user_id, "viewer-1"),
        { rows: [] },
        offeredRow({ isActive }),
      ],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "error",
      code: "TRADE_OFFERED_CARD_INACTIVE",
    });
    expect(pg.selectCalls).toHaveLength(3);
    expect(pg.insertCalls).toHaveLength(0);
  });

  it.each([
    ["hidden from the offerer", [{ id: OFFER.wanted_card_id, streamerId: STREAMER_ID, name: "Secret", rarity: "epic", imageUrl: null, visible: false }]],
    ["missing or inactive", []],
  ])("answers TRADE_WANTED_CARD_UNAVAILABLE when the wanted card is %s, before the streamer gates", async (_label, wantedRows) => {
    const pg = createDbMock({
      selects: [
        userRow(OFFER.offerer_user_id, "viewer-1"),
        { rows: [] },
        offeredRow(),
        { rows: wantedRows },
      ],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "error",
      code: "TRADE_WANTED_CARD_UNAVAILABLE",
    });
    // No streamer gate query → TRADE_DISABLED cannot confirm a hidden id exists.
    expect(pg.selectCalls).toHaveLength(4);
    expect(pg.insertCalls).toHaveLength(0);

    const fields = pg.selectCalls[3].fields as Record<string, unknown>;
    const visible = render(fields.visible);
    expect(visible.sql).toContain('visible_card.id = "cards"."id"');
    expect(visible.params).toEqual([OFFER.offerer_user_id]);
    const where = render(pg.selectCalls[3].where);
    expect(where.sql).toContain('"cards"."is_active" = $');
  });

  it("replays by requestId before the is_active / visibility checks", async () => {
    const pg = createDbMock({
      selects: [userRow(OFFER.offerer_user_id, "viewer-1"), { rows: [OFFER] }],
    });
    primeDb(pg);

    const { createTradeOffer } = await import("@/lib/trade");
    await expect(createTradeOffer(input)).resolves.toEqual({
      kind: "ok",
      offer: OFFER,
      idempotentReplay: true,
    });
    expect(pg.selectCalls).toHaveLength(2);
  });
});

describe("listMyTradeOffers status filter / paging (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ACCEPTOR_ID = "20000000-0000-4000-8000-000000000077";

  it("filters by status in SQL, pages at 20 and resolves acceptedBy without a canAccept query", async () => {
    const completed = {
      ...OFFER,
      status: "completed",
      accepted_by_user_id: ACCEPTOR_ID,
      completed_at: "2026-10-04T01:00:00.000Z",
    };
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...completed,
      id: `10000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    }));
    const pg = createDbMock({
      selects: [
        userRow(OFFER.offerer_user_id, "viewer-1"),
        { rows },
        { rows: [] },
        {
          rows: [
            { id: OFFER.offerer_user_id, twitchUsername: "o", twitchDisplayName: "O", twitchProfileImageUrl: null },
            { id: ACCEPTOR_ID, twitchUsername: "a", twitchDisplayName: "Acceptor", twitchProfileImageUrl: "https://example.test/a.png" },
          ],
        },
      ],
    });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    const result = await listMyTradeOffers("viewer-1", { status: "completed", page: 2 });

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.hasMore).toBe(true);
    expect(result.offers).toHaveLength(20);
    expect(result.offers[0]).toMatchObject({
      mineRole: "offerer",
      offeredUserCardId: OFFER.offered_user_card_id,
      acceptedBy: {
        twitchUsername: "a",
        twitchDisplayName: "Acceptor",
        twitchProfileImageUrl: "https://example.test/a.png",
      },
    });
    expect(result.offers[0]).not.toHaveProperty("canAccept");
    // user + page + 2 metadata queries; no can-accept ownership query.
    expect(pg.selectCalls).toHaveLength(4);

    const listCall = pg.selectCalls[1];
    expect(listCall.limit).toBe(21);
    expect(listCall.offset).toBe(20);
    const where = render(listCall.where);
    expect(where.sql).toContain('"trade_offers"."status" = $');
    expect(where.params).toContain("completed");
    expect(where.sql).toContain('"trade_offers"."accepted_by_user_id" = $');
  });

  it("omits the status condition when no status is given and returns an empty page for unknown users", async () => {
    const pg = createDbMock({ selects: [userRow(OFFER.offerer_user_id, "viewer-1"), { rows: [] }] });
    primeDb(pg);

    const { listMyTradeOffers } = await import("@/lib/trade");
    await expect(listMyTradeOffers("viewer-1")).resolves.toEqual({
      offers: [],
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    expect(render(pg.selectCalls[1].where).sql).not.toContain('"status"');

    const unknown = createDbMock({ selects: [{ rows: [] }] });
    primeDb(unknown);
    await expect(listMyTradeOffers("ghost", { status: "open", page: 3 })).resolves.toEqual({
      offers: [],
      page: 3,
      pageSize: 20,
      hasMore: false,
    });
    expect(unknown.selectCalls).toHaveLength(1);
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

    it("selects only the viewer's active copies of the channel and maps counts/flags", async () => {
      const pg = createDbMock({
        selects: [
          userRow(VIEWER_ID, "viewer-2"),
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

      const call = pg.selectCalls[1];
      const where = render(call.where);
      expect(where.sql).toContain('"user_cards"."user_id" = $');
      expect(where.sql).toContain('"cards"."streamer_id" = $');
      expect(where.sql).toContain('"cards"."is_active" = $');
      expect(where.params).toEqual([VIEWER_ID, STREAMER_ID, true]);
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

    it("logged in: visibility includes the viewer's ownership and maps isOwned", async () => {
      const pg = createDbMock({
        selects: [
          userRow(VIEWER_ID, "viewer-2"),
          { rows: [{ cardId: OFFER.wanted_card_id, name: "Want", rarity: "epic", imageUrl: null, isOwned: true }] },
        ],
      });
      primeDb(pg);
      const { listWantableCards } = await import("@/lib/trade");
      await expect(listWantableCards("viewer-2", STREAMER_ID)).resolves.toEqual([
        { cardId: OFFER.wanted_card_id, name: "Want", rarity: "epic", imageUrl: null, isOwned: true },
      ]);
      const where = render(pg.selectCalls[1].where);
      expect(where.sql).toContain("visible_owned.user_id = $");
      expect(where.params).toContain(VIEWER_ID);
      const fields = pg.selectCalls[1].fields as Record<string, unknown>;
      expect(render(fields.isOwned).sql).toContain('wanted_owned.card_id = "cards"."id"');
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
    it.each([
      ["base trade disabled", { tradeEnabled: false }],
      ["base cross disabled", { crossChannelTradeEnabled: false }],
    ])("returns [] when the %s, without looking up the viewer", async (_label, overrides) => {
      const pg = createDbMock({ selects: [{ rows: [streamerRow(overrides)] }] });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", STREAMER_ID)).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(1);
    });

    it("returns [] for an unknown viewer", async () => {
      const pg = createDbMock({ selects: [{ rows: [streamerRow()] }, { rows: [] }] });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("ghost", STREAMER_ID)).resolves.toEqual([]);
      expect(pg.selectCalls).toHaveLength(2);
    });

    it("selects owned ∩ trade+cross channels, excluding the base", async () => {
      const partner = {
        id: "50000000-0000-4000-8000-000000000002",
        twitchUsername: "partner",
        twitchDisplayName: "Partner",
        twitchProfileImageUrl: null,
      };
      const pg = createDbMock({
        selects: [{ rows: [streamerRow()] }, userRow(VIEWER_ID, "viewer-2"), { rows: [partner] }],
      });
      primeDb(pg);
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      await expect(listCrossTradePartnerStreamers("viewer-2", STREAMER_ID)).resolves.toEqual([partner]);

      const where = render(pg.selectCalls[2].where);
      expect(where.sql).toContain('"streamers"."id" <> $');
      expect(where.sql).toContain('"streamers"."trade_enabled" = $');
      expect(where.sql).toContain('"streamers"."cross_channel_trade_enabled" = $');
      expect(where.sql).toContain('partner_card.streamer_id = "streamers"."id"');
      expect(where.params).toEqual([STREAMER_ID, true, true, VIEWER_ID]);
    });
  });
});
