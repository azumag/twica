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
  QTY: id(8), // seeded only by the wanted-quantity block (#1789)
  WANT: id(9), // seeded only by the wantable-restriction block (#1790)
};
const U = { O: id(11), V: id(12), QO: id(13), QV: id(14), WO: id(15), WV: id(16) };
const TW = {
  O: "trade-vis-offerer",
  V: "trade-vis-viewer",
  QO: "trade-vis-qty-offerer",
  QV: "trade-vis-qty-viewer",
  WO: "trade-vis-want-offerer",
  WV: "trade-vis-want-viewer",
};
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

      // HALF reveals unowned cards but not their details, so a logged-in
      // viewer who owns none of its cards still sees no offer (same as the
      // anonymous case asserted above).
      const halfViewer = await listIds({
        streamerId: S.HALF,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      expect(halfViewer.ids).toEqual([]);
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

    it("hides offers of a trade-disabled channel and of cross-disabled partners", async () => {
      const s = sql!;
      // Dedicated fixtures (cleaned up below) so the order-dependent shared
      // world keeps its offer counts for the /mine and helper assertions.
      const cards = { offB: id(7301), nocrossB: id(7302) };
      const copies = {
        offA: id(7311),
        offB: id(7312),
        nocrossA: id(7313),
        nocrossB: id(7314),
        pubA: id(7315),
        pubB: id(7316),
      };
      const offers = {
        offInChannel: id(7321),
        crossPubOff: id(7322),
        crossPubNocross: id(7323),
        crossNocrossPub: id(7324),
      };
      const insertOffer = (
        oid: string,
        ucid: string,
        offered: string,
        offeredStreamer: string,
        wanted: string,
        wantedStreamer: string,
        secsAgo: number,
      ) => s`
        INSERT INTO trade_offers (
          id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
          wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot, created_at
        ) VALUES (
          ${oid}, ${U.O}, ${ucid}, ${offered}, ${offeredStreamer}, ${wanted}, ${wantedStreamer},
          '{}'::jsonb, '{}'::jsonb, now() - make_interval(secs => ${secsAgo})
        )`;

      try {
        // Both cards are active, so only the streamer gates can hide these
        // offers (is_active is not the reason).
        await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active) VALUES
          (${cards.offB}, ${S.OFF}, 'Off B', 'common', 0.1, TRUE),
          (${cards.nocrossB}, ${S.NOCROSS}, 'NoCross B', 'common', 0.1, TRUE)`;
        await s`INSERT INTO user_cards (id, user_id, card_id) VALUES
          (${copies.offA}, ${U.O}, ${C.OFF_A}),
          (${copies.offB}, ${U.O}, ${cards.offB}),
          (${copies.nocrossA}, ${U.O}, ${C.NOCROSS_A}),
          (${copies.nocrossB}, ${U.O}, ${cards.nocrossB}),
          (${copies.pubA}, ${U.O}, ${C.PUB_A}),
          (${copies.pubB}, ${U.O}, ${C.PUB_B})`;
        // In-channel offer inside the trade-disabled channel OFF.
        await insertOffer(offers.offInChannel, copies.offA, C.OFF_A, S.OFF, cards.offB, S.OFF, 5);
        // Cross offers where one side is disabled: OFF is trade-disabled,
        // NOCROSS has cross-channel trade off (covered on both sides).
        await insertOffer(offers.crossPubOff, copies.pubA, C.PUB_A, S.PUB, C.OFF_A, S.OFF, 4);
        await insertOffer(offers.crossPubNocross, copies.pubB, C.PUB_B, S.PUB, C.NOCROSS_A, S.NOCROSS, 3);
        await insertOffer(offers.crossNocrossPub, copies.nocrossA, C.NOCROSS_A, S.NOCROSS, C.PUB_B, S.PUB, 2);

        // OFF's own board hides its offer from anonymous viewers and from the
        // offerer (own offers bypass the reveal rule, not the trade gate).
        expect((await listIds({ streamerId: S.OFF, scope: "in_channel", page: 1 })).ids).toEqual([]);
        expect((await listIds({ streamerId: S.OFF, scope: "in_channel", page: 1, twitchUserId: TW.O })).ids)
          .toEqual([]);

        // PUB's cross board: V owns OFF_A, NOCROSS_A and PUB_B, so every card
        // is revealed to V and only the gates can be responsible.
        const viewerPub = await listIds({
          streamerId: S.PUB,
          scope: "cross_channel",
          page: 1,
          twitchUserId: TW.V,
        });
        expect(viewerPub.ids).toEqual([OF.CROSS_PUB_PRIV]);
      } finally {
        await s`DELETE FROM trade_offers WHERE id IN ${s(Object.values(offers))}`;
        await s`DELETE FROM user_cards WHERE id IN ${s(Object.values(copies))}`;
        await s`DELETE FROM cards WHERE id IN ${s(Object.values(cards))}`;
      }
    });

    it("drops offers whose card definition was deleted, for every viewer including the offerer", async () => {
      const s = sql!;
      const goneCard = id(7401);
      const goneCopy = id(7411);
      const goneOffer = id(7421);
      await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
        VALUES (${goneCard}, ${S.PUB}, 'Temp Gone', 'common', 0.1, TRUE)`;
      await s`INSERT INTO user_cards (id, user_id, card_id) VALUES (${goneCopy}, ${U.O}, ${goneCard})`;
      await s`INSERT INTO trade_offers (
        id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
        wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
      ) VALUES (
        ${goneOffer}, ${U.O}, ${goneCopy}, ${goneCard}, ${S.PUB}, ${C.PUB_B}, ${S.PUB},
        '{}'::jsonb, '{}'::jsonb
      )`;
      try {
        // Live and visible while the card definition exists (the offerer's
        // own offer on a traded-enabled, revealing channel).
        expect((await listIds({ streamerId: S.PUB, scope: "in_channel", page: 1, twitchUserId: TW.O })).ids)
          .toContain(goneOffer);

        // Deleting the definition nulls offered_card_id (ON DELETE SET NULL).
        await s`DELETE FROM cards WHERE id = ${goneCard}`;
        const [row] = await s`SELECT offered_card_id, status FROM trade_offers WHERE id = ${goneOffer}`;
        expect(row.offered_card_id).toBeNull();
        expect(row.status).toBe("open"); // history kept; only the board hides it

        const anon = await listIds({ streamerId: S.PUB, scope: "in_channel", page: 1 });
        expect(anon.ids).not.toContain(goneOffer);
        // Own offers bypass the reveal rule, not cardIsActive(), so the
        // offerer does not see the NULL-card offer either.
        const owner = await listIds({ streamerId: S.PUB, scope: "in_channel", page: 1, twitchUserId: TW.O });
        expect(owner.ids).not.toContain(goneOffer);
        expect(owner.ids).toEqual([OF.PUB]);
      } finally {
        await s`DELETE FROM trade_offers WHERE id = ${goneOffer}`;
        await s`DELETE FROM cards WHERE id = ${goneCard}`;
      }
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

      // Inactive on the wanted (募集) side is rejected by the same precheck and
      // likewise leaves the offer open.
      await expect(acceptTradeOffer({
        twitchUserId: TW.V,
        tradeOfferId: OF.PUB_WANT_INACTIVE,
        requestId: req(7),
      })).resolves.toEqual({ success: false, error: "TRADE_OFFER_UNAVAILABLE" });
      const [wantedRow] = await sql!`SELECT status FROM trade_offers WHERE id = ${OF.PUB_WANT_INACTIVE}`;
      expect(wantedRow.status).toBe("open");
    });

    it("returns CARD_NOT_OWNED without revealing a hidden wanted card", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      const s = sql!;
      // Offered side is public (so V may see the offer); the wanted side is
      // PRIV_A, a card of a details=false channel that V does not own. The
      // acceptor cannot pay, so the RPC answers CARD_NOT_OWNED. The wanted
      // card's name is never read into the Worker for this path (the visibility
      // precheck does not read names and the RPC returns a bare code).
      const pubCopy = id(7501);
      const hiddenWantedOffer = id(7511);
      await s`INSERT INTO user_cards (id, user_id, card_id) VALUES (${pubCopy}, ${U.O}, ${C.PUB_A})`;
      await s`INSERT INTO trade_offers (
        id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
        wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
      ) VALUES (
        ${hiddenWantedOffer}, ${U.O}, ${pubCopy}, ${C.PUB_A}, ${S.PUB},
        ${C.PRIV_A}, ${S.PRIV}, '{}'::jsonb, '{}'::jsonb
      )`;
      try {
        const result = await acceptTradeOffer({
          twitchUserId: TW.V,
          tradeOfferId: hiddenWantedOffer,
          requestId: req(8),
        });
        expect(result).toEqual({ success: false, error: "CARD_NOT_OWNED" });
        expect(JSON.stringify(result)).not.toContain("Secret");
        const [row] = await s`SELECT status FROM trade_offers WHERE id = ${hiddenWantedOffer}`;
        expect(row.status).toBe("open");
      } finally {
        await s`DELETE FROM trade_offers WHERE id = ${hiddenWantedOffer}`;
        await s`DELETE FROM user_cards WHERE id = ${pubCopy}`;
      }
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
      // A logged-in viewer who owns none of HALF's cards gets the same empty
      // set: show_unowned_cards without details never reveals names.
      await expect(listWantableCards(TW.V, S.HALF)).resolves.toEqual([]);

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

  // ---------------------------------------------------------------------------
  // #1789 wanted quantity. A self-contained world (ids 8xxx, its own channel
  // and users) seeded when this block starts, so the order-dependent shared
  // world above is neither read nor changed. The tests inside are still
  // order-dependent among themselves (listing → accept → shortage → window).
  // ---------------------------------------------------------------------------
  describe("wanted quantity (#1789)", () => {
    const QC = { A: id(8001), B: id(8002), C: id(8003) };
    // QO owns three copies of A to list; QV owns four copies of B (oldest
    // first) and one of C.
    const QUC = {
      O_A1: id(8101),
      O_A2: id(8102),
      O_A3: id(8103),
      V_B1: id(8201),
      V_B2: id(8202),
      V_B3: id(8203),
      V_B4: id(8204),
    };
    const req = (n: number) => id(8900 + n);
    const offerIds: Record<string, string> = {};

    const ownerOf = async (userCardIds: string[]) => {
      const rows = await sql!<Array<{ id: string; user_id: string }>>`
        SELECT id, user_id FROM user_cards WHERE id IN ${sql!(userCardIds)} ORDER BY id`;
      return Object.fromEntries(rows.map((row) => [row.id, row.user_id]));
    };

    beforeAll(async () => {
      const s = sql!;
      await s`INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
      ) VALUES (${S.QTY}, 'tv-qty', 'tv-qty', 'TV qty', TRUE, FALSE, TRUE, TRUE)`;
      await s`INSERT INTO users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
        (${U.QO}, ${TW.QO}, ${TW.QO}, 'Qty Offerer'),
        (${U.QV}, ${TW.QV}, ${TW.QV}, 'Qty Viewer')`;
      for (const [cid, name] of [[QC.A, "Qty A"], [QC.B, "Qty B"], [QC.C, "Qty C"]]) {
        await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
          VALUES (${cid}, ${S.QTY}, ${name}, 'common', 0.1, TRUE)`;
      }
      const own = (ucid: string, uid: string, cid: string, minutesAgo: number) =>
        s`INSERT INTO user_cards (id, user_id, card_id, obtained_at)
          VALUES (${ucid}, ${uid}, ${cid}, now() - make_interval(secs => ${minutesAgo * 60}))`;
      await own(QUC.O_A1, U.QO, QC.A, 60);
      await own(QUC.O_A2, U.QO, QC.A, 59);
      await own(QUC.O_A3, U.QO, QC.A, 58);
      await own(QUC.V_B1, U.QV, QC.B, 50);
      await own(QUC.V_B2, U.QV, QC.B, 40);
      await own(QUC.V_B3, U.QV, QC.B, 30);
      await own(QUC.V_B4, U.QV, QC.B, 20);
    });

    it("stores the quantity and compares canAccept with counts of owned / unlisted copies", async () => {
      const { createTradeOffer, listTradeOffers, cancelTradeOffer } = await import("@/lib/trade");
      const create = async (
        twitchUserId: string,
        offeredUserCardId: string,
        wantedCardId: string,
        wantedQuantity: number,
        requestId: string,
      ) => {
        const result = await createTradeOffer({
          twitchUserId,
          offeredUserCardId,
          wantedCardId,
          wantedQuantity,
          requestId,
        });
        if (result.kind !== "ok") throw new Error(`create failed: ${result.code}`);
        expect(result.offer.wanted_quantity).toBe(wantedQuantity);
        return result.offer.id;
      };
      offerIds.x3 = await create(TW.QO, QUC.O_A1, QC.B, 3, req(1));
      offerIds.x5 = await create(TW.QO, QUC.O_A2, QC.B, 5, req(2));

      const stateFor = async (twitchUserId?: string) => {
        const page = await listTradeOffers({ streamerId: S.QTY, scope: "in_channel", page: 1, twitchUserId });
        return Object.fromEntries(
          page.offers.map((offer) => [offer.id, { quantity: offer.wantedQuantity, canAccept: offer.canAccept }]),
        );
      };
      // QV owns 4 unlisted copies of B.
      expect(await stateFor(TW.QV)).toEqual({
        [offerIds.x3]: { quantity: 3, canAccept: "yes" },
        [offerIds.x5]: { quantity: 5, canAccept: "not_enough" },
      });
      // Anonymous viewers get the quantity but no canAccept.
      expect(await stateFor()).toEqual({
        [offerIds.x3]: { quantity: 3, canAccept: undefined },
        [offerIds.x5]: { quantity: 5, canAccept: undefined },
      });

      // QV lists its oldest and newest B copies: 4 owned but only 2 unlisted < 3.
      offerIds.vListB1 = await create(TW.QV, QUC.V_B1, QC.A, 1, req(3));
      offerIds.vListB4 = await create(TW.QV, QUC.V_B4, QC.A, 1, req(4));
      const listed = await stateFor(TW.QV);
      expect(listed[offerIds.x3]).toEqual({ quantity: 3, canAccept: "all_listed" });
      expect(listed[offerIds.x5]).toEqual({ quantity: 5, canAccept: "not_enough" });

      // Withdraw the B4 listing → 3 unlisted copies (B2, B3, B4); the OLDEST
      // copy B1 stays listed, so payment must skip it.
      await expect(cancelTradeOffer({ twitchUserId: TW.QV, tradeOfferId: offerIds.vListB4 }))
        .resolves.toEqual({ kind: "ok", id: offerIds.vListB4 });
      expect((await stateFor(TW.QV))[offerIds.x3]).toEqual({ quantity: 3, canAccept: "yes" });
    });

    it("never transfers N copies without the viewer agreeing to N (stale clients, old app)", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      const copies = [QUC.O_A1, QUC.V_B1, QUC.V_B2, QUC.V_B3, QUC.V_B4];
      const before = await ownerOf(copies);

      // A client that was shown "1 copy" (or sends nothing) gets a mismatch.
      await expect(acceptTradeOffer({ twitchUserId: TW.QV, tradeOfferId: offerIds.x3, requestId: req(9) }))
        .resolves.toEqual({ success: false, error: "QUANTITY_MISMATCH" });
      await expect(acceptTradeOffer({
        twitchUserId: TW.QV,
        tradeOfferId: offerIds.x3,
        requestId: req(9),
        expectedQuantity: 2,
      })).resolves.toEqual({ success: false, error: "QUANTITY_MISMATCH" });
      // The 3-argument signature the migration retains for pre-#1789 bundles
      // refuses with a code the app knows, instead of silently giving 3 copies.
      const [legacy] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
        SELECT public.accept_trade_offer(${TW.QV}, ${offerIds.x3}::uuid, ${req(10)}::uuid) AS result`;
      expect(legacy.result).toEqual({ success: false, error: "OFFER_NOT_OPEN" });

      expect(await ownerOf(copies)).toEqual(before);
      const [row] = await sql!<Array<{ status: string }>>`
        SELECT status FROM trade_offers WHERE id = ${offerIds.x3}`;
      expect(row.status).toBe("open");
    });

    it("accept transfers exactly the N oldest unlisted copies and replays idempotently", async () => {
      const { acceptTradeOffer, listMyTradeOffers } = await import("@/lib/trade");
      const result = await acceptTradeOffer({
        twitchUserId: TW.QV,
        tradeOfferId: offerIds.x3,
        requestId: req(11),
        expectedQuantity: 3,
      });
      expect(result).toMatchObject({
        success: true,
        idempotentReplay: false,
        tradeOfferId: offerIds.x3,
        receivedUserCardId: QUC.O_A1,
        // The oldest of the transferred copies is the one recorded.
        givenUserCardId: QUC.V_B2,
      });

      expect(await ownerOf([QUC.O_A1, QUC.V_B1, QUC.V_B2, QUC.V_B3, QUC.V_B4])).toEqual({
        [QUC.O_A1]: U.QV,
        // The oldest copy is listed in QV's own open offer → skipped.
        [QUC.V_B1]: U.QV,
        [QUC.V_B2]: U.QO,
        [QUC.V_B3]: U.QO,
        [QUC.V_B4]: U.QO,
      });
      const [row] = await sql!<Array<{ status: string; accepted_user_card_id: string }>>`
        SELECT status, accepted_user_card_id FROM trade_offers WHERE id = ${offerIds.x3}`;
      expect(row).toEqual({ status: "completed", accepted_user_card_id: QUC.V_B2 });

      // #1792 item 2: the accept route reports EVERY transferred copy. The RPC
      // only returns the oldest, so they are reconstructed from the moved rows
      // (obtained_at = the offer's completed_at). B1 stayed with QV (listed),
      // so exactly the three copies that moved are returned.
      const { getTradeOfferAuditParticipants } = await import("@/lib/trade");
      const audit = await getTradeOfferAuditParticipants(offerIds.x3);
      expect(audit.offererTwitchUserId).toBe(TW.QO);
      expect([...audit.givenUserCardIds].sort()).toEqual([QUC.V_B2, QUC.V_B3, QUC.V_B4].sort());

      await expect(acceptTradeOffer({
        twitchUserId: TW.QV,
        tradeOfferId: offerIds.x3,
        requestId: req(11),
        expectedQuantity: 3,
      })).resolves.toMatchObject({ success: true, idempotentReplay: true, givenUserCardId: QUC.V_B2 });
      // A replay of the same requestId through the retained 3-argument
      // signature (an old tab retrying after a deploy) still reports the
      // original success.
      const [legacyReplay] = await sql!<Array<{ result: { success: boolean; idempotentReplay?: boolean } }>>`
        SELECT public.accept_trade_offer(${TW.QV}, ${offerIds.x3}::uuid, ${req(11)}::uuid) AS result`;
      expect(legacyReplay.result).toMatchObject({ success: true, idempotentReplay: true });

      const mine = await listMyTradeOffers(TW.QV, { status: "completed" });
      expect(mine.offers.map((offer) => [offer.id, offer.wantedQuantity, offer.mineRole]))
        .toEqual([[offerIds.x3, 3, "acceptor"]]);
    });

    it("rejects with CARD_NOT_OWNED and moves nothing when fewer than N copies are available", async () => {
      const { acceptTradeOffer, cancelTradeOffer } = await import("@/lib/trade");
      // Free B1 again: QV now has exactly 1 unlisted copy of B for a ×5 offer.
      await cancelTradeOffer({ twitchUserId: TW.QV, tradeOfferId: offerIds.vListB1 });
      const copies = [QUC.O_A2, QUC.V_B1, QUC.V_B2, QUC.V_B3, QUC.V_B4];
      const before = await ownerOf(copies);

      await expect(acceptTradeOffer({
        twitchUserId: TW.QV,
        tradeOfferId: offerIds.x5,
        requestId: req(21),
        expectedQuantity: 5,
      })).resolves.toEqual({ success: false, error: "CARD_NOT_OWNED" });

      expect(await ownerOf(copies)).toEqual(before);
      const [row] = await sql!<Array<{ status: string }>>`
        SELECT status FROM trade_offers WHERE id = ${offerIds.x5}`;
      expect(row.status).toBe("open");
    });

    it("the DB CHECK rejects quantities outside 1..TRADE_MAX_WANTED_QUANTITY", async () => {
      const { TRADE_MAX_WANTED_QUANTITY } = await import("@/lib/trade");
      for (const quantity of [0, TRADE_MAX_WANTED_QUANTITY + 1]) {
        await expect(sql!`UPDATE trade_offers SET wanted_quantity = ${quantity} WHERE id = ${offerIds.x5}`)
          .rejects.toMatchObject({ code: "23514" });
      }
      await sql!`UPDATE trade_offers SET wanted_quantity = ${TRADE_MAX_WANTED_QUANTITY} WHERE id = ${offerIds.x5}`;
      await sql!`UPDATE trade_offers SET wanted_quantity = 5 WHERE id = ${offerIds.x5}`;
    });

    it("concurrent accepts by the same acceptor never spend more copies than owned", async () => {
      const { createTradeOffer, acceptTradeOffer } = await import("@/lib/trade");
      const s = sql!;
      // QV: B1 plus three new copies = 4 unlisted copies of B. QO lists two
      // ×3 offers; accepting both would need 6, so exactly one may succeed.
      const extraB = [id(8205), id(8206), id(8207)];
      for (const [i, ucid] of extraB.entries()) {
        await s`INSERT INTO user_cards (id, user_id, card_id, obtained_at)
          VALUES (${ucid}, ${U.QV}, ${QC.B}, now() - make_interval(secs => ${(10 - i) * 60}))`;
      }
      const extraA = [id(8104), id(8105)];
      for (const ucid of extraA) {
        await s`INSERT INTO user_cards (id, user_id, card_id) VALUES (${ucid}, ${U.QO}, ${QC.A})`;
      }
      const offers: string[] = [];
      for (const [i, ucid] of extraA.entries()) {
        const result = await createTradeOffer({
          twitchUserId: TW.QO,
          offeredUserCardId: ucid,
          wantedCardId: QC.B,
          wantedQuantity: 3,
          requestId: req(41 + i),
        });
        if (result.kind !== "ok") throw new Error(`create failed: ${result.code}`);
        offers.push(result.offer.id);
      }

      const results = await Promise.all(offers.map((tradeOfferId, i) =>
        acceptTradeOffer({ twitchUserId: TW.QV, tradeOfferId, requestId: req(51 + i), expectedQuantity: 3 })));
      expect(results.map((result) => result.success).sort()).toEqual([false, true]);
      expect(results.find((result) => !result.success)).toEqual({ success: false, error: "CARD_NOT_OWNED" });

      const [counts] = await s<Array<{ viewer: number; offerer: number }>>`
        SELECT
          count(*) FILTER (WHERE user_id = ${U.QV})::int AS viewer,
          count(*) FILTER (WHERE user_id = ${U.QO})::int AS offerer
        FROM user_cards
        WHERE id IN ${s([QUC.V_B1, ...extraB])}`;
      expect(counts).toEqual({ viewer: 1, offerer: 3 });
    });


  });

  // ---------------------------------------------------------------------------
  // #1790 「求に指定できる」制限 (cards.trade_wantable). A self-contained world
  // (ids 9xxx, its own channel and users) like the #1789 block. The tests are
  // order-dependent among themselves: listing → switch off → hidden/refused →
  // switch back → accepted → replay → deploy window.
  // ---------------------------------------------------------------------------
  describe("wantable restriction (#1790)", () => {
    // COIN stays wantable, RARE is switched off after OFFER_RARE was listed,
    // GIVE is what the offerer gives.
    const WC = { COIN: id(9001), RARE: id(9002), GIVE: id(9003) };
    const WUC = {
      O_GIVE1: id(9101),
      O_GIVE2: id(9102),
      O_GIVE3: id(9103),
      V_RARE1: id(9201),
      V_RARE2: id(9202),
      V_COIN1: id(9203),
    };
    const req = (n: number) => id(9900 + n);
    const offerIds: Record<string, string> = {};

    const setWantable = (cardId: string, value: boolean) =>
      sql!`UPDATE cards SET trade_wantable = ${value} WHERE id = ${cardId}`;
    const ownerOf = async (userCardIds: string[]) => {
      const rows = await sql!<Array<{ id: string; user_id: string }>>`
        SELECT id, user_id FROM user_cards WHERE id IN ${sql!(userCardIds)} ORDER BY id`;
      return Object.fromEntries(rows.map((row) => [row.id, row.user_id]));
    };
    const boardIds = async (twitchUserId?: string) => {
      const { listTradeOffers } = await import("@/lib/trade");
      const page = await listTradeOffers({ streamerId: S.WANT, scope: "in_channel", page: 1, twitchUserId });
      return page.offers.map((offer) => offer.id);
    };
    const mineTradeable = async () => {
      const { listMyTradeOffers } = await import("@/lib/trade");
      const page = await listMyTradeOffers(TW.WO, { status: "open" });
      return Object.fromEntries(page.offers.map((offer) => [offer.id, offer.tradeable]));
    };

    beforeAll(async () => {
      const s = sql!;
      await s`INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
      ) VALUES (${S.WANT}, 'tv-want', 'tv-want', 'TV want', TRUE, FALSE, TRUE, TRUE)`;
      await s`INSERT INTO users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
        (${U.WO}, ${TW.WO}, ${TW.WO}, 'Want Offerer'),
        (${U.WV}, ${TW.WV}, ${TW.WV}, 'Want Viewer')`;
      for (const [cid, name] of [[WC.COIN, "Coin"], [WC.RARE, "Rare"], [WC.GIVE, "Give"]]) {
        await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
          VALUES (${cid}, ${S.WANT}, ${name}, 'common', 0.1, TRUE)`;
      }
      const own = (ucid: string, uid: string, cid: string, minutesAgo: number) =>
        s`INSERT INTO user_cards (id, user_id, card_id, obtained_at)
          VALUES (${ucid}, ${uid}, ${cid}, now() - make_interval(secs => ${minutesAgo * 60}))`;
      await own(WUC.O_GIVE1, U.WO, WC.GIVE, 60);
      await own(WUC.O_GIVE2, U.WO, WC.GIVE, 59);
      await own(WUC.O_GIVE3, U.WO, WC.GIVE, 58);
      await own(WUC.V_RARE1, U.WV, WC.RARE, 50);
      await own(WUC.V_RARE2, U.WV, WC.RARE, 49);
      await own(WUC.V_COIN1, U.WV, WC.COIN, 48);
    });

    it("the migration defaults every card to wantable", async () => {
      const rows = await sql!<Array<{ trade_wantable: boolean }>>`
        SELECT trade_wantable FROM cards WHERE streamer_id = ${S.WANT}`;
      expect(rows.map((row) => row.trade_wantable)).toEqual([true, true, true]);
    });

    it("rejects new listings that want a non-wantable card, but not listings that give one", async () => {
      const { createTradeOffer, cancelTradeOffer, listWantableCards } = await import("@/lib/trade");
      const created = await createTradeOffer({
        twitchUserId: TW.WO,
        offeredUserCardId: WUC.O_GIVE1,
        wantedCardId: WC.RARE,
        requestId: req(1),
      });
      if (created.kind !== "ok") throw new Error(`create failed: ${created.code}`);
      offerIds.rare = created.offer.id;
      const coin = await createTradeOffer({
        twitchUserId: TW.WO,
        offeredUserCardId: WUC.O_GIVE2,
        wantedCardId: WC.COIN,
        requestId: req(2),
      });
      if (coin.kind !== "ok") throw new Error(`create failed: ${coin.code}`);
      offerIds.coin = coin.offer.id;

      await setWantable(WC.RARE, false);

      // Wanting RARE is refused (the server check is authoritative)...
      await expect(createTradeOffer({
        twitchUserId: TW.WO,
        offeredUserCardId: WUC.O_GIVE3,
        wantedCardId: WC.RARE,
        requestId: req(3),
      })).resolves.toEqual({ kind: "error", code: "TRADE_WANTED_CARD_NOT_WANTABLE" });
      // ...but an earlier create of the same request still replays.
      await expect(createTradeOffer({
        twitchUserId: TW.WO,
        offeredUserCardId: WUC.O_GIVE1,
        wantedCardId: WC.RARE,
        requestId: req(1),
      })).resolves.toMatchObject({ kind: "ok", idempotentReplay: true, offer: { id: offerIds.rare } });

      // Giving a RARE copy is not restricted.
      const give = await createTradeOffer({
        twitchUserId: TW.WV,
        offeredUserCardId: WUC.V_RARE2,
        wantedCardId: WC.GIVE,
        requestId: req(4),
      });
      expect(give).toMatchObject({ kind: "ok", idempotentReplay: false });
      if (give.kind !== "ok") throw new Error("unreachable");
      await cancelTradeOffer({ twitchUserId: TW.WV, tradeOfferId: give.offer.id });

      // The listing form never offers RARE as a choice, for anyone.
      for (const viewer of [TW.WV, TW.WO, null]) {
        const cards = await listWantableCards(viewer, S.WANT);
        expect(cards.map((card) => card.cardId).sort()).toEqual([WC.COIN, WC.GIVE].sort());
      }
    });

    it("hides the existing offer from the board for everyone, and marks it not tradeable on /mine", async () => {
      for (const viewer of [TW.WV, TW.WO, undefined]) {
        const ids = await boardIds(viewer);
        expect(ids).not.toContain(offerIds.rare);
        expect(ids).toContain(offerIds.coin);
      }
      expect(await mineTradeable()).toEqual({ [offerIds.rare]: false, [offerIds.coin]: true });
      // Not cancelled: it is only hidden.
      const [row] = await sql!<Array<{ status: string }>>`
        SELECT status FROM trade_offers WHERE id = ${offerIds.rare}`;
      expect(row.status).toBe("open");
    });

    it("refuses to accept it through the API precheck and directly through both RPC signatures", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      const copies = [WUC.O_GIVE1, WUC.V_RARE1, WUC.V_RARE2];
      const before = await ownerOf(copies);

      await expect(acceptTradeOffer({ twitchUserId: TW.WV, tradeOfferId: offerIds.rare, requestId: req(11) }))
        .resolves.toEqual({ success: false, error: "TRADE_OFFER_UNAVAILABLE" });
      // The RPC does not rely on the API layer (old app, direct call, race).
      const [rpc4] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
        SELECT public.accept_trade_offer(${TW.WV}, ${offerIds.rare}::uuid, ${req(12)}::uuid, 1::smallint) AS result`;
      expect(rpc4.result).toEqual({ success: false, error: "WANTED_CARD_NOT_WANTABLE" });
      // The pre-#1789 3-argument signature answers a code that app knows.
      const [rpc3] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
        SELECT public.accept_trade_offer(${TW.WV}, ${offerIds.rare}::uuid, ${req(13)}::uuid) AS result`;
      expect(rpc3.result).toEqual({ success: false, error: "OFFER_NOT_OPEN" });

      expect(await ownerOf(copies)).toEqual(before);
      const [row] = await sql!<Array<{ status: string }>>`
        SELECT status FROM trade_offers WHERE id = ${offerIds.rare}`;
      expect(row.status).toBe("open");
    });

    it("comes back when the streamer switches the card back, and an accepted offer replays after switching off again", async () => {
      const { acceptTradeOffer } = await import("@/lib/trade");
      await setWantable(WC.RARE, true);

      expect(await boardIds(TW.WV)).toContain(offerIds.rare);
      expect((await mineTradeable())[offerIds.rare]).toBe(true);

      const accepted = await acceptTradeOffer({ twitchUserId: TW.WV, tradeOfferId: offerIds.rare, requestId: req(21) });
      expect(accepted).toMatchObject({
        success: true,
        idempotentReplay: false,
        receivedUserCardId: WUC.O_GIVE1,
        givenUserCardId: WUC.V_RARE1,
      });
      expect(await ownerOf([WUC.O_GIVE1, WUC.V_RARE1])).toEqual({
        [WUC.O_GIVE1]: U.WV,
        [WUC.V_RARE1]: U.WO,
      });

      // The idempotent replay is decided before every validation (RPC and API
      // precheck), so switching the card off again does not turn a committed
      // trade into a failure for a client retry.
      await setWantable(WC.RARE, false);
      await expect(acceptTradeOffer({ twitchUserId: TW.WV, tradeOfferId: offerIds.rare, requestId: req(21) }))
        .resolves.toMatchObject({ success: true, idempotentReplay: true, givenUserCardId: WUC.V_RARE1 });
      await setWantable(WC.RARE, true);
    });

    it("rollback window: the DB lets a rolled-back app list the offer, and acceptance still fails closed (#1801)", async () => {
      // レビュー任意指摘: ロールバック後の旧アプリの挙動（応諾は 500 で拒否側に
      // 倒れる、新規出品は止まらない）はこれまでコメント（20261014100000 の
      // #1790 ブロック注記）でのみ説明されていた。ロールバック中は、trade_wantable
      // を知らない「旧アプリのサーバコード」（createTradeOffer の wantable 検証も
      // PUT /api/cards/[id] の書き込みも無い）が、この migration 適用済みの新しい
      // DB に対して動く。ここでその DB 側の前提を固定する:
      //   - migration は trade_offers への制約・トリガーを追加しない（wantable の
      //     出品強制はアプリ層だけ）ため、旧アプリの出品 INSERT は DB エラーに
      //     ならない = 新規出品は止まらない。実害は小さい: 再デプロイ後のボードでは
      //     非表示になる（下の (2)）。
      //   - それでも応諾だけは fail-closed。#1789 時点のアプリは4引数 RPC で
      //     WANTED_CARD_NOT_WANTABLE を受け取り、結果検証（既知コード以外は throw）
      //     が例外にして 500 を返す。その機構は trade-accept-service.test.ts の
      //     ロールバックピン（旧アプリの既知集合にこのコードが無いこと）と
      //     「fails closed on unknown failure code」で固定する。pre-#1789 アプリは
      //     3引数ラッパーが OFFER_NOT_OPEN へ読み替えるため 500 にはならない。
      const rollbackOfferId = id(9301);
      await setWantable(WC.RARE, false);
      try {
        // (1) 新規出品は止まらない: ロールバック中の旧アプリが作る行と同等の
        // INSERT が成功する（auctions の拘束トリガーも、拘束されていないコピーに
        // は介入しない）。旧アプリは wanted_quantity を送らないので既定の 1。
        await sql!`
          INSERT INTO trade_offers (
            id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
            wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot, request_id
          ) VALUES (
            ${rollbackOfferId}, ${U.WO}, ${WUC.O_GIVE3}, ${WC.GIVE}, ${S.WANT},
            ${WC.RARE}, ${S.WANT}, '{}'::jsonb, '{}'::jsonb, ${req(40)}
          )`;
        const [listed] = await sql!<Array<{ status: string }>>`
          SELECT status FROM trade_offers WHERE id = ${rollbackOfferId}`;
        expect(listed.status).toBe("open");

        // (2) 再デプロイ後（= 現行アプリ）のボードでは、出品者にも見えない。
        for (const viewer of [TW.WV, TW.WO, undefined]) {
          expect(await boardIds(viewer)).not.toContain(rollbackOfferId);
        }

        // (3) 応諾はどちらのシグネチャでも拒否され、何も移転しない。
        //    成功していたら動いていたコピー（渡す O_GIVE3 と支払い候補 V_RARE2）で検証。
        const copies = [WUC.O_GIVE3, WUC.V_RARE2];
        const before = await ownerOf(copies);
        const [rpc4] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
          SELECT public.accept_trade_offer(${TW.WV}, ${rollbackOfferId}::uuid, ${req(41)}::uuid, 1::smallint) AS result`;
        expect(rpc4.result).toEqual({ success: false, error: "WANTED_CARD_NOT_WANTABLE" });
        const [rpc3] = await sql!<Array<{ result: { success: boolean; error?: string } }>>`
          SELECT public.accept_trade_offer(${TW.WV}, ${rollbackOfferId}::uuid, ${req(42)}::uuid) AS result`;
        expect(rpc3.result).toEqual({ success: false, error: "OFFER_NOT_OPEN" });
        expect(await ownerOf(copies)).toEqual(before);
        const [stillOpen] = await sql!<Array<{ status: string }>>`
          SELECT status FROM trade_offers WHERE id = ${rollbackOfferId}`;
        expect(stillOpen.status).toBe("open");
      } finally {
        // 後続テストのため状態を戻す: O_GIVE3 は deploy window テストで再出品に
        // 使われ、helpers テストは全カード指定可を期待する。
        await sql!`UPDATE trade_offers SET status = 'cancelled' WHERE id = ${rollbackOfferId}`;
        await setWantable(WC.RARE, true);
      }
    });

    it("card management helpers read and write the flag (owner check is the route's job)", async () => {
      const { listNonWantableCardIds, updateCardTradeWantable } = await import("@/lib/card-trade-wantable");
      expect([...await listNonWantableCardIds(S.WANT)]).toEqual([]);
      await expect(updateCardTradeWantable(WC.COIN, false)).resolves.toEqual({ trade_wantable: false });
      expect([...await listNonWantableCardIds(S.WANT)]).toEqual([WC.COIN]);
      await expect(updateCardTradeWantable(id(9999), false)).resolves.toBeNull();
      await expect(updateCardTradeWantable(WC.COIN, true)).resolves.toEqual({ trade_wantable: true });
    });

    it("deploy window: every card is wantable while the column does not exist yet", async () => {
      const { createTradeOffer, listWantableCards, listMyTradeOffers } = await import("@/lib/trade");
      const { listNonWantableCardIds, updateCardTradeWantable } = await import("@/lib/card-trade-wantable");
      // Simulate the database before 20261014100000 for the app code (rename
      // instead of drop so the column and its values come back unchanged).
      // accept_trade_offer is not called here: it is created by the same
      // migration as the column, so the app never sees one without the other.
      await setWantable(WC.COIN, false);
      await sql!`ALTER TABLE cards RENAME COLUMN trade_wantable TO trade_wantable_hidden`;
      try {
        expect((await listWantableCards(TW.WV, S.WANT)).map((card) => card.cardId)).toContain(WC.COIN);
        expect(await boardIds(TW.WV)).toContain(offerIds.coin);
        const mine = await listMyTradeOffers(TW.WO, { status: "open" });
        expect(mine.offers.find((offer) => offer.id === offerIds.coin)?.tradeable).toBe(true);
        await expect(createTradeOffer({
          twitchUserId: TW.WO,
          offeredUserCardId: WUC.O_GIVE3,
          wantedCardId: WC.COIN,
          wantedQuantity: 2,
          requestId: req(31),
        })).resolves.toMatchObject({ kind: "ok", idempotentReplay: false });

        expect([...await listNonWantableCardIds(S.WANT)]).toEqual([]);
        await expect(updateCardTradeWantable(WC.COIN, true)).resolves.toBe("column_missing");
      } finally {
        await sql!`ALTER TABLE cards RENAME COLUMN trade_wantable_hidden TO trade_wantable`;
        await setWantable(WC.COIN, true);
      }
    });
  });
});
