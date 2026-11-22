import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

// Issue #1791: service layer of trade auctions (src/lib/trade-auction.ts) with
// the DB mocked — RPC result validation / error mapping, the 40P01 retry, the
// deploy window, the visibility precheck of bids and the DTO rules of the
// reads. The SQL itself runs on real PostgreSQL in
// tests/integration/trade-auction-pg.test.ts.

// Route prelude for the #2061 boundary test in the withdraw describe below.
// The service is the real module (only the DB is mocked), so that test runs
// the exact path that used to answer 404 for an uppercase auction id.
const routeMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  validateCSRFToken: vi.fn(),
  checkRateLimit: vi.fn(),
  validateContentType: vi.fn(),
  recordApiError: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/session", () => ({ getSession: routeMocks.getSession }));
vi.mock("@/lib/csrf", () => ({ validateCSRFToken: routeMocks.validateCSRFToken }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: routeMocks.checkRateLimit,
  getRateLimitIdentifier: vi.fn().mockResolvedValue("user:viewer-1"),
  rateLimits: { tradeWrite: { name: "tradeWrite" }, tradeRead: { name: "tradeRead" } },
}));
vi.mock("@/lib/request-validation", () => ({
  validateContentType: routeMocks.validateContentType,
}));
vi.mock("@/lib/error-handler", () => ({ recordApiError: routeMocks.recordApiError }));
vi.mock("@/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function render(fragment: unknown) {
  return new PgDialect().sqlToQuery(drizzleSql`${fragment as SQL}`);
}

type Step = { rows?: unknown[]; error?: unknown };

/** getDb() double: `sql` serves RPC calls, `db.select()` serves reads/prechecks. */
function prime(config: { rpc?: Step[]; selects?: Step[] } = {}) {
  let rpcIndex = 0;
  let selectIndex = 0;
  const rpcCalls: Array<{ text: string; values: unknown[] }> = [];
  const selectCalls: Array<Record<string, unknown>> = [];
  const resolve = (step: Step | undefined) =>
    step?.error ? Promise.reject(step.error) : Promise.resolve(step?.rows ?? []);

  const sqlTag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    rpcCalls.push({ text: strings.join("?"), values });
    return resolve((config.rpc ?? [])[rpcIndex++]);
  });
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: Record<string, unknown> = { fields };
      selectCalls.push(call);
      const step = (config.selects ?? [])[selectIndex++];
      const builder: any = {};
      for (const method of ["from", "leftJoin", "orderBy", "limit", "offset"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.where = vi.fn((where: unknown) => {
        call.where = where;
        return builder;
      });
      builder.then = (onFulfilled: never, onRejected: never) => resolve(step).then(onFulfilled, onRejected);
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: sqlTag } as never);
  return { rpcCalls, selectCalls };
}

const rpc = (result: unknown): Step => ({ rows: [{ result }] });
const deadlock = { code: "40P01", message: "deadlock detected" };
const missingRpc = (name: string) => ({
  code: "42883",
  message: `function public.${name} does not exist`,
});

const AUCTION_ID = "11111111-1111-4111-8111-111111111111";
const BID_ID = "22222222-2222-4222-8222-222222222222";
const COPY_ID = "33333333-3333-4333-8333-333333333333";
const CARD_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const SELLER_ID = "66666666-6666-4666-8666-666666666666";
const VIEWER_ID = "77777777-7777-4777-8777-777777777777";
// C3b: offeredCard と myBid.bidCard / bids[].bidCard を別々にマスクできる
// ことを確かめるための2枚目。UUID の形だけ満たせばよい。
const BID_CARD_ID = "88888888-8888-4888-8888-888888888888";

const okBidResult = {
  success: true,
  bid: { id: BID_ID, auction_id: AUCTION_ID, bid_card_id: CARD_ID, quantity: 2, status: "active" },
  replacedBidId: null,
  idempotentReplay: false,
};
/** Precheck row that lets the bid through to the RPC. */
const visibleRow = {
  bidderUserId: VIEWER_ID,
  sellerUserId: SELLER_ID,
  isReplay: false,
  offeredVisible: true,
  bidCardVisibleToBidder: true,
  bidCardVisibleToSeller: true,
};
const bidInput = {
  twitchUserId: "viewer",
  auctionId: AUCTION_ID,
  bidCardId: CARD_ID,
  quantity: 2,
  requestId: REQUEST_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RPC result mapping", () => {
  it.each([
    ["USER_NOT_FOUND", "UNAUTHORIZED"],
    ["INVALID_DURATION", "INVALID_REQUEST"],
    ["CARD_NOT_OWNED", "TRADE_CARD_NOT_OWNED"],
    ["OFFERED_CARD_INACTIVE", "TRADE_OFFERED_CARD_INACTIVE"],
    ["TRADE_DISABLED", "TRADE_DISABLED"],
    ["OFFER_LIMIT", "TRADE_OFFER_LIMIT"],
    ["CARD_ALREADY_LISTED", "TRADE_CARD_ALREADY_LISTED"],
  ])("create: %s → %s", async (error, code) => {
    prime({ rpc: [rpc({ success: false, error })] });
    const { createTradeAuction } = await import("@/lib/trade-auction");
    await expect(createTradeAuction({ twitchUserId: "s", offeredUserCardId: COPY_ID, durationHours: 24, requestId: REQUEST_ID }))
      .resolves.toEqual({ kind: "error", code });
  });

  it.each([
    ["AUCTION_NOT_FOUND", "TRADE_AUCTION_NOT_FOUND"],
    ["AUCTION_NOT_OPEN", "TRADE_AUCTION_NOT_OPEN"],
    ["SELF_BID_FORBIDDEN", "TRADE_AUCTION_SELF_BID"],
    ["SAME_CARD", "TRADE_SAME_CARD"],
    ["BID_CARD_UNAVAILABLE", "TRADE_BID_CARD_UNAVAILABLE"],
    ["BID_CARD_NOT_WANTABLE", "TRADE_BID_CARD_NOT_WANTABLE"],
    ["BID_LIMIT", "TRADE_AUCTION_BID_LIMIT"],
    ["NOT_ENOUGH_CARDS", "TRADE_NOT_ENOUGH_CARDS"],
    ["REQUEST_ID_CONFLICT", "INVALID_REQUEST"],
    ["INVALID_QUANTITY", "INVALID_REQUEST"],
  ])("bid: %s → %s", async (error, code) => {
    prime({ selects: [{ rows: [visibleRow] }], rpc: [rpc({ success: false, error })] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toEqual({ kind: "error", code });
  });

  it.each([
    ["BID_NOT_FOUND", "TRADE_AUCTION_BID_NOT_FOUND"],
    ["BID_NOT_ACTIVE", "TRADE_AUCTION_BID_NOT_ACTIVE"],
    ["BID_WITHDRAW_LOCKED", "TRADE_AUCTION_BID_LOCKED"],
  ])("withdraw: %s → %s", async (error, code) => {
    prime({ rpc: [rpc({ success: false, error })] });
    const { withdrawTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(withdrawTradeAuctionBid({ twitchUserId: "b", bidId: BID_ID })).resolves.toEqual({ kind: "error", code });
  });

  it.each([
    ["AUCTION_HAS_BIDS", "TRADE_AUCTION_HAS_BIDS"],
    ["AUCTION_NOT_OPEN", "TRADE_AUCTION_NOT_OPEN"],
  ])("cancel: %s → %s", async (error, code) => {
    prime({ rpc: [rpc({ success: false, error })] });
    const { cancelTradeAuction } = await import("@/lib/trade-auction");
    await expect(cancelTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID })).resolves.toEqual({ kind: "error", code });
  });

  it.each([
    ["AUCTION_STILL_BIDDING", "TRADE_AUCTION_STILL_BIDDING"],
    ["AUCTION_EXPIRED", "TRADE_AUCTION_EXPIRED"],
    ["AUCTION_BID_INVALID", "TRADE_AUCTION_BID_INVALID"],
    ["BID_CARD_NOT_WANTABLE", "TRADE_BID_CARD_NOT_WANTABLE"],
    ["TRADE_DISABLED", "TRADE_DISABLED"],
  ])("settle: %s → %s", async (error, code) => {
    prime({ rpc: [rpc({ success: false, error })] });
    const { settleTradeAuction } = await import("@/lib/trade-auction");
    await expect(settleTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID, bidId: BID_ID, requestId: REQUEST_ID }))
      .resolves.toEqual({ kind: "error", code });
  });

  it("throws (→ 500) on an unknown error code or a malformed payload instead of reporting success", async () => {
    const { cancelTradeAuction, createTradeAuction } = await import("@/lib/trade-auction");
    prime({ rpc: [rpc({ success: false, error: "SOMETHING_NEW" })] });
    await expect(cancelTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID })).rejects.toThrow(/unknown error/);
    prime({ rpc: [rpc(null)] });
    await expect(cancelTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID })).rejects.toThrow(/invalid response/);
    prime({ rpc: [rpc({ success: true, auction: { id: "not-a-uuid" } })] });
    await expect(createTradeAuction({ twitchUserId: "s", offeredUserCardId: COPY_ID, durationHours: 24, requestId: REQUEST_ID }))
      .rejects.toThrow(/invalid auction id/);
  });

  it("settle: a received-copy count different from the quantity is a contract violation", async () => {
    prime({
      rpc: [rpc({
        success: true, auctionId: AUCTION_ID, bidId: BID_ID, givenUserCardId: COPY_ID,
        receivedUserCardIds: [CARD_ID], quantity: 2, completedAt: "t", idempotentReplay: false,
      })],
    });
    const { settleTradeAuction } = await import("@/lib/trade-auction");
    await expect(settleTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID, bidId: BID_ID, requestId: REQUEST_ID }))
      .rejects.toThrow(/transfer count mismatch/);
  });

  it("settle: returns every moved copy", async () => {
    prime({
      rpc: [rpc({
        success: true, auctionId: AUCTION_ID, bidId: BID_ID, givenUserCardId: COPY_ID,
        receivedUserCardIds: [CARD_ID, REQUEST_ID], quantity: 2, completedAt: "t", idempotentReplay: true,
      })],
    });
    const { settleTradeAuction } = await import("@/lib/trade-auction");
    await expect(settleTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID, bidId: BID_ID, requestId: REQUEST_ID }))
      .resolves.toEqual({
        kind: "ok", auctionId: AUCTION_ID, bidId: BID_ID, givenUserCardId: COPY_ID,
        receivedUserCardIds: [CARD_ID, REQUEST_ID], quantity: 2, completedAt: "t", idempotentReplay: true,
      });
  });

  it("passes typed arguments to the RPC", async () => {
    const pg = prime({ rpc: [rpc({ success: true, auction: { id: AUCTION_ID, ends_at: "e", selection_deadline: "s", status: "open" }, idempotentReplay: false })] });
    const { createTradeAuction } = await import("@/lib/trade-auction");
    await createTradeAuction({ twitchUserId: "s", offeredUserCardId: COPY_ID, durationHours: 168, requestId: REQUEST_ID });
    expect(pg.rpcCalls[0].text).toContain("public.create_trade_auction(");
    expect(pg.rpcCalls[0].text).toContain("::integer");
    expect(pg.rpcCalls[0].values).toEqual(["s", COPY_ID, 168, REQUEST_ID]);
  });
});

// #2061: before the RPC, withdrawTradeAuctionBid compares the [id] path value
// with bids.auction_id exactly as Drizzle returned it. PostgreSQL prints uuid
// values in lowercase, so an uppercase path value never matches even though
// the database would treat both as the same uuid. The fix normalizes at the
// API boundary; these fixtures pin the service contract (lowercase in, match)
// and reproduce the pre-fix mismatch.
describe("withdraw path auction-id check (#2061)", () => {
  const HEX_AUCTION_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const HEX_BID_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

  it("reproduces the 404 when an uppercase auctionId reaches the service unnormalized", async () => {
    prime({ selects: [{ rows: [{ auctionId: HEX_AUCTION_ID }] }] });
    const { withdrawTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(withdrawTradeAuctionBid({
      twitchUserId: "b",
      bidId: HEX_BID_ID,
      auctionId: HEX_AUCTION_ID.toUpperCase(),
    })).resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_BID_NOT_FOUND" });
  });

  it("matches the bid's auction after the boundary normalized the id", async () => {
    const pg = prime({
      selects: [{ rows: [{ auctionId: HEX_AUCTION_ID }] }],
      rpc: [rpc({ success: true, bidId: HEX_BID_ID, alreadyWithdrawn: false })],
    });
    const { withdrawTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(withdrawTradeAuctionBid({
      twitchUserId: "b",
      bidId: HEX_BID_ID,
      auctionId: HEX_AUCTION_ID,
    })).resolves.toEqual({ kind: "ok", bidId: HEX_BID_ID, alreadyWithdrawn: false });
    expect(pg.rpcCalls).toHaveLength(1);
  });

  it("POST withdraw answers 200 for uppercase path ids after boundary normalization (#2061)", async () => {
    routeMocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
    routeMocks.validateContentType.mockReturnValue(null);
    routeMocks.validateCSRFToken.mockResolvedValue({ valid: true });
    routeMocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    routeMocks.recordApiError.mockResolvedValue(undefined);
    prime({
      selects: [{ rows: [{ auctionId: HEX_AUCTION_ID }] }],
      rpc: [rpc({ success: true, bidId: HEX_BID_ID, alreadyWithdrawn: false })],
    });

    const { POST } = await import(
      "@/app/api/trades/auctions/[id]/bids/[bidId]/withdraw/route"
    );
    const response = await POST(
      new NextRequest(
        `http://localhost/api/trades/auctions/${HEX_AUCTION_ID.toUpperCase()}`
        + `/bids/${HEX_BID_ID.toUpperCase()}/withdraw`,
        { method: "POST", headers: { "content-type": "application/json" } },
      ),
      {
        params: Promise.resolve({
          id: HEX_AUCTION_ID.toUpperCase(),
          bidId: HEX_BID_ID.toUpperCase(),
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      bidId: HEX_BID_ID,
      alreadyWithdrawn: false,
    });
  });
});

describe("40P01 and the deploy window", () => {
  it("retries a deadlock once with the same arguments", async () => {
    const pg = prime({ rpc: [{ error: deadlock }, rpc({ success: true, auctionId: AUCTION_ID, alreadyCancelled: false })] });
    const { cancelTradeAuction } = await import("@/lib/trade-auction");
    await expect(cancelTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID }))
      .resolves.toEqual({ kind: "ok", auctionId: AUCTION_ID, alreadyCancelled: false });
    expect(pg.rpcCalls).toHaveLength(2);
    expect(pg.rpcCalls[1].values).toEqual(pg.rpcCalls[0].values);
  });

  it("reports TRADE_BUSY after the second deadlock", async () => {
    const pg = prime({ rpc: [{ error: deadlock }, { error: deadlock }] });
    const { withdrawTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(withdrawTradeAuctionBid({ twitchUserId: "b", bidId: BID_ID }))
      .resolves.toEqual({ kind: "error", code: "TRADE_BUSY" });
    expect(pg.rpcCalls).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const other = { code: "23505", message: "duplicate key" };
    const pg = prime({ rpc: [{ error: other }] });
    const { cancelTradeAuction } = await import("@/lib/trade-auction");
    await expect(cancelTradeAuction({ twitchUserId: "s", auctionId: AUCTION_ID })).rejects.toBe(other);
    expect(pg.rpcCalls).toHaveLength(1);
  });

  it("a missing RPC (42883) is TRADE_AUCTION_UNAVAILABLE; an unrelated 42883 is not", async () => {
    const { createTradeAuction } = await import("@/lib/trade-auction");
    prime({ rpc: [{ error: missingRpc("create_trade_auction(text, uuid, integer, uuid)") }] });
    await expect(createTradeAuction({ twitchUserId: "s", offeredUserCardId: COPY_ID, durationHours: 24, requestId: REQUEST_ID }))
      .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_UNAVAILABLE" });
    const unrelated = missingRpc("something_else(uuid)");
    prime({ rpc: [{ error: unrelated }] });
    await expect(createTradeAuction({ twitchUserId: "s", offeredUserCardId: COPY_ID, durationHours: 24, requestId: REQUEST_ID }))
      .rejects.toBe(unrelated);
  });

  it("the bid precheck on a missing table (42P01) is TRADE_AUCTION_UNAVAILABLE without calling the RPC", async () => {
    const pg = prime({ selects: [{ error: { code: "42P01", message: 'relation "public.trade_auctions" does not exist' } }] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_UNAVAILABLE" });
    expect(pg.rpcCalls).toHaveLength(0);
  });

  it("reads throw TradeAuctionUnavailableError on a missing table and rethrow anything else", async () => {
    const { listTradeAuctions, getTradeAuction, listMyTradeAuctions, TradeAuctionUnavailableError } = await import("@/lib/trade-auction");
    const missing = { code: "42P01", message: 'relation "public.trade_auctions" does not exist' };
    prime({ selects: [{ error: missing }, { error: missing }, { error: missing }] });
    await expect(listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1 })).rejects.toBeInstanceOf(TradeAuctionUnavailableError);
    await expect(getTradeAuction({ auctionId: AUCTION_ID })).rejects.toBeInstanceOf(TradeAuctionUnavailableError);
    await expect(listMyTradeAuctions("v", { role: "selling" })).rejects.toBeInstanceOf(TradeAuctionUnavailableError);
    const other = new Error("boom");
    prime({ selects: [{ error: other }] });
    await expect(listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1 })).rejects.toBe(other);
  });
});

describe("bid visibility precheck (planning review M8)", () => {
  it.each([
    ["offered card hidden from the bidder", { offeredVisible: false }, "TRADE_AUCTION_NOT_FOUND"],
    ["bid card hidden from the bidder", { bidCardVisibleToBidder: false }, "TRADE_BID_CARD_UNAVAILABLE"],
    ["bid card hidden from the seller", { bidCardVisibleToSeller: false }, "TRADE_BID_CARD_UNAVAILABLE"],
  ])("%s → %s without calling the RPC", async (_label, overrides, code) => {
    const pg = prime({ selects: [{ rows: [{ ...visibleRow, ...overrides }] }] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toEqual({ kind: "error", code });
    expect(pg.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["an idempotent replay", { isReplay: true, offeredVisible: false }],
    ["a self bid (the RPC answers SELF_BID)", { sellerUserId: VIEWER_ID, offeredVisible: false }],
    ["an unknown user", { bidderUserId: null, offeredVisible: false }],
  ])("delegates %s to the RPC", async (_label, overrides) => {
    const pg = prime({ selects: [{ rows: [{ ...visibleRow, ...overrides }] }], rpc: [rpc(okBidResult)] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toMatchObject({ kind: "ok" });
    expect(pg.rpcCalls).toHaveLength(1);
  });

  it("delegates an unknown auction to the RPC", async () => {
    const pg = prime({ selects: [{ rows: [] }], rpc: [rpc({ success: false, error: "AUCTION_NOT_FOUND" })] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_FOUND" });
    expect(pg.rpcCalls).toHaveLength(1);
  });

  it("checks the bid card against the seller's ownership through the qualified outer column", async () => {
    const pg = prime({ selects: [{ rows: [visibleRow] }], rpc: [rpc(okBidResult)] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await placeTradeAuctionBid(bidInput);
    const fields = pg.selectCalls[0].fields as Record<string, unknown>;
    const seller = render(fields.bidCardVisibleToSeller).sql;
    expect(seller).toContain('visible_card.id = "bid_card"."id"');
    expect(seller).toContain('visible_owned.user_id = "trade_auctions"."seller_user_id"');
    expect(render(fields.offeredVisible).sql).toContain('visible_card.id = "trade_auctions"."offered_card_id"');
  });
});

const auctionRow = (overrides: Record<string, unknown> = {}) => ({
  auction: {
    id: AUCTION_ID,
    seller_user_id: SELLER_ID,
    offered_user_card_id: COPY_ID,
    offered_card_id: CARD_ID,
    offered_streamer_id: AUCTION_ID,
    offered_card_snapshot: { name: "Main", rarity: "rare", imageUrl: null },
    ends_at: "2026-10-18T00:00:00Z",
    selection_deadline: "2026-10-21T00:00:00Z",
    status: "open",
    winning_bid_id: null,
    request_id: REQUEST_ID,
    settle_request_id: null,
    completed_at: null,
    created_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  },
  phase: "bidding",
  bidCount: "3",
  viewerUserId: VIEWER_ID,
  myBid: null,
  seller: { id: SELLER_ID, twitchUsername: "seller", twitchDisplayName: "Seller", twitchProfileImageUrl: null },
  offeredStreamer: { id: AUCTION_ID, twitchUsername: "ch", twitchDisplayName: "Ch", twitchProfileImageUrl: null },
  ...overrides,
});


describe("read DTOs", () => {
  it("board: the copy id only for the seller; a bidder's own bid with its derived state", async () => {
    prime({
      selects: [{
        rows: [
          auctionRow({ viewerUserId: SELLER_ID }),
          auctionRow({
            myBid: {
              id: BID_ID, auctionId: AUCTION_ID, bidCardId: CARD_ID, bidStreamerId: AUCTION_ID,
              bidCard: { name: "Coin", rarity: "common", imageUrl: null }, quantity: 2,
              isCrossChannel: false, status: "active", holds: false, settleable: true, createdAt: "c",
            },
          }),
          auctionRow({ viewerUserId: null }),
        ],
      }],
    });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1, twitchUserId: "v" });
    const [own, bidder, anonymous] = result.auctions;
    expect(own).toMatchObject({ isOwnAuction: true, offeredUserCardId: COPY_ID, bidCount: 3 });
    expect(own).not.toHaveProperty("myBid");
    expect(bidder).not.toHaveProperty("offeredUserCardId");
    expect(bidder.myBid).toMatchObject({ id: BID_ID, quantity: 2, state: "released", settleable: true });
    expect(anonymous).not.toHaveProperty("isOwnAuction");
    expect(anonymous).not.toHaveProperty("myBid");
    expect(anonymous).not.toHaveProperty("offeredUserCardId");
  });

  it("detail: non-sellers get no bid list; the seller gets the list", async () => {
    const { getTradeAuction } = await import("@/lib/trade-auction");
    let pg = prime({ selects: [{ rows: [auctionRow()] }] });
    await expect(getTradeAuction({ auctionId: AUCTION_ID, twitchUserId: "v" })).resolves.toMatchObject({ bids: null });
    // ページ SELECT + maskTradeCards の可視性 SELECT（モックの行が空なので
    // 番号表クエリは発行されない）。
    expect(pg.selectCalls).toHaveLength(2);

    pg = prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: SELLER_ID, phase: "selecting" })] },
        {
          rows: [{
            bid: {
              id: BID_ID, auction_id: AUCTION_ID, bidder_user_id: VIEWER_ID, bid_card_id: CARD_ID,
              bid_streamer_id: AUCTION_ID, quantity: 4, bid_card_snapshot: { name: "Coin", rarity: "common", imageUrl: null },
              is_cross_channel: true, status: "active", request_id: REQUEST_ID, created_at: "c", updated_at: "u",
            },
            holds: true,
            settleable: false,
            bidder: { id: VIEWER_ID, twitchUsername: "bidder", twitchDisplayName: "Bidder", twitchProfileImageUrl: null },
          }],
        },
      ],
    });
    const detail = await getTradeAuction({ auctionId: AUCTION_ID, twitchUserId: "seller" });
    // ページ SELECT + 入札一覧 SELECT + maskTradeCards の可視性 SELECT。
    expect(pg.selectCalls).toHaveLength(3);
    expect(detail?.bids).toEqual([expect.objectContaining({
      id: BID_ID, quantity: 4, isCrossChannel: true, state: "active", settleable: false,
      bidder: { twitchUsername: "bidder", twitchDisplayName: "Bidder", twitchProfileImageUrl: null },
    })]);
  });

  it("detail: returns null when the statement finds nothing (hidden or missing)", async () => {
    prime({ selects: [{ rows: [] }] });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    await expect(getTradeAuction({ auctionId: AUCTION_ID })).resolves.toBeNull();
  });

  it("board pages at 20 with hasMore", async () => {
    prime({ selects: [{ rows: Array.from({ length: 21 }, () => auctionRow()) }] });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1 });
    expect(result.auctions).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });

  it("board: phase and the holds-cards filter come from DB time, cross scope needs both channels' cross flags", async () => {
    const pg = prime({ selects: [{ rows: [] }] });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    await listTradeAuctions({ streamerId: AUCTION_ID, scope: "cross_channel", page: 1 });
    const where = render(pg.selectCalls[0].where).sql;
    expect(where).toContain('public.trade_auction_holds_cards("trade_auctions"."id")');
    expect(where).toContain('"trade_auctions"."offered_streamer_id" <> $');
    expect(where).toContain("board_streamer.cross_channel_trade_enabled = TRUE");
    expect(where).toContain("cross_gate.cross_channel_trade_enabled = TRUE");
    const phase = render((pg.selectCalls[0].fields as Record<string, unknown>).phase).sql;
    expect(phase).toContain('clock_timestamp() < "trade_auctions"."ends_at"');
    expect(phase).not.toContain("now()");
  });

  // ---------------------------------------------------------------------------
  // C3b: オークションの全 DTO が maskTradeCards（名前・画像・#N）を通る。
  //
  // maskTradeCards は「可視性1クエリ + 配信者ごとの番号表1クエリ」の2回だけ
  // SELECT を発行する。ここではページ SELECT の後ろにその2回を並べ、
  // offeredCard / myBid.bidCard / bids[].bidCard のすべてが
  // name=""・imageUrl=null・collectionNumber 付きになることを固定する。
  // 実 SQL の可視性判定は tests/integration/trade-auction-pg.test.ts。
  // ---------------------------------------------------------------------------
  const maskRow = (cardId: string, streamerId: string, nameVisible: boolean, imageVisible: boolean) => ({
    cardId,
    streamerId,
    nameVisible,
    imageVisible,
  });
  const numberRow = (id: string, streamerId: string, cardNumber: number) => ({
    id,
    streamerId,
    cardNumber,
    createdAt: "2026-01-01T00:00:00Z",
  });

  it("board: offeredCard and myBid.bidCard are masked and numbered in one page", async () => {
    const pg = prime({
      selects: [
        {
          rows: [auctionRow({
            myBid: {
              id: BID_ID, auctionId: AUCTION_ID, bidCardId: BID_CARD_ID, bidStreamerId: AUCTION_ID,
              bidCard: { name: "Coin", rarity: "common", imageUrl: "https://img.example/coin.png" },
              quantity: 2, isCrossChannel: false, status: "active", holds: true, settleable: true, createdAt: "c",
            },
          })],
        },
        {
          rows: [
            maskRow(CARD_ID, AUCTION_ID, false, false),
            maskRow(BID_CARD_ID, AUCTION_ID, true, false),
          ],
        },
        {
          rows: [
            numberRow(CARD_ID, AUCTION_ID, 7),
            numberRow(BID_CARD_ID, AUCTION_ID, 8),
          ],
        },
      ],
    });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({
      streamerId: AUCTION_ID, scope: "in_channel", page: 1, twitchUserId: "v",
    });
    expect(result.auctions[0].offeredCard).toEqual({
      name: "", rarity: "rare", imageUrl: null, collectionNumber: 7,
    });
    expect(result.auctions[0].myBid?.bidCard).toEqual({
      name: "Coin", rarity: "common", imageUrl: null, collectionNumber: 8,
    });
    expect(pg.selectCalls).toHaveLength(3);
  });

  it("detail (seller): offeredCard and every bids[].bidCard are masked and numbered", async () => {
    prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: SELLER_ID })] },
        {
          rows: [{
            bid: {
              id: BID_ID, auction_id: AUCTION_ID, bidder_user_id: VIEWER_ID, bid_card_id: BID_CARD_ID,
              bid_streamer_id: AUCTION_ID, quantity: 1,
              bid_card_snapshot: { name: "Coin", rarity: "common", imageUrl: "https://img.example/coin.png" },
              is_cross_channel: false, status: "active", request_id: REQUEST_ID, created_at: "c", updated_at: "u",
            },
            holds: true,
            settleable: true,
            bidder: { id: VIEWER_ID, twitchUsername: "bidder", twitchDisplayName: "Bidder", twitchProfileImageUrl: null },
          }],
        },
        {
          rows: [
            maskRow(CARD_ID, AUCTION_ID, true, true),
            maskRow(BID_CARD_ID, AUCTION_ID, false, false),
          ],
        },
        {
          rows: [
            numberRow(CARD_ID, AUCTION_ID, 7),
            numberRow(BID_CARD_ID, AUCTION_ID, 8),
          ],
        },
      ],
    });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    const detail = await getTradeAuction({ auctionId: AUCTION_ID, twitchUserId: "seller" });
    expect(detail?.auction.offeredCard).toEqual({
      name: "Main", rarity: "rare", imageUrl: null, collectionNumber: 7,
    });
    expect(detail?.bids?.[0].bidCard).toEqual({
      name: "", rarity: "common", imageUrl: null, collectionNumber: 8,
    });
  });

  it("mine: the offered card and the viewer's own bid card are masked like the board", async () => {
    prime({
      selects: [
        {
          rows: [auctionRow({
            myBid: {
              id: BID_ID, auctionId: AUCTION_ID, bidCardId: BID_CARD_ID, bidStreamerId: AUCTION_ID,
              bidCard: { name: "Coin", rarity: "common", imageUrl: "https://img.example/coin.png" },
              quantity: 2, isCrossChannel: false, status: "active", holds: true, settleable: true, createdAt: "c",
            },
          })],
        },
        {
          rows: [
            maskRow(CARD_ID, AUCTION_ID, false, false),
            maskRow(BID_CARD_ID, AUCTION_ID, false, true),
          ],
        },
        {
          rows: [
            numberRow(CARD_ID, AUCTION_ID, 7),
            numberRow(BID_CARD_ID, AUCTION_ID, 8),
          ],
        },
      ],
    });
    const { listMyTradeAuctions } = await import("@/lib/trade-auction");
    const mine = await listMyTradeAuctions("v", { role: "bidding" });
    expect(mine.auctions[0].offeredCard).toEqual({
      name: "", rarity: "rare", imageUrl: null, collectionNumber: 7,
    });
    expect(mine.auctions[0].myBid?.bidCard).toEqual({
      name: "", rarity: "common", imageUrl: "https://img.example/coin.png", collectionNumber: 8,
    });
  });

  it("deleted definitions (null card id) stay name=\"\" / imageUrl=null / collectionNumber=null", async () => {
    const base = auctionRow();
    // カード定義が削除されると offered_card_id / bid_card_id は NULL になる。
    // この場合は可視性も番号も証明できないので、deny-by-default のまま返す。
    const row = {
      ...base,
      auction: { ...base.auction, offered_card_id: null },
      myBid: {
        id: BID_ID, auctionId: AUCTION_ID, bidCardId: null, bidStreamerId: AUCTION_ID,
        bidCard: { name: "Gone", rarity: "common", imageUrl: "https://img.example/gone.png" },
        quantity: 1, isCrossChannel: false, status: "active", holds: true, settleable: true, createdAt: "c",
      },
    };
    const pg = prime({ selects: [{ rows: [row] }] });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({
      streamerId: AUCTION_ID, scope: "in_channel", page: 1, twitchUserId: "v",
    });
    expect(result.auctions[0].offeredCard).toEqual({
      name: "", rarity: "rare", imageUrl: null, collectionNumber: null,
    });
    expect(result.auctions[0].myBid?.bidCard).toEqual({
      name: "", rarity: "common", imageUrl: null, collectionNumber: null,
    });
    // ID が1つも無いので maskTradeCards は DB へ問い合わせない。
    expect(pg.selectCalls).toHaveLength(1);
  });
});


// -----------------------------------------------------------------------------
// 未所持カードの項目別公開のデプロイ窓（オークション側、C3b）。
//
// C3b でオークションの読み取り SQL は行ルール（所持 OR show_unowned_cards）
// しか参照しなくなった。新3列 (show_unowned_card_name/_image/_description) を
// 読むのは応答直前の maskTradeCards() だけなので、42703 の再試行もそこだけに
// 残す。ページ SELECT を withUnownedCardItemColumnFallback で包む旧構造は、
// 中に項目列が無く「一度も発火しない死んだ層」になるため削除した。
//
// ここでは実在する縮退経路（マスクの可視性クエリが 42703 → 旧 details 規則で
// 1回だけ再試行 → 番号表）を固定する。旧 trade_unowned_card_names_visible
// (#2070) は通常時も再試行時も参照しない。
// -----------------------------------------------------------------------------
describe("unowned card item visibility deploy window (auctions)", () => {
  const MISSING_ITEM_COLUMN = {
    code: "42703",
    message: "column name_streamer.show_unowned_card_name does not exist",
  };
  const maskRow = (nameVisible: boolean, imageVisible: boolean) => ({
    cardId: CARD_ID,
    streamerId: AUCTION_ID,
    nameVisible,
    imageVisible,
  });
  const numberRow = {
    id: CARD_ID,
    streamerId: AUCTION_ID,
    cardNumber: 7,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("board: the page query does not depend on item columns; only the mask retries once", async () => {
    const pg = prime({
      selects: [
        { rows: [auctionRow()] },
        { error: MISSING_ITEM_COLUMN },
        { rows: [maskRow(true, true)] },
        { rows: [numberRow] },
      ],
    });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1 });
    expect(pg.selectCalls).toHaveLength(4);
    // 1回目（インデックス1）は新3列、再試行（インデックス2）は旧 details だけ。
    const before = pg.selectCalls[1].fields as Record<string, unknown>;
    const after = pg.selectCalls[2].fields as Record<string, unknown>;
    expect(render(before.nameVisible).sql).toContain("show_unowned_card_name");
    expect(render(after.nameVisible).sql).not.toContain("show_unowned_card_name");
    expect(render(after.nameVisible).sql).toContain("show_unowned_card_details");
    expect(result.auctions[0].offeredCard).toMatchObject({
      name: "Main", imageUrl: null, collectionNumber: 7,
    });
  });

  it("detail (seller): the bid mask retries once with the legacy details rule", async () => {
    const pg = prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: SELLER_ID })] },
        {
          rows: [{
            bid: {
              id: BID_ID, auction_id: AUCTION_ID, bidder_user_id: VIEWER_ID, bid_card_id: BID_CARD_ID,
              bid_streamer_id: AUCTION_ID, quantity: 1,
              bid_card_snapshot: { name: "Coin", rarity: "common", imageUrl: null },
              is_cross_channel: false, status: "active", request_id: REQUEST_ID, created_at: "c", updated_at: "u",
            },
            holds: true,
            settleable: true,
            bidder: { id: VIEWER_ID, twitchUsername: "bidder", twitchDisplayName: "Bidder", twitchProfileImageUrl: null },
          }],
        },
        { error: MISSING_ITEM_COLUMN },
        {
          rows: [
            { cardId: CARD_ID, streamerId: AUCTION_ID, nameVisible: true, imageVisible: true },
            { cardId: BID_CARD_ID, streamerId: AUCTION_ID, nameVisible: false, imageVisible: false },
          ],
        },
        {
          rows: [
            { ...numberRow },
            { ...numberRow, id: BID_CARD_ID, cardNumber: 8 },
          ],
        },
      ],
    });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    const detail = await getTradeAuction({ auctionId: AUCTION_ID, twitchUserId: "seller" });
    expect(pg.selectCalls).toHaveLength(5);
    const after = pg.selectCalls[3].fields as Record<string, unknown>;
    expect(render(after.nameVisible).sql).toContain("show_unowned_card_details");
    expect(render(after.nameVisible).sql).not.toContain("show_unowned_card_name");
    expect(detail?.bids?.[0].bidCard).toMatchObject({
      name: "", imageUrl: null, collectionNumber: 8,
    });
  });

  it("precheck: the row rule alone decides, so an all-items-private bid is still allowed", async () => {
    const pg = prime({ selects: [{ rows: [visibleRow] }], rpc: [rpc(okBidResult)] });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    await expect(placeTradeAuctionBid(bidInput)).resolves.toMatchObject({ kind: "ok" });
    const fields = pg.selectCalls[0].fields as Record<string, unknown>;
    for (const key of ["offeredVisible", "bidCardVisibleToBidder", "bidCardVisibleToSeller"]) {
      const sqlText = render(fields[key]).sql;
      // 入札可否は行ルールだけ。名前・画像の項目列は一切読まない。
      expect(sqlText).toContain("visible_streamer.show_unowned_cards = TRUE");
      expect(sqlText).not.toContain("show_unowned_card_name");
      expect(sqlText).not.toContain("show_unowned_card_image");
      expect(sqlText).not.toContain("show_unowned_card_description");
      expect(sqlText).not.toContain("trade_unowned_card_names_visible");
    }
    expect(pg.rpcCalls).toHaveLength(1);
  });

  it("rethrows an unrelated 42703 without retrying", async () => {
    const other = { code: "42703", message: 'column trade_auctions.some_other_column does not exist' };
    const pg = prime({ selects: [{ error: other }, { rows: [] }] });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    await expect(listTradeAuctions({ streamerId: AUCTION_ID, scope: "in_channel", page: 1 }))
      .rejects.toBe(other);
    expect(pg.selectCalls).toHaveLength(1);
  });
});
