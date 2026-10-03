import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
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
          }],
        },
        {
          rows: [{
            id: OFFER.wanted_card_id,
            streamerId: OFFER.wanted_streamer_id,
            name: "Want",
            rarity: "epic",
            imageUrl: "https://example.test/b.png",
            isActive: true,
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
