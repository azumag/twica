// Real-PostgreSQL contract test for the trade "exchange-target restriction"
// (per offered card whitelist, 20261123000000_trade_wanted_restrictions.sql).
//
// The unit tests mock Drizzle and the migration test only pins the SQL text.
// Whether the rule really decides create / board / accept / auction bids (and
// whether deleting cards keeps the restriction closed) can only be proven by
// running it against a database that has the PlanetScale baseline + all
// migrations applied (same setup as trade-visibility-pg.test.ts).
//
// Dedicated disposable PostgreSQL only. Without TRADE_TEST_DATABASE_URL the
// whole suite is skipped. Local run (example):
//   TRADE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//     npx vitest run tests/integration/trade-wanted-restriction-pg.test.ts
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

// fetch_types: false is the production client setting (src/lib/db/client.ts): JS arrays cannot be
// bound and array columns / array_agg results are not parsed. The data layer under test must work
// under it, so this suite uses the same setting.
const sql = url ? postgres(url, { max: 4, onnotice: () => {}, fetch_types: false }) : null;
if (sql) handle.current = { db: drizzle(sql, { schema }), sql };

// Deterministic ids (prefix 7e1c… is reserved for this suite and cleaned up).
const id = (n: number) => `7e1c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_PREFIX = "restriction-pg-";

const S = { MAIN: id(1), OTHER: id(2), LIMIT: id(3) };
// A = the offered card of every test; C / D = whitelisted; E = not whitelisted.
const C = {
  A: id(11),
  B: id(12), // a second offered card without any rule
  C: id(13),
  D: id(14),
  E: id(15),
  OTHER: id(16), // a card of another channel (cross-channel)
};

async function cleanup() {
  const s = sql!;
  await s`DELETE FROM trade_auctions WHERE seller_user_id IN (SELECT id FROM users WHERE twitch_user_id LIKE ${USER_PREFIX + "%"})`;
  await s`DELETE FROM trade_offers WHERE offerer_user_id IN (SELECT id FROM users WHERE twitch_user_id LIKE ${USER_PREFIX + "%"})`;
  await s`DELETE FROM user_cards WHERE user_id IN (SELECT id FROM users WHERE twitch_user_id LIKE ${USER_PREFIX + "%"})`;
  await s`DELETE FROM users WHERE twitch_user_id LIKE ${USER_PREFIX + "%"}`;
  // Deleting the cards cascades to the rule tables.
  await s`DELETE FROM cards WHERE streamer_id IN (${S.MAIN}, ${S.OTHER}, ${S.LIMIT})`;
  await s`DELETE FROM streamers WHERE id IN (${S.MAIN}, ${S.OTHER}, ${S.LIMIT})`;
}

async function streamer(streamerId: string, name: string) {
  await sql!`INSERT INTO streamers (
    id, twitch_user_id, twitch_username, twitch_display_name,
    trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details,
    show_unowned_card_name, show_unowned_card_image, show_unowned_card_description
  ) VALUES (${streamerId}, ${"rs-" + name}, ${"rs-" + name}, ${name}, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)`;
}

async function card(cardId: string, streamerId: string, name: string) {
  await sql!`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
    VALUES (${cardId}, ${streamerId}, ${name}, 'common', 0.1, TRUE)`;
}

async function newUser(label: string) {
  const twitch = `${USER_PREFIX}${label}-${randomUUID().slice(0, 8)}`;
  const rows = await sql!`
    INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
    VALUES (${twitch}, ${twitch}, ${label}) RETURNING id`;
  return { twitch, id: rows[0].id as string };
}

/** `n` copies of `cardId` for `userId`, oldest first. */
async function giveCopies(userId: string, cardId: string, n = 1): Promise<string[]> {
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

/** Replace the whitelist of `offeredCardId` (the write API does the same in one transaction). */
async function setRule(offeredCardId: string, allowed: string[]) {
  await sql!`INSERT INTO trade_wanted_restriction_rules (offered_card_id) VALUES (${offeredCardId})
    ON CONFLICT (offered_card_id) DO UPDATE SET updated_at = now()`;
  await sql!`DELETE FROM trade_wanted_restriction_items WHERE offered_card_id = ${offeredCardId}`;
  for (const wanted of allowed) {
    await sql!`INSERT INTO trade_wanted_restriction_items (offered_card_id, wanted_card_id)
      VALUES (${offeredCardId}, ${wanted})`;
  }
}

async function clearRule(offeredCardId: string) {
  await sql!`DELETE FROM trade_wanted_restriction_rules WHERE offered_card_id = ${offeredCardId}`;
}

const trade = () => import("@/lib/trade");
const auctions = () => import("@/lib/trade-auction");

async function createOffer(twitch: string, userCardId: string, wantedCardId: string) {
  const { createTradeOffer } = await trade();
  return createTradeOffer({ twitchUserId: twitch, offeredUserCardId: userCardId, wantedCardId, requestId: randomUUID() });
}

async function createOfferOk(twitch: string, userCardId: string, wantedCardId: string) {
  const result = await createOffer(twitch, userCardId, wantedCardId);
  if (result.kind !== "ok") throw new Error(`create failed: ${result.code}`);
  return result.offer.id;
}

async function boardIds(viewerTwitch: string) {
  const { listTradeOffers } = await trade();
  const page = await listTradeOffers({
    streamerId: S.MAIN,
    scope: "in_channel",
    page: 1,
    twitchUserId: viewerTwitch,
  });
  return page.offers.map((offer) => offer.id);
}

async function rpc4(twitch: string, offerId: string) {
  const [row] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
    SELECT public.accept_trade_offer(${twitch}, ${offerId}::uuid, ${randomUUID()}::uuid, 1::smallint) AS result`;
  return row.result;
}

async function rpc3(twitch: string, offerId: string) {
  const [row] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
    SELECT public.accept_trade_offer(${twitch}, ${offerId}::uuid, ${randomUUID()}::uuid) AS result`;
  return row.result;
}

async function endBidding(auctionId: string) {
  await sql!`
    UPDATE trade_auctions
    SET ends_at = clock_timestamp() - interval '1 minute',
        selection_deadline = clock_timestamp() + interval '1 hour'
    WHERE id = ${auctionId}`;
}

describe.skipIf(!url)("trade exchange-target restriction (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanup();
    await streamer(S.MAIN, "main");
    await streamer(S.OTHER, "other");
    await card(C.A, S.MAIN, "A");
    await card(C.B, S.MAIN, "B");
    await card(C.C, S.MAIN, "C");
    await card(C.D, S.MAIN, "D");
    await card(C.E, S.MAIN, "E");
    await card(C.OTHER, S.OTHER, "Other");
  });

  afterAll(async () => {
    await cleanup();
    await sql?.end();
  });

  describe("regular offers", () => {
    it("no rule: every card can be requested (existing behaviour is unchanged)", async () => {
      const seller = await newUser("seller");
      const copies = await giveCopies(seller.id, C.A, 3);
      for (const [index, wanted] of [C.C, C.E, C.OTHER].entries()) {
        await expect(createOffer(seller.twitch, copies[index], wanted))
          .resolves.toMatchObject({ kind: "ok" });
      }
    });

    it("with a rule {C, D}: only C and D can be requested, and other cards / channels are refused", async () => {
      await setRule(C.A, [C.C, C.D]);
      try {
        const seller = await newUser("seller");
        const copies = await giveCopies(seller.id, C.A, 4);
        await expect(createOffer(seller.twitch, copies[0], C.E))
          .resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED" });
        // A cross-channel card is never in a same-channel whitelist.
        await expect(createOffer(seller.twitch, copies[0], C.OTHER))
          .resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED" });
        await expect(createOffer(seller.twitch, copies[0], C.C)).resolves.toMatchObject({ kind: "ok" });
        await expect(createOffer(seller.twitch, copies[1], C.D)).resolves.toMatchObject({ kind: "ok" });
      } finally {
        await clearRule(C.A);
      }
    });

    it("the rule is keyed by the OFFERED card: other offered cards and offers wanting A are not restricted", async () => {
      await setRule(C.A, [C.C]);
      try {
        const seller = await newUser("seller");
        const [b] = await giveCopies(seller.id, C.B, 1);
        const [e] = await giveCopies(seller.id, C.E, 1);
        await expect(createOffer(seller.twitch, b, C.E)).resolves.toMatchObject({ kind: "ok" });
        // Wanting A (instead of offering it) is not restricted by A's own rule.
        await expect(createOffer(seller.twitch, e, C.A)).resolves.toMatchObject({ kind: "ok" });
      } finally {
        await clearRule(C.A);
      }
    });

    it("ANDs with cards.trade_wantable", async () => {
      await setRule(C.A, [C.C]);
      await sql!`UPDATE cards SET trade_wantable = false WHERE id = ${C.C}`;
      try {
        const seller = await newUser("seller");
        const [a] = await giveCopies(seller.id, C.A, 1);
        await expect(createOffer(seller.twitch, a, C.C))
          .resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_NOT_WANTABLE" });
      } finally {
        await sql!`UPDATE cards SET trade_wantable = true WHERE id = ${C.C}`;
        await clearRule(C.A);
      }
    });

    it("an existing offer outside a newly set rule stays open but is hidden, unacceptable, and comes back when the rule is lifted", async () => {
      const seller = await newUser("seller");
      const buyer = await newUser("buyer");
      const [a] = await giveCopies(seller.id, C.A, 1);
      const [e] = await giveCopies(buyer.id, C.E, 1);
      const offerId = await createOfferOk(seller.twitch, a, C.E);
      expect(await boardIds(buyer.twitch)).toContain(offerId);

      await setRule(C.A, [C.C]);
      try {
        // Hidden from the board for everyone, still open, marked not tradeable on /mine.
        expect(await boardIds(buyer.twitch)).not.toContain(offerId);
        expect(await boardIds(seller.twitch)).not.toContain(offerId);
        const { listMyTradeOffers, acceptTradeOffer } = await trade();
        const mine = await listMyTradeOffers(seller.twitch, { status: "open" });
        expect(mine.offers.find((offer) => offer.id === offerId)?.tradeable).toBe(false);
        const [row] = await sql!`SELECT status FROM trade_offers WHERE id = ${offerId}`;
        expect(row.status).toBe("open");

        // Refused by the API precheck and, independently, by both RPC signatures.
        await expect(acceptTradeOffer({ twitchUserId: buyer.twitch, tradeOfferId: offerId, requestId: randomUUID() }))
          .resolves.toEqual({ success: false, error: "TRADE_OFFER_UNAVAILABLE" });
        await expect(rpc4(buyer.twitch, offerId))
          .resolves.toEqual({ success: false, error: "WANTED_CARD_NOT_ALLOWED_FOR_OFFERED" });
        // The pre-#1789 3-argument signature answers a code that app knows.
        await expect(rpc3(buyer.twitch, offerId))
          .resolves.toEqual({ success: false, error: "OFFER_NOT_OPEN" });
        expect(await ownerOf(a)).toBe(seller.id);
        expect(await ownerOf(e)).toBe(buyer.id);
      } finally {
        await clearRule(C.A);
      }

      // Lifting the rule restores the same offer, and it can be accepted.
      expect(await boardIds(buyer.twitch)).toContain(offerId);
      const { acceptTradeOffer } = await trade();
      const requestId = randomUUID();
      await expect(acceptTradeOffer({ twitchUserId: buyer.twitch, tradeOfferId: offerId, requestId }))
        .resolves.toMatchObject({ success: true, idempotentReplay: false });
      expect(await ownerOf(a)).toBe(buyer.id);
      expect(await ownerOf(e)).toBe(seller.id);

      // An accepted offer replays even if a rule that excludes it is set afterwards.
      await setRule(C.A, [C.C]);
      try {
        await expect(acceptTradeOffer({ twitchUserId: buyer.twitch, tradeOfferId: offerId, requestId }))
          .resolves.toMatchObject({ success: true, idempotentReplay: true });
      } finally {
        await clearRule(C.A);
      }
    });

    it("an offer inside the whitelist is accepted normally", async () => {
      await setRule(C.A, [C.C, C.D]);
      try {
        const seller = await newUser("seller");
        const buyer = await newUser("buyer");
        const [a] = await giveCopies(seller.id, C.A, 1);
        const [d] = await giveCopies(buyer.id, C.D, 1);
        const offerId = await createOfferOk(seller.twitch, a, C.D);
        const { acceptTradeOffer } = await trade();
        await expect(acceptTradeOffer({ twitchUserId: buyer.twitch, tradeOfferId: offerId, requestId: randomUUID() }))
          .resolves.toMatchObject({ success: true });
        expect(await ownerOf(a)).toBe(buyer.id);
        expect(await ownerOf(d)).toBe(seller.id);
      } finally {
        await clearRule(C.A);
      }
    });
  });

  describe("fail-closed storage", () => {
    it("a rule with no allowed card allows nothing, and deleting the last allowed card does not lift the restriction", async () => {
      // A dedicated whitelisted card so deleting it does not disturb the shared world.
      const lastAllowed = id(21);
      await card(lastAllowed, S.MAIN, "Last allowed");
      await setRule(C.A, [lastAllowed]);
      try {
        await sql!`DELETE FROM cards WHERE id = ${lastAllowed}`;
        const [{ count: items }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_items WHERE offered_card_id = ${C.A}`;
        const [{ count: rules }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_rules WHERE offered_card_id = ${C.A}`;
        expect(items).toBe(0); // the allowed card's row was removed by ON DELETE CASCADE
        expect(rules).toBe(1); // the rule survives: still restricted

        const seller = await newUser("seller");
        const [a] = await giveCopies(seller.id, C.A, 1);
        for (const wanted of [C.C, C.E]) {
          await expect(createOffer(seller.twitch, a, wanted))
            .resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED" });
        }
      } finally {
        await clearRule(C.A);
      }
    });

    it("deleting the offered card removes its rule and items; a card cannot allow itself", async () => {
      const temp = id(22);
      await card(temp, S.MAIN, "Temp");
      await setRule(temp, [C.C]);
      await sql!`DELETE FROM cards WHERE id = ${temp}`;
      const [{ count }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_items WHERE offered_card_id = ${temp}`;
      expect(count).toBe(0);
      const [{ count: ruleCount }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_rules WHERE offered_card_id = ${temp}`;
      expect(ruleCount).toBe(0);

      await sql!`INSERT INTO trade_wanted_restriction_rules (offered_card_id) VALUES (${C.A})`;
      try {
        await expect(sql!`INSERT INTO trade_wanted_restriction_items (offered_card_id, wanted_card_id) VALUES (${C.A}, ${C.A})`)
          .rejects.toMatchObject({ code: "23514" });
      } finally {
        await clearRule(C.A);
      }
    });
  });

  describe("settings data layer (the PUT API's writes and the UI's reads)", () => {
    const lib = () => import("@/lib/trade-wanted-restrictions");
    const allowedOf = async (offeredCardId: string) => {
      const rows = await sql!`SELECT wanted_card_id FROM trade_wanted_restriction_items
        WHERE offered_card_id = ${offeredCardId} ORDER BY wanted_card_id`;
      return rows.map((row) => row.wanted_card_id as string);
    };

    it("creates, replaces (not unions) and removes a rule; the replacement is idempotent", async () => {
      const { replaceTradeWantedRestriction } = await lib();
      const put = (allowed: string[]) =>
        replaceTradeWantedRestriction({ streamerId: S.MAIN, offeredCardId: C.A, allowedWantedCardIds: allowed });
      try {
        await expect(put([C.C, C.D])).resolves.toEqual({ kind: "ok", ruleRemoved: false });
        expect(await allowedOf(C.A)).toEqual([C.C, C.D].sort());
        await expect(put([C.D, C.E])).resolves.toEqual({ kind: "ok", ruleRemoved: false });
        expect(await allowedOf(C.A)).toEqual([C.D, C.E].sort());
        // The same final state again is a no-op, not an error (retry-safe).
        await expect(put([C.D, C.E])).resolves.toEqual({ kind: "ok", ruleRemoved: false });
        expect(await allowedOf(C.A)).toEqual([C.D, C.E].sort());
        await expect(put([])).resolves.toEqual({ kind: "ok", ruleRemoved: true });
        expect(await allowedOf(C.A)).toEqual([]);
        const [{ count }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_rules WHERE offered_card_id = ${C.A}`;
        expect(count).toBe(0);
        // Removing a rule that does not exist is fine too.
        await expect(put([])).resolves.toEqual({ kind: "ok", ruleRemoved: true });
      } finally {
        await clearRule(C.A);
      }
    });

    it("refuses cards that are not the streamer's (other channel, missing) without writing anything", async () => {
      const { replaceTradeWantedRestriction } = await lib();
      const put = (offeredCardId: string, allowed: string[]) =>
        replaceTradeWantedRestriction({ streamerId: S.MAIN, offeredCardId, allowedWantedCardIds: allowed });
      await expect(put(C.A, [C.OTHER])).resolves.toEqual({ kind: "error", code: "CARD_NOT_FOUND" });
      await expect(put(C.A, [id(999)])).resolves.toEqual({ kind: "error", code: "CARD_NOT_FOUND" });
      await expect(put(C.OTHER, [C.C])).resolves.toEqual({ kind: "error", code: "CARD_NOT_FOUND" });
      const [{ count }] = await sql!`SELECT count(*)::int AS count FROM trade_wanted_restriction_rules WHERE offered_card_id IN (${C.A}, ${C.OTHER})`;
      expect(count).toBe(0);
    });

    it("allows an inactive card in the whitelist, so a rule with a later-retired card can still be re-saved", async () => {
      const { replaceTradeWantedRestriction } = await lib();
      await sql!`UPDATE cards SET is_active = false WHERE id = ${C.E}`;
      try {
        await expect(replaceTradeWantedRestriction({
          streamerId: S.MAIN, offeredCardId: C.A, allowedWantedCardIds: [C.C, C.E],
        })).resolves.toEqual({ kind: "ok", ruleRemoved: false });
      } finally {
        await sql!`UPDATE cards SET is_active = true WHERE id = ${C.E}`;
        await clearRule(C.A);
      }
    });

    it("concurrent replacements of the same rule end in exactly one of the submitted sets (no union, no error)", async () => {
      const { replaceTradeWantedRestriction } = await lib();
      try {
        for (let round = 0; round < 8; round += 1) {
          const results = await Promise.all([
            replaceTradeWantedRestriction({ streamerId: S.MAIN, offeredCardId: C.A, allowedWantedCardIds: [C.C] }),
            replaceTradeWantedRestriction({ streamerId: S.MAIN, offeredCardId: C.A, allowedWantedCardIds: [C.D] }),
            replaceTradeWantedRestriction({ streamerId: S.MAIN, offeredCardId: C.A, allowedWantedCardIds: [C.E] }),
          ]);
          for (const result of results) expect(result).toEqual({ kind: "ok", ruleRemoved: false });
          const allowed = await allowedOf(C.A);
          expect(allowed).toHaveLength(1);
          expect([C.C, C.D, C.E]).toContain(allowed[0]);
          await clearRule(C.A);
        }
      } finally {
        await clearRule(C.A);
      }
    });

    it("caps the number of rules per streamer, but still lets an existing rule be edited at the cap", async () => {
      const { replaceTradeWantedRestriction, TRADE_WANTED_RESTRICTION_MAX_RULES } = await lib();
      await streamer(S.LIMIT, "limit");
      await sql!`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
        SELECT gen_random_uuid(), ${S.LIMIT}, 'L' || n, 'common', 0.1, TRUE
        FROM generate_series(1, ${TRADE_WANTED_RESTRICTION_MAX_RULES + 2}) AS n`;
      const limitCards = (await sql!`SELECT id FROM cards WHERE streamer_id = ${S.LIMIT} ORDER BY name`).map((row) => row.id as string);
      const target = limitCards[0];
      await sql!`INSERT INTO trade_wanted_restriction_rules (offered_card_id)
        SELECT id FROM cards WHERE streamer_id = ${S.LIMIT} ORDER BY name LIMIT ${TRADE_WANTED_RESTRICTION_MAX_RULES}`;
      // 201st rule is refused; the 200 existing rules are untouched.
      await expect(replaceTradeWantedRestriction({
        streamerId: S.LIMIT, offeredCardId: limitCards[TRADE_WANTED_RESTRICTION_MAX_RULES], allowedWantedCardIds: [target],
      })).resolves.toEqual({ kind: "error", code: "TOO_MANY_RULES" });
      // Editing one of the existing rules is not blocked by the cap.
      await expect(replaceTradeWantedRestriction({
        streamerId: S.LIMIT, offeredCardId: target, allowedWantedCardIds: [limitCards[1]],
      })).resolves.toEqual({ kind: "ok", ruleRemoved: false });
    });

    it("reads the settings: all cards (inactive included), and rules with empty ones kept", async () => {
      const { getTradeWantedRestrictionSettings } = await lib();
      await setRule(C.A, [C.C, C.D]);
      await setRule(C.B, []);
      try {
        const settings = await getTradeWantedRestrictionSettings(S.MAIN);
        expect(settings).not.toBeNull();
        expect(settings!.cards.map((card) => card.id).sort()).toEqual(
          [C.A, C.B, C.C, C.D, C.E].sort(),
        );
        expect(settings!.cards.every((card) => card.isActive)).toBe(true);
        expect(Object.keys(settings!.rules).sort()).toEqual([C.A, C.B].sort());
        expect([...settings!.rules[C.A]].sort()).toEqual([C.C, C.D].sort());
        // A rule whose allowed cards are all gone stays (restricted, nothing allowed).
        expect(settings!.rules[C.B]).toEqual([]);
        // Another channel's rules never show up here.
        expect((await getTradeWantedRestrictionSettings(S.OTHER))!.rules).toEqual({});
      } finally {
        await clearRule(C.A);
        await clearRule(C.B);
      }
    });

    it("builds the form's allowed map: only rules, intersected with the selectable cards (no hidden ids)", async () => {
      const { loadAllowedWantedByOffered } = await lib();
      await setRule(C.A, [C.C, C.D]);
      await setRule(C.B, [C.E]);
      try {
        // C.D is not selectable for this viewer (hidden): it must not appear.
        const map = await loadAllowedWantedByOffered(
          [C.A, C.B, C.C],
          new Set([C.C, C.E]),
        );
        expect(map).toEqual({ [C.A]: [C.C], [C.B]: [C.E] }); // C.C has no rule → no key
        // The whole-streamer variant (auction page) is covered by its own test below: its KEYS
        // must be filtered by what the viewer can see, not only its values.
        // No candidates → nothing is read.
        await expect(loadAllowedWantedByOffered([], new Set([C.C]))).resolves.toEqual({});
      } finally {
        await clearRule(C.A);
        await clearRule(C.B);
      }
    });
  });

  describe("auction detail: the restriction map of THIS auction's offered card", () => {
    const PRIVATE = id(4);
    const P = { HIDDEN: id(31), OWNED: id(32), SELECTABLE: id(33), RETIRED: id(34) };

    beforeAll(async () => {
      // A channel that does NOT reveal unowned cards: only owned cards are visible to a viewer.
      await sql!`INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details,
        show_unowned_card_name, show_unowned_card_image, show_unowned_card_description
      ) VALUES (${PRIVATE}, 'rs-private', 'rs-private', 'private', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE)`;
      for (const [cardId, name, active] of [
        [P.HIDDEN, "Hidden", true], [P.OWNED, "Owned", true], [P.SELECTABLE, "Selectable", true], [P.RETIRED, "Retired", false],
      ] as const) {
        await sql!`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
          VALUES (${cardId}, ${PRIVATE}, ${name}, 'common', 0.1, ${active})`;
      }
      await setRule(P.HIDDEN, [P.SELECTABLE]);
      await setRule(P.OWNED, [P.SELECTABLE]);
    });

    afterAll(async () => {
      await sql!`DELETE FROM trade_auctions WHERE offered_streamer_id = ${PRIVATE}`;
      await sql!`DELETE FROM cards WHERE streamer_id = ${PRIVATE}`;
      await sql!`DELETE FROM streamers WHERE id = ${PRIVATE}`;
    });

    /** An open auction row of `offeredCardId` (inserted directly: visibility is what is under test). */
    async function auctionOf(offeredCardId: string, streamerId: string) {
      const seller = await newUser("seller");
      const [copy] = await giveCopies(seller.id, offeredCardId, 1);
      const rows = await sql!`
        INSERT INTO trade_auctions (
          seller_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
          offered_card_snapshot, ends_at, selection_deadline, request_id
        ) VALUES (
          ${seller.id}, ${copy}, ${offeredCardId}, ${streamerId}, '{}'::jsonb,
          now() + interval '1 day', now() + interval '4 days', ${randomUUID()}
        ) RETURNING id`;
      return rows[0].id as string;
    }

    it("returns the rule of a visible offered card only; a card the viewer cannot see (or a retired one) yields nothing", async () => {
      const { loadAllowedBidCardsForAuction } = await import("@/lib/trade-wanted-restrictions");
      const viewer = await newUser("viewer");
      await giveCopies(viewer.id, P.OWNED, 1);
      const selectable = new Set([P.SELECTABLE]);

      // Visible to the viewer (they own a copy): the rule is returned, intersected with their candidates.
      await expect(loadAllowedBidCardsForAuction(await auctionOf(P.OWNED, PRIVATE), viewer.twitch, selectable))
        .resolves.toEqual({ [P.OWNED]: [P.SELECTABLE] });

      // The offered card is hidden from this viewer (not owned, channel hides unowned cards): the
      // auction id alone must not reveal that the card has a rule, nor the card's id.
      const hidden = await loadAllowedBidCardsForAuction(await auctionOf(P.HIDDEN, PRIVATE), viewer.twitch, selectable);
      expect(hidden).toEqual({});
      expect(JSON.stringify(hidden)).not.toContain(P.HIDDEN);

      // A retired offered card and an unknown auction id yield nothing.
      await expect(loadAllowedBidCardsForAuction(await auctionOf(P.RETIRED, PRIVATE), viewer.twitch, selectable))
        .resolves.toEqual({});
      await expect(loadAllowedBidCardsForAuction(randomUUID(), viewer.twitch, selectable)).resolves.toEqual({});
    });

    it("returns nothing for an auction the detail API would not show (trade disabled, ended without bids, cancelled), so a saved link reveals no rule", async () => {
      const { loadAllowedBidCardsForAuction } = await import("@/lib/trade-wanted-restrictions");
      const viewer = await newUser("viewer");
      await giveCopies(viewer.id, P.OWNED, 1);
      const selectable = new Set([P.SELECTABLE]);
      const auctionId = await auctionOf(P.OWNED, PRIVATE);
      const load = () => loadAllowedBidCardsForAuction(auctionId, viewer.twitch, selectable);
      // Baseline: an open auction that holds its card is shown.
      await expect(load()).resolves.toEqual({ [P.OWNED]: [P.SELECTABLE] });

      // The seller's channel stops trading: the detail API answers 404, so must this.
      await sql!`UPDATE streamers SET trade_enabled = FALSE WHERE id = ${PRIVATE}`;
      try {
        await expect(load()).resolves.toEqual({});
      } finally {
        await sql!`UPDATE streamers SET trade_enabled = TRUE WHERE id = ${PRIVATE}`;
      }

      // Bidding ended without any bid: the card is released (the auction no longer holds it).
      await sql!`UPDATE trade_auctions SET ends_at = now() - interval '1 hour',
        selection_deadline = now() + interval '1 hour' WHERE id = ${auctionId}`;
      await expect(load()).resolves.toEqual({});

      // Cancelled.
      await sql!`UPDATE trade_auctions SET ends_at = now() + interval '1 day',
        selection_deadline = now() + interval '4 days', status = 'cancelled' WHERE id = ${auctionId}`;
      await expect(load()).resolves.toEqual({});
    });

    it("cross-channel: the offered card's rule is read even though the bidder's cards are from another channel (nothing can be bid)", async () => {
      const { loadAllowedBidCardsForAuction } = await import("@/lib/trade-wanted-restrictions");
      const { placeTradeAuctionBid, createTradeAuction } = await auctions();
      await setRule(C.A, [C.C]);
      try {
        const seller = await newUser("seller");
        const bidder = await newUser("bidder");
        const [copy] = await giveCopies(seller.id, C.A, 1);
        await giveCopies(bidder.id, C.OTHER, 1);
        const created = await createTradeAuction({
          twitchUserId: seller.twitch, offeredUserCardId: copy, durationHours: 24, requestId: randomUUID(),
        });
        if (created.kind !== "ok") throw new Error(`auction create failed: ${created.code}`);

        // The bidder's channel is S.OTHER; its own rules (none) must not hide A's rule.
        const map = await loadAllowedBidCardsForAuction(created.auction.id, bidder.twitch, new Set([C.OTHER]));
        expect(map).toEqual({ [C.A]: [] });
        // And the RPC refuses exactly what the (empty) candidate list implies.
        await expect(placeTradeAuctionBid({
          twitchUserId: bidder.twitch, auctionId: created.auction.id, bidCardId: C.OTHER, quantity: 1, requestId: randomUUID(),
        })).resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_NOT_ALLOWED_FOR_OFFERED" });
      } finally {
        await clearRule(C.A);
      }
    });
  });

  describe("auctions", () => {
    async function auctionWithBidders() {
      const seller = await newUser("seller");
      const bidder = await newUser("bidder");
      const other = await newUser("other");
      const [copy] = await giveCopies(seller.id, C.A, 1);
      await giveCopies(bidder.id, C.C, 1);
      await giveCopies(other.id, C.E, 1);
      const { createTradeAuction } = await auctions();
      const created = await createTradeAuction({
        twitchUserId: seller.twitch,
        offeredUserCardId: copy,
        durationHours: 24,
        requestId: randomUUID(),
      });
      if (created.kind !== "ok") throw new Error(`auction create failed: ${created.code}`);
      return { seller, bidder, other, copy, auctionId: created.auction.id };
    }

    it("a bid card must be in the offered card's whitelist; without a rule nothing changes", async () => {
      const { bidder, other, auctionId } = await auctionWithBidders();
      const { placeTradeAuctionBid } = await auctions();
      const bid = (twitch: string, bidCardId: string) =>
        placeTradeAuctionBid({ twitchUserId: twitch, auctionId, bidCardId, quantity: 1, requestId: randomUUID() });

      // No rule: both bids are accepted.
      await expect(bid(other.twitch, C.E)).resolves.toMatchObject({ kind: "ok" });

      await setRule(C.A, [C.C]);
      try {
        const third = await newUser("third");
        await giveCopies(third.id, C.E, 1);
        await expect(bid(third.twitch, C.E))
          .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_NOT_ALLOWED_FOR_OFFERED" });
        await expect(bid(bidder.twitch, C.C)).resolves.toMatchObject({ kind: "ok" });
      } finally {
        await clearRule(C.A);
      }
    });

    it("a bid outside a rule set after bidding is unsettleable, withdrawable, and does not block the allowed bid", async () => {
      const { seller, bidder, other, copy, auctionId } = await auctionWithBidders();
      const { placeTradeAuctionBid, settleTradeAuction, withdrawTradeAuctionBid, getTradeAuction } = await auctions();
      const place = async (twitch: string, bidCardId: string) => {
        const result = await placeTradeAuctionBid({ twitchUserId: twitch, auctionId, bidCardId, quantity: 1, requestId: randomUUID() });
        if (result.kind !== "ok") throw new Error(`bid failed: ${result.code}`);
        return result.bid.id;
      };
      const allowedBid = await place(bidder.twitch, C.C);
      const outsideBid = await place(other.twitch, C.E);
      await endBidding(auctionId);

      await setRule(C.A, [C.C]);
      try {
        await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: outsideBid, requestId: randomUUID() }))
          .resolves.toEqual({ kind: "error", code: "TRADE_BID_CARD_NOT_ALLOWED_FOR_OFFERED" });
        const detail = await getTradeAuction({ auctionId, twitchUserId: seller.twitch });
        expect(detail?.bids?.find((bid) => bid.id === outsideBid)?.settleable).toBe(false);
        expect(detail?.bids?.find((bid) => bid.id === allowedBid)?.settleable).toBe(true);
        // The bidder of an unsettleable bid may withdraw it during the selection window.
        await expect(withdrawTradeAuctionBid({ twitchUserId: other.twitch, bidId: outsideBid }))
          .resolves.toMatchObject({ kind: "ok" });
        await expect(settleTradeAuction({ twitchUserId: seller.twitch, auctionId, bidId: allowedBid, requestId: randomUUID() }))
          .resolves.toMatchObject({ kind: "ok" });
        expect(await ownerOf(copy)).toBe(bidder.id);
      } finally {
        await clearRule(C.A);
      }
    });
  });
});
