// Real-PostgreSQL contract test for trade auctions (#1791 PR-1).
//
// Drives the real service functions of src/lib/trade-auction.ts and
// src/lib/trade.ts — and through them the RPCs, the copy-lock functions and
// the trade_offers BEFORE INSERT trigger of 20261018030000_trade_auctions.sql —
// against a database with the PlanetScale baseline + every migration applied.
// Design: tasks/plans/issue-1791-trade-auction.md §8.
//
// Time boundaries are produced by moving ends_at / selection_deadline of a
// row into the past (the RPCs read clock_timestamp(), so nothing waits).
//
// Each test creates its own users and copies (twitch ids prefixed with
// "ta1791-"), so tests are independent of each other; the channels and card
// definitions are seeded once. Dedicated disposable PostgreSQL only (same
// policy as trade-visibility-pg.test.ts). Without TRADE_TEST_DATABASE_URL the
// suite is skipped.
//
// Local run (example):
//   apply db/planetscale baseline + grants + migrations (see ci.yml
//   "Apply PlanetScale baseline and additive migrations"), then
//   TRADE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55791/postgres \
//     npx vitest run tests/integration/trade-auction-pg.test.ts
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

const url = process.env.TRADE_TEST_DATABASE_URL;

const handle = vi.hoisted(() => ({
  current: null as null | { db: unknown; sql: unknown },
}));

vi.mock("@/lib/db/client", () => ({
  getDb: async () => {
    if (!handle.current) throw new Error("TRADE_TEST_DATABASE_URL handle not initialised");
    return handle.current;
  },
}));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: async (fn: () => Promise<unknown>) => fn(),
}));

const sql = url ? postgres(url, { max: 4, onnotice: () => {} }) : null;
if (sql) handle.current = { db: drizzle(sql, { schema }), sql };

// Deterministic ids for the shared seed (prefix 7e1b… is reserved for this suite).
const id = (n: number) => `7e1b0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S = {
  A: id(1), // trade + cross, names public
  B: id(2), // trade + cross, names public (cross partner of A)
  PRIV: id(3), // trade + cross, names private
  NOCROSS: id(4), // trade on, cross off
  OFF: id(5), // trade off
  READ: id(6), // trade + cross, names public; only used by the board test
};
const C = {
  A_MAIN: id(11),
  A_COIN: id(12),
  A_GEM: id(13),
  A_RETIRED: id(14),
  B_COIN: id(21),
  PRIV_SECRET: id(31),
  NOCROSS_COIN: id(41),
  OFF_COIN: id(51),
  READ_GEM: id(61),
};
const USER_PREFIX = "ta1791-";

async function cleanup() {
  if (!sql) return;
  const users = sql`SELECT id FROM users WHERE twitch_user_id LIKE ${`${USER_PREFIX}%`}`;
  await sql`DELETE FROM trade_auctions WHERE seller_user_id IN (${users})`;
  await sql`DELETE FROM trade_auction_bids WHERE bidder_user_id IN (${users})`;
  await sql`DELETE FROM trade_offers WHERE offerer_user_id IN (${users}) OR accepted_by_user_id IN (${users})`;
  await sql`DELETE FROM user_cards WHERE user_id IN (${users})`;
  await sql`DELETE FROM users WHERE twitch_user_id LIKE ${`${USER_PREFIX}%`}`;
  await sql`DELETE FROM cards WHERE streamer_id IN ${sql(Object.values(S))}`;
  await sql`DELETE FROM streamers WHERE id IN ${sql(Object.values(S))}`;
}

async function seed() {
  const s = sql!;
  const streamer = (
    sid: string,
    name: string,
    flags: { trade: boolean; cross: boolean; reveal: boolean },
  ) => s`
    INSERT INTO streamers (
      id, twitch_user_id, twitch_username, twitch_display_name,
      trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
    ) VALUES (
      ${sid}, ${`ta-${name}`}, ${`ta-${name}`}, ${`TA ${name}`},
      ${flags.trade}, ${flags.cross}, ${flags.reveal}, ${flags.reveal}
    )`;
  await streamer(S.A, "a", { trade: true, cross: true, reveal: true });
  await streamer(S.B, "b", { trade: true, cross: true, reveal: true });
  await streamer(S.PRIV, "priv", { trade: true, cross: true, reveal: false });
  await streamer(S.NOCROSS, "nocross", { trade: true, cross: false, reveal: true });
  await streamer(S.OFF, "off", { trade: false, cross: true, reveal: true });
  await streamer(S.READ, "read", { trade: true, cross: true, reveal: true });

  const card = (cid: string, sid: string, name: string, active = true) =>
    s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
      VALUES (${cid}, ${sid}, ${name}, 'common', 0.1, ${active})`;
  await card(C.A_MAIN, S.A, "A Main");
  await card(C.A_COIN, S.A, "A Coin");
  await card(C.A_GEM, S.A, "A Gem");
  await card(C.A_RETIRED, S.A, "A Retired", false);
  await card(C.B_COIN, S.B, "B Coin");
  await card(C.PRIV_SECRET, S.PRIV, "Secret");
  await card(C.NOCROSS_COIN, S.NOCROSS, "NoCross Coin");
  await card(C.OFF_COIN, S.OFF, "Off Coin");
  await card(C.READ_GEM, S.READ, "Read Gem");
}

/** A fresh user; returns its twitch id and users.id. */
async function newUser(label: string) {
  const twitch = `${USER_PREFIX}${label}-${randomUUID().slice(0, 8)}`;
  const rows = await sql!`
    INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
    VALUES (${twitch}, ${twitch}, ${label}) RETURNING id`;
  return { twitch, id: rows[0].id as string };
}

/** `n` copies of `cardId` for `userId`, oldest first. */
async function giveCopies(userId: string, cardId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const rows = await sql!`
      INSERT INTO user_cards (user_id, card_id, obtained_at)
      VALUES (${userId}, ${cardId}, now() - make_interval(secs => ${1000 - i}))
      RETURNING id`;
    ids.push(rows[0].id as string);
  }
  return ids;
}

async function ownerOf(userCardId: string) {
  const rows = await sql!`SELECT user_id FROM user_cards WHERE id = ${userCardId}`;
  return (rows[0]?.user_id as string | undefined) ?? null;
}

/** Bidding ended a minute ago; the selection window is still open. */
async function endBidding(auctionId: string) {
  await sql!`
    UPDATE trade_auctions
    SET ends_at = clock_timestamp() - interval '1 minute',
        selection_deadline = clock_timestamp() + interval '1 hour'
    WHERE id = ${auctionId}`;
}

/** Both the bidding and the selection window are over. */
async function endSelection(auctionId: string) {
  await sql!`
    UPDATE trade_auctions
    SET ends_at = clock_timestamp() - interval '2 hours',
        selection_deadline = clock_timestamp() - interval '1 minute'
    WHERE id = ${auctionId}`;
}

async function bidItems(bidId: string) {
  const rows = await sql!`
    SELECT user_card_id FROM trade_auction_bid_items WHERE bid_id = ${bidId} ORDER BY user_card_id`;
  return rows.map((row) => row.user_card_id as string);
}

const svc = () => import("@/lib/trade-auction");
const trade = () => import("@/lib/trade");

async function createAuction(twitch: string, userCardId: string, durationHours: 24 | 72 | 168 = 24) {
  const { createTradeAuction } = await svc();
  return createTradeAuction({ twitchUserId: twitch, offeredUserCardId: userCardId, durationHours, requestId: randomUUID() });
}

async function createAuctionOk(twitch: string, userCardId: string) {
  const result = await createAuction(twitch, userCardId);
  if (result.kind !== "ok") throw new Error(`create failed: ${result.code}`);
  return result.auction.id;
}

async function placeBid(twitch: string, auctionId: string, bidCardId: string, quantity: number, requestId = randomUUID()) {
  const { placeTradeAuctionBid } = await svc();
  return placeTradeAuctionBid({ twitchUserId: twitch, auctionId, bidCardId, quantity, requestId });
}

async function placeBidOk(twitch: string, auctionId: string, bidCardId: string, quantity: number) {
  const result = await placeBid(twitch, auctionId, bidCardId, quantity);
  if (result.kind !== "ok") throw new Error(`bid failed: ${result.code}`);
  return result.bid.id;
}

async function createOffer(twitch: string, userCardId: string, wantedCardId: string, wantedQuantity = 1) {
  const { createTradeOffer } = await trade();
  return createTradeOffer({ twitchUserId: twitch, offeredUserCardId: userCardId, wantedCardId, wantedQuantity, requestId: randomUUID() });
}

/** INSERT a regular offer directly (bypasses the app precheck → the trigger decides). */
async function insertOfferDirectly(offererId: string, userCardId: string, offeredCardId: string, wantedCardId: string) {
  await sql!`
    INSERT INTO trade_offers (
      offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
      wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
    ) VALUES (
      ${offererId}, ${userCardId}, ${offeredCardId}, ${S.A}, ${wantedCardId}, ${S.A},
      '{"name":"x","rarity":"common","imageUrl":null}'::jsonb,
      '{"name":"y","rarity":"common","imageUrl":null}'::jsonb
    )`;
}

describe.skipIf(!sql)("trade auctions on actual PostgreSQL", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    await sql?.end();
  });

  // ---------------------------------------------------------------------------
  // Copy locks: every combination of regular offer × auction listing × bid
  // ---------------------------------------------------------------------------
  describe("copy locks", () => {
    it("an auction listing locks its copy against offers (precheck and trigger), auctions and the listing form", async () => {
      const seller = await newUser("seller");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      await createAuctionOk(seller.twitch, copy);

      await expect(createOffer(seller.twitch, copy, C.A_COIN))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });
      // The trigger is authoritative even without the app precheck.
      await expect(insertOfferDirectly(seller.id, copy, C.A_MAIN, C.A_COIN))
        .rejects.toMatchObject({ code: "P0001", message: "TRADE_CARD_LOCKED" });
      await expect(createAuction(seller.twitch, copy))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });

      const { listTradeableOwnedCopies } = await trade();
      const copies = await listTradeableOwnedCopies(seller.twitch, S.A);
      expect(copies.find((row) => row.userCardId === copy)?.isListed).toBe(true);
    });

    it("an open regular offer locks its copy against auctions and bids", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [listed] = await giveCopies(seller.id, C.A_MAIN, 1);
      await expect(createOffer(seller.twitch, listed, C.A_COIN)).resolves.toMatchObject({ kind: "ok" });
      await expect(createAuction(seller.twitch, listed))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });

      // The bidder's only coin is listed in a regular offer → not usable for a bid.
      const [auctionCopy] = await giveCopies(seller.id, C.A_GEM, 1);
      const auctionId = await createAuctionOk(seller.twitch, auctionCopy);
      const [bidderCoin] = await giveCopies(bidder.id, C.A_COIN, 1);
      await expect(createOffer(bidder.twitch, bidderCoin, C.A_MAIN)).resolves.toMatchObject({ kind: "ok" });
      await expect(placeBid(bidder.twitch, auctionId, C.A_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_NOT_ENOUGH_CARDS" });
    });

    it("an active bid locks its copies against offers (precheck and trigger), auctions and other bids", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [a1, a2] = await giveCopies(seller.id, C.A_MAIN, 2);
      const auction1 = await createAuctionOk(seller.twitch, a1);
      const auction2 = await createAuctionOk(seller.twitch, a2);
      const coins = await giveCopies(bidder.id, C.A_COIN, 3);

      const bidId = await placeBidOk(bidder.twitch, auction1, C.A_COIN, 2);
      const locked = await bidItems(bidId);
      // Oldest copies first.
      expect(locked).toEqual([coins[0], coins[1]].sort());

      await expect(createOffer(bidder.twitch, coins[0], C.A_MAIN))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });
      await expect(insertOfferDirectly(bidder.id, coins[1], C.A_COIN, C.A_MAIN))
        .rejects.toMatchObject({ code: "P0001", message: "TRADE_CARD_LOCKED" });
      await expect(createAuction(bidder.twitch, coins[0]))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });

      // Only one free coin remains for a second auction.
      await expect(placeBid(bidder.twitch, auction2, C.A_COIN, 2))
        .resolves.toEqual({ kind: "error", code: "TRADE_NOT_ENOUGH_CARDS" });
      const second = await placeBidOk(bidder.twitch, auction2, C.A_COIN, 1);
      expect(await bidItems(second)).toEqual([coins[2]]);
    });

    it("accept_trade_offer pays only with copies that are not locked by bids or auctions", async () => {
      const offerer = await newUser("offerer");
      const acceptor = await newUser("acceptor");
      const seller = await newUser("seller");
      const [auctionCopy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, auctionCopy);
      const coins = await giveCopies(acceptor.id, C.A_COIN, 2);
      const bidId = await placeBidOk(acceptor.twitch, auctionId, C.A_COIN, 1);
      expect(await bidItems(bidId)).toEqual([coins[0]]);

      const [gem1, gem2] = await giveCopies(offerer.id, C.A_GEM, 2);
      const twoCoins = await createOffer(offerer.twitch, gem1, C.A_COIN, 2);
      const oneCoin = await createOffer(offerer.twitch, gem2, C.A_COIN, 1);
      if (twoCoins.kind !== "ok" || oneCoin.kind !== "ok") throw new Error("offer setup failed");

      const { listTradeOffers, acceptTradeOffer } = await trade();
      const board = await listTradeOffers({ streamerId: S.A, scope: "in_channel", page: 1, twitchUserId: acceptor.twitch });
      expect(board.offers.find((o) => o.id === twoCoins.offer.id)?.canAccept).toBe("all_listed");
      expect(board.offers.find((o) => o.id === oneCoin.offer.id)?.canAccept).toBe("yes");

      await expect(acceptTradeOffer({ twitchUserId: acceptor.twitch, tradeOfferId: twoCoins.offer.id, requestId: randomUUID(), expectedQuantity: 2 }))
        .resolves.toEqual({ success: false, error: "CARD_NOT_OWNED" });
      const accepted = await acceptTradeOffer({ twitchUserId: acceptor.twitch, tradeOfferId: oneCoin.offer.id, requestId: randomUUID(), expectedQuantity: 1 });
      expect(accepted).toMatchObject({ success: true, givenUserCardId: coins[1] });
      // The bid copy stayed with the bidder and is still in the bid.
      expect(await ownerOf(coins[0])).toBe(acceptor.id);
      expect(await bidItems(bidId)).toEqual([coins[0]]);
    });

    it("a bid change withdraws the previous bid and may reuse its copies; a failed change keeps it", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      const coins = await giveCopies(bidder.id, C.A_COIN, 2);

      const first = await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 2);
      await expect(placeBid(bidder.twitch, auctionId, C.A_COIN, 3))
        .resolves.toEqual({ kind: "error", code: "TRADE_NOT_ENOUGH_CARDS" });
      const [{ status: stillActive }] = await sql!`SELECT status FROM trade_auction_bids WHERE id = ${first}`;
      expect(stillActive).toBe("active");

      const changed = await placeBid(bidder.twitch, auctionId, C.A_COIN, 2);
      expect(changed).toMatchObject({ kind: "ok", replacedBidId: first });
      if (changed.kind !== "ok") throw new Error("unreachable");
      expect(await bidItems(changed.bid.id)).toEqual([...coins].sort());
      const [{ status: replaced }] = await sql!`SELECT status FROM trade_auction_bids WHERE id = ${first}`;
      expect(replaced).toBe("withdrawn");
      const active = await sql!`SELECT count(*)::int AS n FROM trade_auction_bids WHERE auction_id = ${auctionId} AND status = 'active'`;
      expect(active[0].n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Time boundaries (clock_timestamp() after the auction row lock)
  // ---------------------------------------------------------------------------
  describe("time boundaries", () => {
    it("bidding closes at ends_at; settling needs ends_at <= t < selection_deadline", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.A_COIN, 2);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 1);

      const { settleTradeAuction } = await svc();
      await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_STILL_BIDDING" });

      await endBidding(auctionId);
      await expect(placeBid(bidder.twitch, auctionId, C.A_COIN, 2))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_OPEN" });
      // Selecting: the card stays locked while a bid is active.
      const [{ held }] = await sql!`SELECT public.trade_copy_locked(${copy}::uuid) AS held`;
      expect(held).toBe(true);

      await endSelection(auctionId);
      await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_EXPIRED" });
    });

    it("no bids at ends_at: expired immediately, the card is released and reusable for offers and payment", async () => {
      const seller = await newUser("seller");
      const acceptor = await newUser("acceptor");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await endBidding(auctionId); // selection window still open, but no bids

      const [{ held }] = await sql!`SELECT public.trade_auction_holds_cards(${auctionId}::uuid) AS held`;
      expect(held).toBe(false);
      const { getTradeAuction } = await svc();
      const detail = await getTradeAuction({ auctionId, twitchUserId: seller.twitch });
      expect(detail?.auction.phase).toBe("expired");

      // Released copy: usable to pay for someone else's offer.
      const [gem] = await giveCopies(acceptor.id, C.A_GEM, 1);
      const offer = await createOffer(acceptor.twitch, gem, C.A_MAIN);
      if (offer.kind !== "ok") throw new Error("offer setup failed");
      const { acceptTradeOffer } = await trade();
      await expect(acceptTradeOffer({ twitchUserId: seller.twitch, tradeOfferId: offer.offer.id, requestId: randomUUID(), expectedQuantity: 1 }))
        .resolves.toMatchObject({ success: true, givenUserCardId: copy });
    });

    it("after the selection window every copy is released and can be listed again", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      const [coin] = await giveCopies(bidder.id, C.A_COIN, 1);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 1);
      await endSelection(auctionId);

      // Seller re-auctions the copy, bidder lists the coin as a regular offer.
      await expect(createAuction(seller.twitch, copy)).resolves.toMatchObject({ kind: "ok" });
      await expect(createOffer(bidder.twitch, coin, C.A_MAIN)).resolves.toMatchObject({ kind: "ok" });

      const { listMyTradeAuctions } = await svc();
      const mine = await listMyTradeAuctions(bidder.twitch, { role: "bidding" });
      const row = mine.auctions.find((auction) => auction.id === auctionId);
      expect(row?.phase).toBe("expired");
      expect(row?.myBid).toMatchObject({ id: bidId, status: "active", state: "released" });
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------
  describe("cancel", () => {
    it("is allowed with zero active bids before and after the deadline, and is idempotent", async () => {
      const seller = await newUser("seller");
      const [c1, c2] = await giveCopies(seller.id, C.A_MAIN, 2);
      const before = await createAuctionOk(seller.twitch, c1);
      const after = await createAuctionOk(seller.twitch, c2);
      await endBidding(after);

      const { cancelTradeAuction } = await svc();
      await expect(cancelTradeAuction({ twitchUserId: seller.twitch, auctionId: before }))
        .resolves.toEqual({ kind: "ok", auctionId: before, alreadyCancelled: false });
      await expect(cancelTradeAuction({ twitchUserId: seller.twitch, auctionId: before }))
        .resolves.toEqual({ kind: "ok", auctionId: before, alreadyCancelled: true });
      await expect(cancelTradeAuction({ twitchUserId: seller.twitch, auctionId: after }))
        .resolves.toMatchObject({ kind: "ok", alreadyCancelled: false });
      // Released: listable as a regular offer.
      await expect(createOffer(seller.twitch, c1, C.A_COIN)).resolves.toMatchObject({ kind: "ok" });
    });

    it("is refused while a bid is active, allowed after it is withdrawn, and hidden from others", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.A_COIN, 1);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 1);

      const { cancelTradeAuction, withdrawTradeAuctionBid } = await svc();
      await expect(cancelTradeAuction({ twitchUserId: bidder.twitch, auctionId }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_FOUND" });
      await expect(cancelTradeAuction({ twitchUserId: seller.twitch, auctionId }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_HAS_BIDS" });
      await expect(withdrawTradeAuctionBid({ twitchUserId: bidder.twitch, bidId }))
        .resolves.toEqual({ kind: "ok", bidId, alreadyWithdrawn: false });
      await expect(withdrawTradeAuctionBid({ twitchUserId: bidder.twitch, bidId }))
        .resolves.toEqual({ kind: "ok", bidId, alreadyWithdrawn: true });
      await expect(cancelTradeAuction({ twitchUserId: seller.twitch, auctionId }))
        .resolves.toMatchObject({ kind: "ok" });
    });
  });

  // ---------------------------------------------------------------------------
  // Settle
  // ---------------------------------------------------------------------------
  describe("settle", () => {
    it("moves ownership both ways in one transaction, marks other bids lost and replays idempotently", async () => {
      const seller = await newUser("seller");
      const winner = await newUser("winner");
      const loser = await newUser("loser");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      const winnerCoins = await giveCopies(winner.id, C.A_COIN, 3);
      const loserGems = await giveCopies(loser.id, C.A_GEM, 1);
      const winningBid = await placeBidOk(winner.twitch, auctionId, C.A_COIN, 3);
      const losingBid = await placeBidOk(loser.twitch, auctionId, C.A_GEM, 1);
      await endBidding(auctionId);

      const { settleTradeAuction } = await svc();
      const requestId = randomUUID();
      const settled = await settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: winningBid, requestId });
      expect(settled).toMatchObject({
        kind: "ok",
        auctionId,
        bidId: winningBid,
        givenUserCardId: copy,
        quantity: 3,
        idempotentReplay: false,
      });
      if (settled.kind !== "ok") throw new Error("unreachable");
      expect([...settled.receivedUserCardIds].sort()).toEqual([...winnerCoins].sort());

      expect(await ownerOf(copy)).toBe(winner.id);
      for (const coin of winnerCoins) expect(await ownerOf(coin)).toBe(seller.id);
      expect(await ownerOf(loserGems[0])).toBe(loser.id);
      const statuses = await sql!`SELECT id, status FROM trade_auction_bids WHERE auction_id = ${auctionId}`;
      expect(Object.fromEntries(statuses.map((row) => [row.id, row.status])))
        .toEqual({ [winningBid]: "won", [losingBid]: "lost" });
      const [auction] = await sql!`SELECT status, winning_bid_id FROM trade_auctions WHERE id = ${auctionId}`;
      expect(auction).toMatchObject({ status: "completed", winning_bid_id: winningBid });

      // Released / moved copies are free for their new owners.
      const [{ free }] = await sql!`SELECT NOT public.trade_copy_locked(${loserGems[0]}::uuid) AS free`;
      expect(free).toBe(true);

      // Same requestId + bid → replay with the same transfer; anything else is refused.
      await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: winningBid, requestId }))
        .resolves.toMatchObject({ kind: "ok", idempotentReplay: true, givenUserCardId: copy, quantity: 3 });
      await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: winningBid, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_OPEN" });
      await expect(settleTradeAuction({ twitchUserId: winner.twitch, auctionId, bidId: winningBid, requestId }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_FOUND" });
    });

    it("refuses a bid whose copies are gone (count check) without moving anything; its bidder may withdraw", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      const coins = await giveCopies(bidder.id, C.A_COIN, 2);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 2);
      // A bid copy disappears outside the trade system (e.g. a future stone
      // exchange or manual deletion).
      await sql!`DELETE FROM user_cards WHERE id = ${coins[0]}`;
      await endBidding(auctionId);

      const { settleTradeAuction, withdrawTradeAuctionBid } = await svc();
      await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_BID_INVALID" });
      expect(await ownerOf(copy)).toBe(seller.id);
      expect(await ownerOf(coins[1])).toBe(bidder.id);
      await expect(withdrawTradeAuctionBid({ twitchUserId: bidder.twitch, bidId }))
        .resolves.toMatchObject({ kind: "ok", alreadyWithdrawn: false });
    });

    it("settleable bids cannot be withdrawn while selecting; trade_wantable=false or a disabled channel make them unsettleable and withdrawable", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const other = await newUser("other");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.A_GEM, 1);
      await giveCopies(other.id, C.A_COIN, 1);
      const gemBid = await placeBidOk(bidder.twitch, auctionId, C.A_GEM, 1);
      const coinBid = await placeBidOk(other.twitch, auctionId, C.A_COIN, 1);
      await endBidding(auctionId);

      const { settleTradeAuction, withdrawTradeAuctionBid, getTradeAuction } = await svc();
      await expect(withdrawTradeAuctionBid({ twitchUserId: bidder.twitch, bidId: gemBid }))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_BID_LOCKED" });

      await sql!`UPDATE cards SET trade_wantable = false WHERE id = ${C.A_GEM}`;
      try {
        await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: gemBid, requestId: randomUUID() }))
          .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_NOT_WANTABLE" });
        const detail = await getTradeAuction({ auctionId, twitchUserId: seller.twitch });
        expect(detail?.bids?.find((bid) => bid.id === gemBid)?.settleable).toBe(false);
        expect(detail?.bids?.find((bid) => bid.id === coinBid)?.settleable).toBe(true);
        await expect(withdrawTradeAuctionBid({ twitchUserId: bidder.twitch, bidId: gemBid }))
          .resolves.toMatchObject({ kind: "ok" });
      } finally {
        await sql!`UPDATE cards SET trade_wantable = true WHERE id = ${C.A_GEM}`;
      }

      await sql!`UPDATE streamers SET trade_enabled = false WHERE id = ${S.A}`;
      try {
        await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: coinBid, requestId: randomUUID() }))
          .resolves.toEqual({ kind: "error", code: "TRADE_DISABLED" });
        await expect(withdrawTradeAuctionBid({ twitchUserId: other.twitch, bidId: coinBid }))
          .resolves.toMatchObject({ kind: "ok" });
      } finally {
        await sql!`UPDATE streamers SET trade_enabled = true WHERE id = ${S.A}`;
      }
      // Nothing moved.
      expect(await ownerOf(copy)).toBe(seller.id);
    });

    it("refuses a bid on a card that was retired after bidding", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.A_GEM, 1);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.A_GEM, 1);
      await endBidding(auctionId);
      await sql!`UPDATE cards SET is_active = false WHERE id = ${C.A_GEM}`;
      try {
        const { settleTradeAuction } = await svc();
        await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId, requestId: randomUUID() }))
          .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_BID_INVALID" });
      } finally {
        await sql!`UPDATE cards SET is_active = true WHERE id = ${C.A_GEM}`;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Bid validation
  // ---------------------------------------------------------------------------
  describe("bid validation", () => {
    it("refuses self bids, the same card kind, non-wantable cards and disabled channels", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      await giveCopies(seller.id, C.A_COIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.A_MAIN, 1);
      await giveCopies(bidder.id, C.A_COIN, 1);
      await giveCopies(bidder.id, C.OFF_COIN, 1);
      await giveCopies(bidder.id, C.NOCROSS_COIN, 1);

      await expect(placeBid(seller.twitch, auctionId, C.A_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_SELF_BID" });
      await expect(placeBid(bidder.twitch, auctionId, C.A_MAIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_SAME_CARD" });
      await expect(placeBid(bidder.twitch, auctionId, C.OFF_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_DISABLED" });
      await expect(placeBid(bidder.twitch, auctionId, C.NOCROSS_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_DISABLED" });
      await sql!`UPDATE cards SET trade_wantable = false WHERE id = ${C.A_COIN}`;
      try {
        await expect(placeBid(bidder.twitch, auctionId, C.A_COIN, 1))
          .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_NOT_WANTABLE" });
      } finally {
        await sql!`UPDATE cards SET trade_wantable = true WHERE id = ${C.A_COIN}`;
      }
      await expect(placeBid(bidder.twitch, auctionId, C.A_RETIRED, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_UNAVAILABLE" });
    });

    it("accepts a cross-channel bid when both channels allow it", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.B_COIN, 2);
      const bidId = await placeBidOk(bidder.twitch, auctionId, C.B_COIN, 2);
      const [row] = await sql!`SELECT is_cross_channel, bid_streamer_id FROM trade_auction_bids WHERE id = ${bidId}`;
      expect(row).toMatchObject({ is_cross_channel: true, bid_streamer_id: S.B });
    });

    it("requires the bid card to be visible to the seller and the offered card to the bidder", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      // Private channel card the seller has never owned: hidden from the seller.
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(bidder.id, C.PRIV_SECRET, 1);
      await expect(placeBid(bidder.twitch, auctionId, C.PRIV_SECRET, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_UNAVAILABLE" });

      // Auction of a private card the bidder does not own: indistinguishable from missing.
      const [secret] = await giveCopies(seller.id, C.PRIV_SECRET, 1);
      const hidden = await createAuctionOk(seller.twitch, secret);
      const outsider = await newUser("outsider");
      await giveCopies(outsider.id, C.B_COIN, 1);
      await expect(placeBid(outsider.twitch, hidden, C.B_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_NOT_FOUND" });
      const { getTradeAuction } = await svc();
      await expect(getTradeAuction({ auctionId: hidden, twitchUserId: outsider.twitch })).resolves.toBeNull();
      await expect(getTradeAuction({ auctionId: hidden })).resolves.toBeNull();
    });

    it("replays a bid by requestId and refuses the same requestId on another auction", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const [c1, c2] = await giveCopies(seller.id, C.A_MAIN, 2);
      const a1 = await createAuctionOk(seller.twitch, c1);
      const a2 = await createAuctionOk(seller.twitch, c2);
      await giveCopies(bidder.id, C.A_COIN, 2);
      const requestId = randomUUID();
      const first = await placeBid(bidder.twitch, a1, C.A_COIN, 1, requestId);
      expect(first).toMatchObject({ kind: "ok", idempotentReplay: false });
      const replay = await placeBid(bidder.twitch, a1, C.A_COIN, 1, requestId);
      expect(replay).toMatchObject({ kind: "ok", idempotentReplay: true });
      if (first.kind !== "ok" || replay.kind !== "ok") throw new Error("unreachable");
      expect(replay.bid.id).toBe(first.bid.id);
      await expect(placeBid(bidder.twitch, a2, C.A_COIN, 1, requestId))
        .resolves.toEqual({ kind: "error", code: "INVALID_REQUEST" });
    });

    it("limits a bidder to 10 active bids (a change of an existing bid does not count)", async () => {
      const sellerA = await newUser("seller-a");
      const sellerB = await newUser("seller-b");
      const bidder = await newUser("bidder");
      const auctions: string[] = [];
      for (const seller of [sellerA, sellerB]) {
        const copies = await giveCopies(seller.id, C.A_MAIN, 6);
        for (const copy of copies) auctions.push(await createAuctionOk(seller.twitch, copy));
      }
      await giveCopies(bidder.id, C.A_COIN, 12);
      for (const auctionId of auctions.slice(0, 10)) {
        await placeBidOk(bidder.twitch, auctionId, C.A_COIN, 1);
      }
      await expect(placeBid(bidder.twitch, auctions[10], C.A_COIN, 1))
        .resolves.toEqual({ kind: "error", code: "TRADE_AUCTION_BID_LIMIT" });
      // Changing one of the ten is still allowed.
      await expect(placeBid(bidder.twitch, auctions[0], C.A_COIN, 2)).resolves.toMatchObject({ kind: "ok" });
    });
  });

  // ---------------------------------------------------------------------------
  // Shared open-listing limit (regular offers + auctions)
  // ---------------------------------------------------------------------------
  describe("shared listing limit", () => {
    it("counts holding auctions against TRADE_MAX_OPEN_OFFERS for both kinds of listing, and releases on expiry", async () => {
      const seller = await newUser("seller");
      const copies = await giveCopies(seller.id, C.A_MAIN, 11);
      for (const copy of copies.slice(0, 9)) {
        await expect(createOffer(seller.twitch, copy, C.A_COIN)).resolves.toMatchObject({ kind: "ok" });
      }
      const auctionId = await createAuctionOk(seller.twitch, copies[9]);
      await expect(createOffer(seller.twitch, copies[10], C.A_COIN))
        .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_LIMIT" });
      await expect(createAuction(seller.twitch, copies[10]))
        .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_LIMIT" });

      await endBidding(auctionId); // no bids → expired → no longer counted
      await expect(createOffer(seller.twitch, copies[10], C.A_COIN)).resolves.toMatchObject({ kind: "ok" });
    });

    it("validates create arguments and ownership", async () => {
      const seller = await newUser("seller");
      const other = await newUser("other");
      const [copy] = await giveCopies(other.id, C.A_MAIN, 1);
      const [retired] = await giveCopies(seller.id, C.A_RETIRED, 1);
      const [offCopy] = await giveCopies(seller.id, C.OFF_COIN, 1);
      await expect(createAuction(seller.twitch, copy))
        .resolves.toEqual({ kind: "error", code: "TRADE_CARD_NOT_OWNED" });
      await expect(createAuction(seller.twitch, retired))
        .resolves.toEqual({ kind: "error", code: "TRADE_OFFERED_CARD_INACTIVE" });
      await expect(createAuction(seller.twitch, offCopy))
        .resolves.toEqual({ kind: "error", code: "TRADE_DISABLED" });
      const { createTradeAuction } = await svc();
      await expect(createTradeAuction({ twitchUserId: seller.twitch, offeredUserCardId: copy, durationHours: 12 as never, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "INVALID_REQUEST" });
      await expect(createTradeAuction({ twitchUserId: `${USER_PREFIX}nobody`, offeredUserCardId: copy, durationHours: 24, requestId: randomUUID() }))
        .resolves.toEqual({ kind: "error", code: "UNAUTHORIZED" });
    });

    it("stores ends_at = DB time + duration and selection_deadline = ends_at + 72h, and replays creates", async () => {
      const seller = await newUser("seller");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const { createTradeAuction } = await svc();
      const requestId = randomUUID();
      const created = await createTradeAuction({ twitchUserId: seller.twitch, offeredUserCardId: copy, durationHours: 168, requestId });
      if (created.kind !== "ok") throw new Error("create failed");
      const [row] = await sql!`
        SELECT extract(epoch FROM selection_deadline - ends_at)::int AS selection,
               extract(epoch FROM ends_at - created_at)::int AS duration
        FROM trade_auctions WHERE id = ${created.auction.id}`;
      expect(row.selection).toBe(72 * 3600);
      expect(Math.abs(row.duration - 168 * 3600)).toBeLessThan(5);
      await expect(createTradeAuction({ twitchUserId: seller.twitch, offeredUserCardId: copy, durationHours: 168, requestId }))
        .resolves.toMatchObject({ kind: "ok", idempotentReplay: true, auction: { id: created.auction.id } });
    });
  });

  // ---------------------------------------------------------------------------
  // Reads: board, detail (bid contents only for the seller / own bid), mine
  // ---------------------------------------------------------------------------
  describe("reads", () => {
    it("board lists bidding and selecting auctions with bid counts; bid contents only for the bidder's own bid", async () => {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const viewer = await newUser("viewer");
      // A channel of its own: other tests leave auctions in channel A that
      // would push these rows off the first page.
      const [c1, c2, c3] = await giveCopies(seller.id, C.READ_GEM, 3);
      const bidding = await createAuctionOk(seller.twitch, c1);
      const selecting = await createAuctionOk(seller.twitch, c2);
      const expired = await createAuctionOk(seller.twitch, c3);
      await giveCopies(bidder.id, C.A_COIN, 2);
      await placeBidOk(bidder.twitch, bidding, C.A_COIN, 1);
      await placeBidOk(bidder.twitch, selecting, C.A_COIN, 1);
      await endBidding(selecting);
      await endBidding(expired);

      const { listTradeAuctions, getTradeAuction } = await svc();
      const board = await listTradeAuctions({ streamerId: S.READ, scope: "in_channel", page: 1, twitchUserId: viewer.twitch });
      const byId = new Map(board.auctions.map((auction) => [auction.id, auction]));
      expect(byId.get(bidding)).toMatchObject({ phase: "bidding", bidCount: 1, isOwnAuction: false, myBid: null });
      expect(byId.get(selecting)).toMatchObject({ phase: "selecting", bidCount: 1 });
      expect(byId.has(expired)).toBe(false);
      expect(byId.get(bidding)).not.toHaveProperty("offeredUserCardId");

      const asBidder = await listTradeAuctions({ streamerId: S.READ, scope: "in_channel", page: 1, twitchUserId: bidder.twitch });
      expect(asBidder.auctions.find((auction) => auction.id === bidding)?.myBid)
        .toMatchObject({ quantity: 1, bidCardId: C.A_COIN, state: "active" });

      // Cross tab of channel B shows this channel's auctions (both allow
      // cross); a channel without cross trade shows none. Every page is read
      // because other tests' auctions share the cross listing.
      const allIds = async (streamerId: string) => {
        const ids: string[] = [];
        for (let page = 1; ; page += 1) {
          const result = await listTradeAuctions({ streamerId, scope: "cross_channel", page });
          ids.push(...result.auctions.map((auction) => auction.id));
          if (!result.hasMore) return ids;
        }
      };
      expect(await allIds(S.B)).toEqual(expect.arrayContaining([bidding, selecting]));
      expect(await allIds(S.NOCROSS)).toEqual([]);
      expect(await allIds(S.READ)).not.toContain(bidding);

      // Detail: the seller sees every bid with its bidder; others only the count.
      const asSeller = await getTradeAuction({ auctionId: bidding, twitchUserId: seller.twitch });
      expect(asSeller?.auction).toMatchObject({ isOwnAuction: true, offeredUserCardId: c1 });
      expect(asSeller?.bids).toHaveLength(1);
      expect(asSeller?.bids?.[0]).toMatchObject({ quantity: 1, bidder: { twitchUsername: bidder.twitch } });
      const asViewer = await getTradeAuction({ auctionId: bidding, twitchUserId: viewer.twitch });
      expect(asViewer).toMatchObject({ bids: null, auction: { bidCount: 1, myBid: null } });
      const anonymous = await getTradeAuction({ auctionId: bidding });
      expect(anonymous?.bids).toBeNull();
      expect(anonymous?.auction).not.toHaveProperty("myBid");
      // Expired auctions are only visible to participants.
      await expect(getTradeAuction({ auctionId: expired, twitchUserId: viewer.twitch })).resolves.toBeNull();
      await expect(getTradeAuction({ auctionId: expired, twitchUserId: seller.twitch }))
        .resolves.toMatchObject({ auction: { phase: "expired" } });
    });

    it("mine: selling and bidding views with won / lost states", async () => {
      const seller = await newUser("seller");
      const winner = await newUser("winner");
      const loser = await newUser("loser");
      const [copy] = await giveCopies(seller.id, C.A_MAIN, 1);
      const auctionId = await createAuctionOk(seller.twitch, copy);
      await giveCopies(winner.id, C.A_COIN, 1);
      await giveCopies(loser.id, C.A_GEM, 1);
      const winningBid = await placeBidOk(winner.twitch, auctionId, C.A_COIN, 1);
      await placeBidOk(loser.twitch, auctionId, C.A_GEM, 1);
      await endBidding(auctionId);
      const { settleTradeAuction, listMyTradeAuctions } = await svc();
      await settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: winningBid, requestId: randomUUID() });

      const selling = await listMyTradeAuctions(seller.twitch, { role: "selling" });
      expect(selling.auctions.map((auction) => [auction.id, auction.phase])).toEqual([[auctionId, "completed"]]);
      const won = await listMyTradeAuctions(winner.twitch, { role: "bidding" });
      expect(won.auctions[0].myBid).toMatchObject({ state: "won" });
      const lost = await listMyTradeAuctions(loser.twitch, { role: "bidding" });
      expect(lost.auctions[0].myBid).toMatchObject({ state: "lost" });
      await expect(listMyTradeAuctions(`${USER_PREFIX}nobody`, { role: "selling" }))
        .resolves.toMatchObject({ auctions: [], hasMore: false });
    });
  });
});
