// Real-PostgreSQL contract test for the trade visibility rules (#715 PR-C).
//
// The unit tests (tests/unit/trade-*.test.ts) mock Drizzle and can only assert
// the *shape* of the generated WHERE clause. Whether the correlated EXISTS
// fragments actually resolve to the right rows (aliases, NULL card ids,
// per-card streamer settings, window counts, LIMIT/hasMore over the visible
// set) can only be proven by running the queries. This suite drives the real
// service functions in src/lib/trade.ts — including the accept_trade_offer RPC
// — against a database that has the PlanetScale baseline + migrations applied.
//
// The tests in this file are ORDER-DEPENDENT by design (one seeded world,
// mutated by the accept tests and then read by the /mine and helper tests);
// run the file as a whole, not single tests via -t.
//
// Dedicated disposable PostgreSQL only (same policy as
// pack-completion-rewards-pg.test.ts). Never point TRADE_TEST_DATABASE_URL at a
// shared database. Without the variable the whole suite is skipped.
//
// Local run (example):
//   apply db/planetscale baseline + grants + migrations (see ci.yml
//   "Apply PlanetScale baseline and additive migrations"), then
//   TRADE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//     npx vitest run tests/integration/trade-visibility-pg.test.ts
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

// Deterministic ids (prefix 7e1a… is reserved for this suite and cleaned up).
const id = (n: number) => `7e1a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const S = {
  PUB: id(1), // show_unowned_cards + details → names public
  PRIV: id(2), // names private
  HALF: id(3), // show_unowned_cards=true but details=false → names still private
  OFF: id(4), // trade disabled
  NOCROSS: id(5), // trade on, cross off
  INACTIVE_PARTNER: id(6), // seeded only by the inactive-only partner regression
  MIXED_PARTNER: id(7), // seeded only by the mixed-ownership partner regression
};
const U = { O: id(11), V: id(12) };
const TW = { O: "trade-vis-offerer", V: "trade-vis-viewer" };
const C = {
  PUB_A: id(21),
  PUB_B: id(22),
  PUB_INACTIVE: id(23),
  PRIV_A: id(31),
  PRIV_B: id(32),
  PRIV_C: id(33),
  HALF_A: id(41),
  HALF_B: id(42),
  OFF_A: id(51),
  NOCROSS_A: id(61),
};
// user_cards
const UC = {
  O_PUB_A1: id(101),
  O_PUB_A2: id(102),
  O_PUB_A3: id(103),
  O_PUB_INACTIVE: id(104),
  O_PRIV_A1: id(105),
  O_PRIV_A2: id(106),
  O_PRIV_B1: id(107),
  O_PRIV_B2: id(108),
  O_HALF_A: id(109),
  V_PRIV_B: id(201),
  V_PRIV_C: id(202),
  V_PUB_B: id(203),
  V_OFF_A: id(204),
  V_NOCROSS_A: id(205),
};
// offers
const OF = {
  PUB: id(301), // PUB_A → PUB_B (both public)
  PUB_WANT_INACTIVE: id(302), // PUB_A → PUB_INACTIVE
  PUB_GIVE_INACTIVE: id(303), // PUB_INACTIVE → PUB_B
  PRIV_AB: id(304), // PRIV_A → PRIV_B
  PRIV_BA: id(305), // PRIV_B → PRIV_A
  PRIV_BC: id(306), // PRIV_B → PRIV_C
  HALF: id(307), // HALF_A → HALF_B
  CROSS_PUB_PRIV: id(308), // PUB_A → PRIV_B
  CROSS_PRIV_PUB: id(309), // PRIV_A → PUB_B
};
const HIDDEN_BULK_COUNT = 20;
const bulkUserCard = (i: number) => id(1000 + i);
const bulkOffer = (i: number) => id(2000 + i);

async function cleanup() {
  if (!sql) return;
  const users = Object.values(U);
  const streamers = Object.values(S);
  await sql`DELETE FROM trade_offers WHERE offerer_user_id IN ${sql(users)} OR accepted_by_user_id IN ${sql(users)}`;
  await sql`DELETE FROM user_cards WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM cards WHERE streamer_id IN ${sql(streamers)}`;
  await sql`DELETE FROM users WHERE id IN ${sql(users)}`;
  await sql`DELETE FROM streamers WHERE id IN ${sql(streamers)}`;
}

async function seed() {
  const s = sql!;
  const streamer = (
    sid: string,
    name: string,
    flags: { trade: boolean; cross: boolean; unowned: boolean; details: boolean },
  ) => s`
    INSERT INTO streamers (
      id, twitch_user_id, twitch_username, twitch_display_name,
      trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
    ) VALUES (
      ${sid}, ${`tv-${name}`}, ${`tv-${name}`}, ${`TV ${name}`},
      ${flags.trade}, ${flags.cross}, ${flags.unowned}, ${flags.details}
    )`;
  await streamer(S.PUB, "pub", { trade: true, cross: true, unowned: true, details: true });
  await streamer(S.PRIV, "priv", { trade: true, cross: true, unowned: false, details: false });
  await streamer(S.HALF, "half", { trade: true, cross: true, unowned: true, details: false });
  await streamer(S.OFF, "off", { trade: false, cross: true, unowned: true, details: true });
  await streamer(S.NOCROSS, "nocross", { trade: true, cross: false, unowned: true, details: true });

  await s`INSERT INTO users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
    (${U.O}, ${TW.O}, ${TW.O}, 'Offerer O'),
    (${U.V}, ${TW.V}, ${TW.V}, 'Viewer V')`;

  const card = (cid: string, sid: string, name: string, rarity: string, active: boolean) =>
    s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
      VALUES (${cid}, ${sid}, ${name}, ${rarity}, 0.1, ${active})`;
  await card(C.PUB_A, S.PUB, "Pub A", "common", true);
  await card(C.PUB_B, S.PUB, "Pub B", "rare", true);
  await card(C.PUB_INACTIVE, S.PUB, "Pub Retired", "epic", false);
  await card(C.PRIV_A, S.PRIV, "Secret A", "legendary", true);
  await card(C.PRIV_B, S.PRIV, "Priv B", "common", true);
  await card(C.PRIV_C, S.PRIV, "Priv C", "rare", true);
  await card(C.HALF_A, S.HALF, "Half A", "common", true);
  await card(C.HALF_B, S.HALF, "Secret Half B", "rare", true);
  await card(C.OFF_A, S.OFF, "Off A", "common", true);
  await card(C.NOCROSS_A, S.NOCROSS, "NoCross A", "common", true);

  const own = (ucid: string, uid: string, cid: string, minutesAgo: number) =>
    s`INSERT INTO user_cards (id, user_id, card_id, obtained_at)
      VALUES (${ucid}, ${uid}, ${cid}, now() - make_interval(secs => ${minutesAgo * 60}))`;
  await own(UC.O_PUB_A1, U.O, C.PUB_A, 100);
  await own(UC.O_PUB_A2, U.O, C.PUB_A, 99);
  await own(UC.O_PUB_A3, U.O, C.PUB_A, 98);
  await own(UC.O_PUB_INACTIVE, U.O, C.PUB_INACTIVE, 97);
  await own(UC.O_PRIV_A1, U.O, C.PRIV_A, 96);
  await own(UC.O_PRIV_A2, U.O, C.PRIV_A, 95);
  await own(UC.O_PRIV_B1, U.O, C.PRIV_B, 94);
  await own(UC.O_PRIV_B2, U.O, C.PRIV_B, 93);
  await own(UC.O_HALF_A, U.O, C.HALF_A, 92);
  await own(UC.V_PRIV_B, U.V, C.PRIV_B, 90);
  await own(UC.V_PRIV_C, U.V, C.PRIV_C, 89);
  await own(UC.V_PUB_B, U.V, C.PUB_B, 88);
  await own(UC.V_OFF_A, U.V, C.OFF_A, 87);
  await own(UC.V_NOCROSS_A, U.V, C.NOCROSS_A, 86);

  const offer = async (
    oid: string,
    ucid: string,
    offered: string,
    offeredStreamer: string,
    wanted: string,
    wantedStreamer: string,
    minutesAgo: number,
  ) => s`
    INSERT INTO trade_offers (
      id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
      wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot, created_at
    ) VALUES (
      ${oid}, ${U.O}, ${ucid}, ${offered}, ${offeredStreamer}, ${wanted}, ${wantedStreamer},
      ${JSON.stringify({ name: "snap", rarity: "common", imageUrl: null })}::jsonb,
      ${JSON.stringify({ name: "snap", rarity: "common", imageUrl: null })}::jsonb,
      now() - make_interval(secs => ${minutesAgo * 60})
    )`;
  await offer(OF.PUB, UC.O_PUB_A1, C.PUB_A, S.PUB, C.PUB_B, S.PUB, 50);
  await offer(OF.PUB_WANT_INACTIVE, UC.O_PUB_A2, C.PUB_A, S.PUB, C.PUB_INACTIVE, S.PUB, 49);
  await offer(OF.PUB_GIVE_INACTIVE, UC.O_PUB_INACTIVE, C.PUB_INACTIVE, S.PUB, C.PUB_B, S.PUB, 48);
  await offer(OF.PRIV_AB, UC.O_PRIV_A1, C.PRIV_A, S.PRIV, C.PRIV_B, S.PRIV, 47);
  await offer(OF.PRIV_BA, UC.O_PRIV_B1, C.PRIV_B, S.PRIV, C.PRIV_A, S.PRIV, 46);
  await offer(OF.PRIV_BC, UC.O_PRIV_B2, C.PRIV_B, S.PRIV, C.PRIV_C, S.PRIV, 45);
  await offer(OF.HALF, UC.O_HALF_A, C.HALF_A, S.HALF, C.HALF_B, S.HALF, 44);
  await offer(OF.CROSS_PUB_PRIV, UC.O_PUB_A3, C.PUB_A, S.PUB, C.PRIV_B, S.PRIV, 43);
  await offer(OF.CROSS_PRIV_PUB, UC.O_PRIV_A2, C.PRIV_A, S.PRIV, C.PUB_B, S.PUB, 42);

  // HIDDEN_BULK_COUNT newer offers in PRIV that V can never see (offered
  // PRIV_A is not owned by V). They sit *before* PRIV_BC in created_at DESC
  // order, so a post-pagination filter would return an empty first page with
  // hasMore=true for V; the SQL WHERE must return PRIV_BC with hasMore=false.
  for (let i = 0; i < HIDDEN_BULK_COUNT; i += 1) {
    await own(bulkUserCard(i), U.O, C.PRIV_A, 80 - i);
    await offer(bulkOffer(i), bulkUserCard(i), C.PRIV_A, S.PRIV, C.PRIV_B, S.PRIV, 10 - i * 0.1);
  }
}

describe.skipIf(!sql)("trade visibility on actual PostgreSQL", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    await sql?.end();
  });

  const listIds = async (input: Parameters<typeof import("@/lib/trade").listTradeOffers>[0]) => {
    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers(input);
    return { ids: result.offers.map((offer) => offer.id), result };
  };

  describe("listTradeOffers", () => {
    it("anonymous viewers only see offers whose both cards are revealed and active", async () => {
      const pub = await listIds({ streamerId: S.PUB, scope: "in_channel", page: 1 });
      expect(pub.ids).toEqual([OF.PUB]);
      // Internal copy id is not exposed on the public board.
      expect(pub.result.offers[0]).not.toHaveProperty("offeredUserCardId");
      // Display metadata comes from the LEFT JOINs of the same statement:
      // open offers have no acceptor, anonymous rows carry no viewer fields.
      expect(pub.result.offers[0]).toMatchObject({
        offerer: { twitchUsername: TW.O, twitchDisplayName: "Offerer O", twitchProfileImageUrl: null },
        acceptedBy: null,
        offeredStreamer: { id: S.PUB, twitchUsername: "tv-pub", twitchDisplayName: "TV pub", twitchProfileImageUrl: null },
        wantedStreamer: { id: S.PUB, twitchUsername: "tv-pub", twitchDisplayName: "TV pub", twitchProfileImageUrl: null },
      });
      expect(pub.result.offers[0]).not.toHaveProperty("isOwnOffer");
      expect(pub.result.offers[0]).not.toHaveProperty("canAccept");

      // An unknown twitch user id resolves to NULL in SQL and is treated
      // exactly like an anonymous viewer (no viewer-specific fields).
      const unknown = await listIds({
        streamerId: S.PUB,
        scope: "in_channel",
        page: 1,
        twitchUserId: "trade-vis-unknown",
      });
      expect(unknown.result).toEqual(pub.result);

      const priv = await listIds({ streamerId: S.PRIV, scope: "in_channel", page: 1 });
      expect(priv.ids).toEqual([]);
      expect(priv.result.hasMore).toBe(false);

      // show_unowned_cards=true but show_unowned_card_details=false still hides names.
      const half = await listIds({ streamerId: S.HALF, scope: "in_channel", page: 1 });
      expect(half.ids).toEqual([]);
    });

    it("a logged-in viewer sees private cards they own, and nothing else; hasMore ignores hidden rows", async () => {
      const priv = await listIds({
        streamerId: S.PRIV,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      // PRIV_AB: offered hidden. PRIV_BA: wanted hidden. Bulk: offered hidden.
      expect(priv.ids).toEqual([OF.PRIV_BC]);
      expect(priv.result.hasMore).toBe(false);
      expect(priv.result.offers[0].canAccept).toBe("yes");

      const page2 = await listIds({
        streamerId: S.PRIV,
        scope: "in_channel",
        page: 2,
        twitchUserId: TW.V,
      });
      expect(page2.ids).toEqual([]);
      expect(page2.result.hasMore).toBe(false);
    });

    it("canAccept reports all_listed when the viewer's only copy is in their own open offer", async () => {
      // Regression: the listed-copy EXISTS used to compare two columns of the
      // same inner trade_offers row (bare "id"), so all_listed was unreachable.
      const ownListing = id(7001);
      await sql!`
        INSERT INTO trade_offers (
          id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
          wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
        ) VALUES (
          ${ownListing}, ${U.V}, ${UC.V_PRIV_C}, ${C.PRIV_C}, ${S.PRIV}, ${C.PRIV_B}, ${S.PRIV},
          '{}'::jsonb, '{}'::jsonb
        )`;
      try {
        const { result } = await listIds({
          streamerId: S.PRIV,
          scope: "in_channel",
          page: 1,
          twitchUserId: TW.V,
          wantedCardId: C.PRIV_C,
        });
        expect(result.offers.map((offer) => [offer.id, offer.canAccept])).toEqual([
          [OF.PRIV_BC, "all_listed"],
        ]);
      } finally {
        await sql!`DELETE FROM trade_offers WHERE id = ${ownListing}`;
      }
    });

    it("wantedCardId / offeredCardId filters cannot probe hidden cards", async () => {
      const base = { streamerId: S.PRIV, scope: "in_channel" as const, page: 1, twitchUserId: TW.V };
      expect((await listIds({ ...base, wantedCardId: C.PRIV_A })).ids).toEqual([]);
      expect((await listIds({ ...base, offeredCardId: C.PRIV_A })).ids).toEqual([]);
      expect((await listIds({ ...base, wantedCardId: C.PRIV_C })).ids).toEqual([OF.PRIV_BC]);
      expect((await listIds({ ...base, offeredCardId: C.PRIV_B })).ids).toEqual([OF.PRIV_BC]);
    });

    it("the offerer always sees their own offers except inactive-card ones", async () => {
      const priv = await listIds({
        streamerId: S.PRIV,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.O,
      });
      // 20 bulk + PRIV_AB/BA/BC = 23 → first page 20, hasMore.
      expect(priv.result.offers).toHaveLength(20);
      expect(priv.result.hasMore).toBe(true);
      expect(priv.result.offers.every((offer) => offer.isOwnOffer === true)).toBe(true);
      expect(priv.result.offers.every((offer) => typeof offer.offeredUserCardId === "string")).toBe(true);
      const page2 = await listIds({
        streamerId: S.PRIV,
        scope: "in_channel",
        page: 2,
        twitchUserId: TW.O,
      });
      expect(page2.ids).toEqual([OF.PRIV_BC, OF.PRIV_BA, OF.PRIV_AB]);
      expect(page2.result.hasMore).toBe(false);

      // Own offers with an inactive card stay hidden (same as trade_enabled=false).
      const pub = await listIds({ streamerId: S.PUB, scope: "in_channel", page: 1, twitchUserId: TW.O });
      expect(pub.ids).toEqual([OF.PUB]);
    });

    it("cross-channel offers apply each card's own streamer settings", async () => {
      const anonPub = await listIds({ streamerId: S.PUB, scope: "cross_channel", page: 1 });
      // PUB_PRIV: wanted PRIV_B private. PRIV_PUB: offered PRIV_A private.
      expect(anonPub.ids).toEqual([]);

      const viewerPub = await listIds({
        streamerId: S.PUB,
        scope: "cross_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      // V owns PRIV_B → PUB_PRIV visible; V does not own PRIV_A → PRIV_PUB hidden.
      expect(viewerPub.ids).toEqual([OF.CROSS_PUB_PRIV]);

      const viewerPriv = await listIds({
        streamerId: S.PRIV,
        scope: "cross_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      expect(viewerPriv.ids).toEqual([OF.CROSS_PUB_PRIV]);
    });
  });

  describe("createTradeOffer", () => {
    const req = (n: number) => id(5000 + n);

    it("rejects an unowned wanted card of a private channel without revealing it", async () => {
      const { createTradeOffer } = await import("@/lib/trade");
      await expect(createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PRIV_B,
        wantedCardId: C.PRIV_A,
        requestId: req(1),
      })).resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_UNAVAILABLE" });
      // details=false hides names even when show_unowned_cards=true
      await expect(createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PRIV_B,
        wantedCardId: C.HALF_B,
        requestId: req(2),
      })).resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_UNAVAILABLE" });
      // inactive wanted card
      await expect(createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PUB_B,
        wantedCardId: C.PUB_INACTIVE,
        requestId: req(3),
      })).resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_UNAVAILABLE" });
    });

    it("keeps the create-time error precedence for unknown users, foreign copies, listed copies and the open-offer limit", async () => {
      const { createTradeOffer } = await import("@/lib/trade");
      await expect(createTradeOffer({
        twitchUserId: "trade-vis-unknown",
        offeredUserCardId: UC.V_PUB_B,
        wantedCardId: C.PUB_A,
        requestId: req(10),
      })).resolves.toEqual({ kind: "error", code: "TRADE_CARD_NOT_OWNED" });
      // V's copy offered by O.
      await expect(createTradeOffer({
        twitchUserId: TW.O,
        offeredUserCardId: UC.V_PUB_B,
        wantedCardId: C.PUB_A,
        requestId: req(11),
      })).resolves.toEqual({ kind: "error", code: "TRADE_CARD_NOT_OWNED" });
      // Same card on both sides is rejected before the wanted-card checks.
      await expect(createTradeOffer({
        twitchUserId: TW.O,
        offeredUserCardId: UC.O_PUB_A2,
        wantedCardId: C.PUB_A,
        requestId: req(12),
      })).resolves.toEqual({ kind: "error", code: "TRADE_SAME_CARD" });
      // O_PUB_A2 is already the offered copy of PUB_WANT_INACTIVE.
      await expect(createTradeOffer({
        twitchUserId: TW.O,
        offeredUserCardId: UC.O_PUB_A2,
        wantedCardId: C.PUB_B,
        requestId: req(13),
      })).resolves.toEqual({ kind: "error", code: "TRADE_CARD_ALREADY_LISTED" });

      // O already has 29 open offers (≥ TRADE_MAX_OPEN_OFFERS): an unlisted
      // copy passes every other check and stops at the limit.
      const spare = id(7101);
      await sql!`INSERT INTO user_cards (id, user_id, card_id) VALUES (${spare}, ${U.O}, ${C.PUB_B})`;
      try {
        await expect(createTradeOffer({
          twitchUserId: TW.O,
          offeredUserCardId: spare,
          wantedCardId: C.PUB_A,
          requestId: req(14),
        })).resolves.toEqual({ kind: "error", code: "TRADE_OFFER_LIMIT" });
      } finally {
        await sql!`DELETE FROM user_cards WHERE id = ${spare}`;
      }
    });

    it("cancel resolves the owner in SQL: owner CAS, then NOT_OPEN / NOT_FOUND", async () => {
      const { cancelTradeOffer, createTradeOffer } = await import("@/lib/trade");
      const created = await createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PRIV_B,
        wantedCardId: C.PRIV_C,
        requestId: req(20),
      });
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") return;
      try {
        await expect(cancelTradeOffer({ twitchUserId: TW.O, tradeOfferId: created.offer.id }))
          .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_NOT_FOUND" });
        await expect(cancelTradeOffer({ twitchUserId: "trade-vis-unknown", tradeOfferId: created.offer.id }))
          .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_NOT_FOUND" });
        await expect(cancelTradeOffer({ twitchUserId: TW.V, tradeOfferId: created.offer.id }))
          .resolves.toEqual({ kind: "ok", id: created.offer.id });
        await expect(cancelTradeOffer({ twitchUserId: TW.V, tradeOfferId: created.offer.id }))
          .resolves.toEqual({ kind: "error", code: "TRADE_OFFER_NOT_OPEN" });
      } finally {
        await sql!`DELETE FROM trade_offers WHERE id = ${created.offer.id}`;
      }
    });

    it("rejects an inactive offered card", async () => {
      const { createTradeOffer } = await import("@/lib/trade");
      await expect(createTradeOffer({
        twitchUserId: TW.O,
        offeredUserCardId: UC.O_PUB_INACTIVE,
        wantedCardId: C.PUB_B,
        requestId: req(4),
      })).resolves.toEqual({ kind: "error", code: "TRADE_OFFERED_CARD_INACTIVE" });
    });

    it("allows wanting an owned card of a private channel and a public unowned card; replays after settings change", async () => {
      const { createTradeOffer } = await import("@/lib/trade");
      const owned = await createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PRIV_B,
        wantedCardId: C.PRIV_C,
        requestId: req(5),
      });
      expect(owned.kind).toBe("ok");

      const pub = await createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_NOCROSS_A,
        wantedCardId: C.PUB_B,
        requestId: req(6),
      });
      // NOCROSS has cross disabled → gate error, not visibility error.
      expect(pub).toEqual({ kind: "error", code: "TRADE_DISABLED" });

      // Replay with the same requestId after the wanted card stops being
      // visible (V's own copy is not the point: make the channel hide it by
      // deactivating) still returns the original offer.
      await sql!`UPDATE cards SET is_active = false WHERE id = ${C.PRIV_C}`;
      try {
        const replay = await createTradeOffer({
          twitchUserId: TW.V,
          offeredUserCardId: UC.V_PRIV_B,
          wantedCardId: C.PRIV_C,
          requestId: req(5),
        });
        expect(replay.kind).toBe("ok");
        if (replay.kind === "ok" && owned.kind === "ok") {
          expect(replay.idempotentReplay).toBe(true);
          // The replayed row (read through the LEFT JOINed alias) is the
          // same full row the INSERT returned, timestamps included.
          expect(replay.offer).toEqual(owned.offer);
        }
      } finally {
        await sql!`UPDATE cards SET is_active = true WHERE id = ${C.PRIV_C}`;
        if (owned.kind === "ok") {
          await sql!`DELETE FROM trade_offers WHERE id = ${owned.offer.id}`;
        }
      }
    });
  });

  describe("acceptTradeOffer", () => {
    const req = (n: number) => id(6000 + n);

    it("rejects an offer whose offered card is hidden from the acceptor", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      await expect(acceptTradeOffer({
        twitchUserId: TW.V,
        tradeOfferId: OF.PRIV_AB,
        requestId: req(1),
      })).resolves.toEqual({ success: false, error: "TRADE_OFFER_UNAVAILABLE" });
      const [row] = await sql!`SELECT status FROM trade_offers WHERE id = ${OF.PRIV_AB}`;
      expect(row.status).toBe("open");
    });

    it("rejects offers with an inactive card on either side without cancelling them", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      await expect(acceptTradeOffer({
        twitchUserId: TW.V,
        tradeOfferId: OF.PUB_GIVE_INACTIVE,
        requestId: req(2),
      })).resolves.toEqual({ success: false, error: "TRADE_OFFER_UNAVAILABLE" });
      const [row] = await sql!`SELECT status FROM trade_offers WHERE id = ${OF.PUB_GIVE_INACTIVE}`;
      expect(row.status).toBe("open");
    });

    it("completes a visible offer and replays it even after the received card becomes inactive", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      const first = await acceptTradeOffer({
        twitchUserId: TW.V,
        tradeOfferId: OF.PUB,
        requestId: req(3),
      });
      expect(first).toMatchObject({ success: true, idempotentReplay: false, tradeOfferId: OF.PUB });

      await sql!`UPDATE cards SET is_active = false WHERE id = ${C.PUB_A}`;
      try {
        const replay = await acceptTradeOffer({
          twitchUserId: TW.V,
          tradeOfferId: OF.PUB,
          requestId: req(3),
        });
        expect(replay).toMatchObject({ success: true, idempotentReplay: true, tradeOfferId: OF.PUB });

        // A different requestId is not a replay → the RPC's OFFER_NOT_OPEN,
        // not the precheck's TRADE_OFFER_UNAVAILABLE.
        await expect(acceptTradeOffer({
          twitchUserId: TW.V,
          tradeOfferId: OF.PUB,
          requestId: req(4),
        })).resolves.toEqual({ success: false, error: "OFFER_NOT_OPEN" });
      } finally {
        await sql!`UPDATE cards SET is_active = true WHERE id = ${C.PUB_A}`;
      }
    });

    it("leaves self-accept and not-found classification to the RPC", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      await expect(acceptTradeOffer({
        twitchUserId: TW.O,
        tradeOfferId: OF.PUB_GIVE_INACTIVE,
        requestId: req(5),
      })).resolves.toEqual({ success: false, error: "SELF_ACCEPT_FORBIDDEN" });
      await expect(acceptTradeOffer({
        twitchUserId: TW.V,
        tradeOfferId: id(9999),
        requestId: req(6),
      })).resolves.toEqual({ success: false, error: "TRADE_OFFER_NOT_FOUND" });
    });
  });

  describe("listMyTradeOffers", () => {
    it("filters by status, pages at 20 and exposes acceptedBy", async () => {
      const { listMyTradeOffers } = await import("@/lib/trade");
      const completed = await listMyTradeOffers(TW.O, { status: "completed" });
      expect(completed.offers.map((offer) => offer.id)).toEqual([OF.PUB]);
      expect(completed.offers[0].acceptedBy).toMatchObject({
        twitchUsername: TW.V,
        twitchDisplayName: "Viewer V",
      });
      expect(completed.offers[0].mineRole).toBe("offerer");
      expect(completed.offers[0]).not.toHaveProperty("canAccept");
      expect(completed.offers[0]).toMatchObject({
        isOwnOffer: true,
        offeredUserCardId: UC.O_PUB_A1,
        offerer: { twitchUsername: TW.O, twitchDisplayName: "Offerer O" },
        offeredStreamer: { id: S.PUB, twitchUsername: "tv-pub" },
      });

      const viewerCompleted = await listMyTradeOffers(TW.V, { status: "completed" });
      expect(viewerCompleted.offers.map((offer) => offer.id)).toEqual([OF.PUB]);
      expect(viewerCompleted.offers[0].mineRole).toBe("acceptor");

      // O: 20 bulk + 8 still-open seeded offers (9 seeded − OF.PUB completed) = 28.
      const open1 = await listMyTradeOffers(TW.O, { status: "open", page: 1 });
      expect(open1.offers).toHaveLength(20);
      expect(open1.hasMore).toBe(true);
      const open2 = await listMyTradeOffers(TW.O, { status: "open", page: 2 });
      expect(open2.offers).toHaveLength(8);
      expect(open2.hasMore).toBe(false);
      // Own history is not filtered by is_active.
      expect(open2.offers.map((offer) => offer.id)).toContain(OF.PUB_GIVE_INACTIVE);
      expect(open2.offers.every((offer) => offer.status === "open")).toBe(true);

      const cancelled = await listMyTradeOffers(TW.O, { status: "cancelled" });
      expect(cancelled.offers).toEqual([]);

      await expect(listMyTradeOffers("trade-vis-unknown", { status: "open" })).resolves.toEqual({
        offers: [],
        page: 1,
        pageSize: 20,
        hasMore: false,
      });
    });

    it("reports tradeability per offer without filtering the owner's history (#1754 item 4)", async () => {
      const { listMyTradeOffers } = await import("@/lib/trade");
      const openPages = async () => {
        const first = await listMyTradeOffers(TW.O, { status: "open", page: 1 });
        const second = await listMyTradeOffers(TW.O, { status: "open", page: 2 });
        return { first, second, all: [...first.offers, ...second.offers] };
      };
      const tradeableOf = (offers: Awaited<ReturnType<typeof openPages>>["all"], offerId: string) =>
        offers.find((offer) => offer.id === offerId)?.tradeable;

      const before = await openPages();
      // Page 1 is the 20 bulk offers (PRIV_A → PRIV_B): active cards, both
      // channels trading on.
      expect(before.first.offers.every((offer) => offer.tradeable === true)).toBe(true);
      // Page 2 mixes acceptable offers with ones nobody can accept any more.
      expect(tradeableOf(before.all, OF.PRIV_BC)).toBe(true);
      expect(tradeableOf(before.all, OF.CROSS_PUB_PRIV)).toBe(true);
      expect(tradeableOf(before.all, OF.CROSS_PRIV_PUB)).toBe(true);
      expect(tradeableOf(before.all, OF.PUB_WANT_INACTIVE)).toBe(false);
      expect(tradeableOf(before.all, OF.PUB_GIVE_INACTIVE)).toBe(false);

      // Turning PUBLIC's trade switch off makes its offers unacceptable (both
      // the in-channel and the cross-channel ones), while the rows stay in the
      // offerer's own history so they can still be cancelled.
      await sql!`UPDATE streamers SET trade_enabled = FALSE WHERE id = ${S.PUB}`;
      try {
        const after = await openPages();
        expect(after.all.map((offer) => offer.id)).toEqual(before.all.map((offer) => offer.id));
        expect(after.first.offers.every((offer) => offer.tradeable === true)).toBe(true);
        expect(tradeableOf(after.all, OF.PRIV_BC)).toBe(true);
        expect(tradeableOf(after.all, OF.CROSS_PUB_PRIV)).toBe(false);
        expect(tradeableOf(after.all, OF.CROSS_PRIV_PUB)).toBe(false);
      } finally {
        // Restore the seeded world for the suites that follow.
        await sql!`UPDATE streamers SET trade_enabled = TRUE WHERE id = ${S.PUB}`;
      }
    });
  });

  describe("viewer UI server helpers", () => {
    it("getTradeBoardStreamer reports gates and whether unowned names are public", async () => {
      const { getTradeBoardStreamer } = await import("@/lib/trade");
      await expect(getTradeBoardStreamer(S.PUB)).resolves.toMatchObject({
        id: S.PUB,
        tradeEnabled: true,
        crossChannelTradeEnabled: true,
        revealsUnownedCards: true,
      });
      await expect(getTradeBoardStreamer(S.HALF)).resolves.toMatchObject({ revealsUnownedCards: false });
      await expect(getTradeBoardStreamer(S.OFF)).resolves.toMatchObject({ tradeEnabled: false });
      await expect(getTradeBoardStreamer(id(9998))).resolves.toBeNull();
      await expect(getTradeBoardStreamer("not-a-uuid")).resolves.toBeNull();
    });

    it("listTradeableOwnedCopies returns active copies with listed flag and per-card count", async () => {
      const { listTradeableOwnedCopies } = await import("@/lib/trade");
      // After the accept above, O owns PUB_B (received) and lost PUB_A1.
      const copies = await listTradeableOwnedCopies(TW.O, S.PUB);
      const byId = new Map(copies.map((copy) => [copy.userCardId, copy]));
      expect(byId.has(UC.O_PUB_INACTIVE)).toBe(false);
      expect(byId.get(UC.O_PUB_A2)).toMatchObject({ cardId: C.PUB_A, isListed: true, ownedCount: 2 });
      expect(byId.get(UC.O_PUB_A3)).toMatchObject({ cardId: C.PUB_A, isListed: true, ownedCount: 2 });
      expect(byId.get(UC.V_PUB_B)).toMatchObject({ cardId: C.PUB_B, isListed: false, ownedCount: 1, name: "Pub B" });
      expect(copies).toHaveLength(3);

      await expect(listTradeableOwnedCopies("unknown-user", S.PUB)).resolves.toEqual([]);
    });

    it("listWantableCards never returns names of unrevealed unowned cards", async () => {
      const { listWantableCards } = await import("@/lib/trade");
      // V now owns PUB_A (received) and PRIV_B, PRIV_C.
      const priv = await listWantableCards(TW.V, S.PRIV);
      expect(priv.map((card) => card.cardId).sort()).toEqual([C.PRIV_B, C.PRIV_C].sort());
      expect(priv.every((card) => card.isOwned)).toBe(true);
      expect(JSON.stringify(priv)).not.toContain("Secret A");

      await expect(listWantableCards(null, S.PRIV)).resolves.toEqual([]);
      const half = await listWantableCards(null, S.HALF);
      expect(half).toEqual([]);

      const pubAnon = await listWantableCards(null, S.PUB);
      expect(pubAnon.map((card) => card.cardId).sort()).toEqual([C.PUB_A, C.PUB_B].sort());
      expect(pubAnon.every((card) => card.isOwned === false)).toBe(true);
      expect(JSON.stringify(pubAnon)).not.toContain("Pub Retired");

      const pubViewer = await listWantableCards(TW.V, S.PUB);
      expect(pubViewer.find((card) => card.cardId === C.PUB_A)?.isOwned).toBe(true);
      expect(pubViewer.find((card) => card.cardId === C.PUB_B)?.isOwned).toBe(false);
    });

    it("listCrossTradePartnerStreamers = owned channels ∩ trade+cross, excluding base", async () => {
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      // V owns cards of PUB, PRIV, OFF (trade off), NOCROSS (cross off).
      const fromPub = await listCrossTradePartnerStreamers(TW.V, S.PUB);
      expect(fromPub.map((streamer) => streamer.id)).toEqual([S.PRIV]);
      const fromPriv = await listCrossTradePartnerStreamers(TW.V, S.PRIV);
      expect(fromPriv.map((streamer) => streamer.id)).toEqual([S.PUB]);
      // Base channel without cross permission → empty.
      await expect(listCrossTradePartnerStreamers(TW.V, S.NOCROSS)).resolves.toEqual([]);
      await expect(listCrossTradePartnerStreamers(TW.V, S.OFF)).resolves.toEqual([]);
      // O owns nothing outside PUB/PRIV/HALF; HALF qualifies for O from PUB.
      const offererFromPub = await listCrossTradePartnerStreamers(TW.O, S.PUB);
      expect(offererFromPub.map((streamer) => streamer.id).sort()).toEqual([S.PRIV, S.HALF].sort());
      await expect(listCrossTradePartnerStreamers("unknown-user", S.PUB)).resolves.toEqual([]);
    });

    it.each([
      { name: "inactive-only", streamerId: S.INACTIVE_PARTNER, cardStart: 71, copyStart: 601, active: [false, false], included: false },
      { name: "mixed active/inactive", streamerId: S.MIXED_PARTNER, cardStart: 81, copyStart: 611, active: [false, true], included: true },
    ])("listCrossTradePartnerStreamers filters $name ownership", async ({ name, streamerId, cardStart, copyStart, active, included }) => {
      const { listCrossTradePartnerStreamers } = await import("@/lib/trade");
      const s = sql!;
      const cardIds = active.map((_, i) => id(cardStart + i));

      // Keep the suite's order-dependent shared cards untouched. Dedicated
      // channels have both trade gates on and private names, so eligibility
      // depends on the viewer's active ownership, not public card visibility.
      try {
        await s`INSERT INTO streamers (
          id, twitch_user_id, twitch_username, twitch_display_name,
          trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
        ) VALUES (${streamerId}, ${`tv-partner-${cardStart}`}, ${`tv-partner-${cardStart}`}, ${name}, TRUE, TRUE, FALSE, FALSE)`;
        for (const [i, isActive] of active.entries()) {
          await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
            VALUES (${cardIds[i]}, ${streamerId}, ${`Partner card ${i}`}, 'common', 0.1, ${isActive})`;
          await s`INSERT INTO user_cards (id, user_id, card_id)
            VALUES (${id(copyStart + i)}, ${U.V}, ${cardIds[i]})`;
        }

        const partners = await listCrossTradePartnerStreamers(TW.V, S.PUB);
        expect(partners.filter((partner) => partner.id === streamerId)).toHaveLength(included ? 1 : 0);
        // Existing eligible channels still appear and the base stays excluded.
        expect(partners.map((partner) => partner.id)).toContain(S.PRIV);
        expect(partners.map((partner) => partner.id)).not.toContain(S.PUB);
      } finally {
        await s`DELETE FROM user_cards WHERE card_id IN ${s(cardIds)}`;
        await s`DELETE FROM cards WHERE streamer_id = ${streamerId}`;
        await s`DELETE FROM streamers WHERE id = ${streamerId}`;
      }
    });
  });
});
