import { beforeEach, describe, expect, it, vi } from "vitest";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

// Issue #1791: service layer of trade auctions (src/lib/trade-auction.ts) with
// the DB mocked — RPC result validation / error mapping, the 40P01 retry, the
// deploy window, the visibility precheck of bids and the DTO rules of the
// reads. The SQL itself runs on real PostgreSQL in
// tests/integration/trade-auction-pg.test.ts.

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

describe("read DTOs", () => {
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

  it("detail: non-sellers get no bid list and cost one statement; the seller gets the list", async () => {
    const { getTradeAuction } = await import("@/lib/trade-auction");
    let pg = prime({ selects: [{ rows: [auctionRow()] }] });
    await expect(getTradeAuction({ auctionId: AUCTION_ID, twitchUserId: "v" })).resolves.toMatchObject({ bids: null });
    expect(pg.selectCalls).toHaveLength(1);

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
    expect(pg.selectCalls).toHaveLength(2);
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
});
