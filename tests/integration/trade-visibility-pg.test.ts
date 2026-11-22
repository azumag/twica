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
  // 項目別公開（#2070 フォローアップ）の専用チャネル。
  // NAMEONLY: 名前だけ公開 / IMAGEONLY: 画像だけ公開 /
  // HIDDEN_ALL: 全項目非公開（#N のみ） / GUARD_C: 旧 details=false かつ
  // 新3列すべて true（旧アプリ OFF の取りこぼしガード c） /
  // MASTER_OFF: show_unowned_cards=false（行自体を出さない）。
  NAMEONLY: id(10),
  IMAGEONLY: id(17),
  HIDDEN_ALL: id(20),
  GUARD_C: id(24),
  MASTER_OFF: id(25),
  // 表示番号の一致テスト専用（無効化カードを含む）。
  NUMBER: id(26),
  // #2079: dedicated world for the hub's per-collection lists. Each channel is
  // isolated from the shared PUB/PRIV world so the new totals stay exact.
  COL_A: id(70), // case 1 offered side; private, the viewer owns a copy
  COL_B: id(71), // case 1 wanted side; private, the viewer owns a copy
  COL_A2: id(72), // case 2 offered side; private, the viewer owns a copy
  COL_B2: id(73), // case 2 wanted side; public, the viewer owns nothing
  COL_MANY: id(74), // case 3/4; private, the viewer owns its cards
  COL_VIS: id(75), // case 5 offered side; private, the viewer owns a copy
  COL_NAMEONLY: id(76), // case 5 wanted side; names public, images hidden
  COL_HIDDEN: id(77), // case 5 wanted side; names and images hidden
};
const U = {
  O: id(11),
  V: id(12),
  QO: id(13),
  QV: id(14),
  WO: id(15),
  WV: id(16),
  // #2070: dedicated users so the existing PUB/PRIV partner assertions are
  // untouched (a new channel owned by O or V would change their candidate list).
  NO: id(18),
  NOV: id(19),
  // #2079: dedicated users of the per-collection world.
  COL_OFF: id(81),
  COL_V: id(82),
};
const TW = {
  O: "trade-vis-offerer",
  V: "trade-vis-viewer",
  QO: "trade-vis-qty-offerer",
  QV: "trade-vis-qty-viewer",
  WO: "trade-vis-want-offerer",
  WV: "trade-vis-want-viewer",
  NO: "trade-vis-nameonly-offerer",
  NOV: "trade-vis-nameonly-viewer",
  COL_OFF: "trade-vis-col-offerer",
  COL_V: "trade-vis-col-viewer",
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
  NAMEONLY_A: id(43),
  NAMEONLY_B: id(44),
  IMAGEONLY_A: id(45),
  IMAGEONLY_B: id(46),
  HIDDEN_ALL_A: id(47),
  HIDDEN_ALL_B: id(48),
  GUARD_C_A: id(49),
  GUARD_C_B: id(50),
  MASTER_OFF_A: id(52),
  MASTER_OFF_B: id(53),
  // NUMBER: 無効化カード (56) が先に作られ、番号表に含まれる。
  NUMBER_OLD: id(54),
  NUMBER_A: id(55),
  NUMBER_B: id(56),
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
  NO_NAMEONLY_A: id(110),
  NO_IMAGEONLY_A: id(111),
  NO_HIDDEN_ALL_A: id(112),
  NO_GUARD_C_A: id(113),
  NO_MASTER_OFF_A: id(114),
  NOV_NAMEONLY_B: id(210),
  NOV_IMAGEONLY_B: id(211),
  NOV_HIDDEN_ALL_B: id(212),
  NOV_GUARD_C_B: id(213),
  NOV_MASTER_OFF_B: id(214),
  V_PRIV_B: id(201),
  V_PRIV_C: id(202),
  V_PUB_B: id(203),
  O_NUMBER_A: id(115),
  V_NUMBER_B: id(215),
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
  NAMEONLY: id(310), // NAMEONLY_A → NAMEONLY_B（名前だけ公開）
  IMAGEONLY: id(311), // IMAGEONLY_A → IMAGEONLY_B（画像だけ公開）
  HIDDEN_ALL: id(312), // HIDDEN_ALL_A → HIDDEN_ALL_B（全項目非公開）
  GUARD_C: id(313), // GUARD_C_A → GUARD_C_B（ガード c）
  MASTER_OFF: id(314), // MASTER_OFF_A → MASTER_OFF_B（行を出さない）
  NUMBER: id(315), // NUMBER_A → NUMBER_B（表示番号の一致）
};
/** Secret image URLs stored in the #2070 snapshots. */
const NAMEONLY_IMAGES = {
  A: "https://secret.example/nameonly-a.png",
  B: "https://secret.example/nameonly-b.png",
  IMAGE_A: "https://secret.example/imageonly-a.png",
  IMAGE_B: "https://secret.example/imageonly-b.png",
  HIDDEN_A: "https://secret.example/hidden-all-a.png",
  HIDDEN_B: "https://secret.example/hidden-all-b.png",
  GUARD_A: "https://secret.example/guard-c-a.png",
  GUARD_B: "https://secret.example/guard-c-b.png",
  MASTER_A: "https://secret.example/master-off-a.png",
  MASTER_B: "https://secret.example/master-off-b.png",
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
  /**
   * 1配信者を投入する。
   *
   * 項目別公開（show_unowned_card_name/_image/_description）を明示的に指定する。
   * 省略時は旧 details と同じ値にする（PUB/OFF/NOCROSS のような「詳細公開」
   * チャネルをそのまま移行するため）。ガード c（details=false かつ3列 true）や
   * 全非公開は明示的に作る。
   */
  const streamer = (
    sid: string,
    name: string,
    flags: {
      trade: boolean;
      cross: boolean;
      unowned: boolean;
      details: boolean;
      name?: boolean;
      image?: boolean;
      description?: boolean;
    },
  ) => s`
    INSERT INTO streamers (
      id, twitch_user_id, twitch_username, twitch_display_name,
      trade_enabled, cross_channel_trade_enabled, show_unowned_cards,
      show_unowned_card_details, show_unowned_card_name, show_unowned_card_image,
      show_unowned_card_description
    ) VALUES (
      ${sid}, ${`tv-${name}`}, ${`tv-${name}`}, ${`TV ${name}`},
      ${flags.trade}, ${flags.cross}, ${flags.unowned}, ${flags.details},
      ${flags.name ?? flags.details}, ${flags.image ?? flags.details},
      ${flags.description ?? flags.details}
    )`;
  await streamer(S.PUB, "pub", { trade: true, cross: true, unowned: true, details: true });
  await streamer(S.PRIV, "priv", { trade: true, cross: true, unowned: false, details: false });
  // HALF: 行は出るが全項目非公開（#N だけで選ぶ状態）。
  await streamer(S.HALF, "half", { trade: true, cross: true, unowned: true, details: false });
  await streamer(S.NAMEONLY, "nameonly", {
    trade: true, cross: true, unowned: true, details: false,
    name: true, image: false, description: false,
  });
  await streamer(S.IMAGEONLY, "imageonly", {
    trade: true, cross: true, unowned: true, details: false,
    name: false, image: true, description: false,
  });
  await streamer(S.HIDDEN_ALL, "hidden-all", {
    trade: true, cross: true, unowned: true, details: false,
    name: false, image: false, description: false,
  });
  // ガード c: 旧アプリで details を OFF にした取りこぼし（3列は true のまま）。
  await streamer(S.GUARD_C, "guard-c", {
    trade: true, cross: true, unowned: true, details: false,
    name: true, image: true, description: true,
  });
  // マスタースイッチ OFF: 項目別フラグが true でも行を出さない。
  await streamer(S.MASTER_OFF, "master-off", {
    trade: true, cross: true, unowned: false, details: false,
    name: true, image: true, description: true,
  });
  // 表示番号の一致テスト用。全項目非公開だが行は出る。
  await streamer(S.NUMBER, "number", {
    // cross=false: このチャネルを cross partner 一覧に混ぜない（既存の
    // partner 期待値を変えないため）。番号テストは in-channel だけで足りる。
    trade: true, cross: false, unowned: true, details: false,
    name: false, image: false, description: false,
  });
  await streamer(S.OFF, "off", { trade: false, cross: true, unowned: true, details: true });
  await streamer(S.NOCROSS, "nocross", { trade: true, cross: false, unowned: true, details: true });

  await s`INSERT INTO users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
    (${U.O}, ${TW.O}, ${TW.O}, 'Offerer O'),
    (${U.V}, ${TW.V}, ${TW.V}, 'Viewer V'),
    (${U.NO}, ${TW.NO}, ${TW.NO}, 'NameOnly Offerer'),
    (${U.NOV}, ${TW.NOV}, ${TW.NOV}, 'NameOnly Viewer')`;

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
  await card(C.NAMEONLY_A, S.NAMEONLY, "NameOnly A", "common", true);
  await card(C.NAMEONLY_B, S.NAMEONLY, "NameOnly B", "rare", true);
  await card(C.IMAGEONLY_A, S.IMAGEONLY, "ImageOnly A", "common", true);
  await card(C.IMAGEONLY_B, S.IMAGEONLY, "ImageOnly B", "rare", true);
  await card(C.HIDDEN_ALL_A, S.HIDDEN_ALL, "Hidden All A", "common", true);
  await card(C.HIDDEN_ALL_B, S.HIDDEN_ALL, "Hidden All B", "rare", true);
  await card(C.GUARD_C_A, S.GUARD_C, "Guard C A", "common", true);
  await card(C.GUARD_C_B, S.GUARD_C, "Guard C B", "rare", true);
  await card(C.MASTER_OFF_A, S.MASTER_OFF, "Master Off A", "common", true);
  await card(C.MASTER_OFF_B, S.MASTER_OFF, "Master Off B", "rare", true);
  // NUMBER: 無効化カードを含む。card_number を明示して、番号表が
  // アクティブ/所持だけでは作れないことを固定する。名前は「番号順と逆」に
  // して、名前順で並べば漏れる（テスト e）ことを検出できるようにする。
  await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active, card_number) VALUES
    (${C.NUMBER_OLD}, ${S.NUMBER}, 'Zzz old inactive', 'common', 0.1, FALSE, 1),
    (${C.NUMBER_A}, ${S.NUMBER}, 'Zzz A first by number', 'common', 0.1, TRUE, 2),
    (${C.NUMBER_B}, ${S.NUMBER}, 'Aaa B second by number', 'common', 0.1, TRUE, 3)`;
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
  await own(UC.NO_NAMEONLY_A, U.NO, C.NAMEONLY_A, 91);
  await own(UC.NO_IMAGEONLY_A, U.NO, C.IMAGEONLY_A, 91);
  await own(UC.NO_HIDDEN_ALL_A, U.NO, C.HIDDEN_ALL_A, 91);
  await own(UC.NO_GUARD_C_A, U.NO, C.GUARD_C_A, 91);
  await own(UC.NO_MASTER_OFF_A, U.NO, C.MASTER_OFF_A, 91);
  await own(UC.NOV_NAMEONLY_B, U.NOV, C.NAMEONLY_B, 91);
  await own(UC.NOV_IMAGEONLY_B, U.NOV, C.IMAGEONLY_B, 91);
  await own(UC.NOV_HIDDEN_ALL_B, U.NOV, C.HIDDEN_ALL_B, 91);
  await own(UC.NOV_GUARD_C_B, U.NOV, C.GUARD_C_B, 91);
  await own(UC.NOV_MASTER_OFF_B, U.NOV, C.MASTER_OFF_B, 91);
  await own(UC.V_PRIV_B, U.V, C.PRIV_B, 90);
  await own(UC.V_PRIV_C, U.V, C.PRIV_C, 89);
  await own(UC.V_PUB_B, U.V, C.PUB_B, 88);
  await own(UC.V_OFF_A, U.V, C.OFF_A, 87);
  await own(UC.V_NOCROSS_A, U.V, C.NOCROSS_A, 86);
  // NUMBER: O が出品する A、V が支払う B。
  await own(UC.O_NUMBER_A, U.O, C.NUMBER_A, 85);
  await own(UC.V_NUMBER_B, U.V, C.NUMBER_B, 84);

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
  await offer(OF.NUMBER, UC.O_NUMBER_A, C.NUMBER_A, S.NUMBER, C.NUMBER_B, S.NUMBER, 41);

  // 項目別公開の検証用: 実画像 URL を入れた snapshot。保存済み JSONB は
  // 完全なまま（読み取り時に maskTradeCards が落とす）。
  const itemOffer = async (
    offerId: string,
    userCardId: string,
    offeredCardId: string,
    wantedCardId: string,
    streamerId: string,
    offeredName: string,
    wantedName: string,
    offeredImage: string,
    wantedImage: string,
    minutesAgo: number,
  ) => s`INSERT INTO trade_offers (
      id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
      wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot, created_at
    ) VALUES (
      ${offerId}, ${U.NO}, ${userCardId}, ${offeredCardId}, ${streamerId},
      ${wantedCardId}, ${streamerId},
      ${JSON.stringify({ name: offeredName, rarity: "common", imageUrl: offeredImage })}::jsonb,
      ${JSON.stringify({ name: wantedName, rarity: "rare", imageUrl: wantedImage })}::jsonb,
      now() - make_interval(secs => ${minutesAgo * 60})
    )`;
  await itemOffer(OF.NAMEONLY, UC.NO_NAMEONLY_A, C.NAMEONLY_A, C.NAMEONLY_B, S.NAMEONLY, "NameOnly A", "NameOnly B", NAMEONLY_IMAGES.A, NAMEONLY_IMAGES.B, 30);
  await itemOffer(OF.IMAGEONLY, UC.NO_IMAGEONLY_A, C.IMAGEONLY_A, C.IMAGEONLY_B, S.IMAGEONLY, "ImageOnly A", "ImageOnly B", NAMEONLY_IMAGES.IMAGE_A, NAMEONLY_IMAGES.IMAGE_B, 29);
  await itemOffer(OF.HIDDEN_ALL, UC.NO_HIDDEN_ALL_A, C.HIDDEN_ALL_A, C.HIDDEN_ALL_B, S.HIDDEN_ALL, "Hidden All A", "Hidden All B", NAMEONLY_IMAGES.HIDDEN_A, NAMEONLY_IMAGES.HIDDEN_B, 28);
  await itemOffer(OF.GUARD_C, UC.NO_GUARD_C_A, C.GUARD_C_A, C.GUARD_C_B, S.GUARD_C, "Guard C A", "Guard C B", NAMEONLY_IMAGES.GUARD_A, NAMEONLY_IMAGES.GUARD_B, 27);
  await itemOffer(OF.MASTER_OFF, UC.NO_MASTER_OFF_A, C.MASTER_OFF_A, C.MASTER_OFF_B, S.MASTER_OFF, "Master Off A", "Master Off B", NAMEONLY_IMAGES.MASTER_A, NAMEONLY_IMAGES.MASTER_B, 26);

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

      // show_unowned_cards=true なので行は出るが、全項目非公開なので名前・画像は
      // 読み取り時マスクで落ちる（#N だけで選ぶ状態）。
      const half = await listIds({ streamerId: S.HALF, scope: "in_channel", page: 1 });
      expect(half.ids).toEqual([OF.HALF]);
      expect(half.result.offers[0].offeredCard).toMatchObject({ name: "", imageUrl: null });
      expect(half.result.offers[0].wantedCard).toMatchObject({ name: "", imageUrl: null });
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

      // HALF は行を出すが全項目非公開。所持していない V には同じ #N-only 行が
      // 見える（匿名と同じ集合）。
      const halfViewer = await listIds({
        streamerId: S.HALF,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      expect(halfViewer.ids).toEqual([OF.HALF]);
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
      // show_unowned_cards=false のチャネルは、項目別フラグが true でも
      // 行自体が出ない（未所持カードはトレード不可）。
      await expect(createTradeOffer({
        twitchUserId: TW.V,
        offeredUserCardId: UC.V_PRIV_B,
        wantedCardId: C.MASTER_OFF_B,
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

      // O already has 30 open offers (≥ TRADE_MAX_OPEN_OFFERS): an unlisted
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

      // O: 20 bulk + 9 still-open seeded offers
      // (10 seeded including OF.NUMBER − OF.PUB completed) = 29.
      const open1 = await listMyTradeOffers(TW.O, { status: "open", page: 1 });
      expect(open1.offers).toHaveLength(20);
      expect(open1.hasMore).toBe(true);
      const open2 = await listMyTradeOffers(TW.O, { status: "open", page: 2 });
      expect(open2.offers).toHaveLength(9);
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
        revealsUnownedCardNames: true,
        revealsUnownedCardImages: true,
      });
      // 行は出るが全項目非公開。
      await expect(getTradeBoardStreamer(S.HALF)).resolves.toMatchObject({
        revealsUnownedCards: true,
        revealsUnownedCardNames: false,
        revealsUnownedCardImages: false,
      });
      // 名前だけ公開 / 画像だけ公開は独立。
      await expect(getTradeBoardStreamer(S.NAMEONLY)).resolves.toMatchObject({
        revealsUnownedCards: true,
        revealsUnownedCardNames: true,
        revealsUnownedCardImages: false,
      });
      await expect(getTradeBoardStreamer(S.IMAGEONLY)).resolves.toMatchObject({
        revealsUnownedCards: true,
        revealsUnownedCardNames: false,
        revealsUnownedCardImages: true,
      });
      // ガード c: details=false かつ新3列すべて true → 全非公開。
      await expect(getTradeBoardStreamer(S.GUARD_C)).resolves.toMatchObject({
        revealsUnownedCards: true,
        revealsUnownedCardNames: false,
        revealsUnownedCardImages: false,
      });
      // マスタースイッチ OFF は項目別フラグより優先。
      await expect(getTradeBoardStreamer(S.MASTER_OFF)).resolves.toMatchObject({
        revealsUnownedCards: false,
        revealsUnownedCardNames: false,
        revealsUnownedCardImages: false,
      });
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
      // HALF は行を出すが全項目非公開: 名前 "" / 画像 null で一覧に載る。
      const half = await listWantableCards(null, S.HALF);
      expect(half.map((card) => card.cardId).sort()).toEqual([C.HALF_A, C.HALF_B].sort());
      expect(half.every((card) => card.name === "" && card.imageUrl === null)).toBe(true);
      // 所持していないログイン視聴者も同じ集合・同じマスク。
      const halfViewer = await listWantableCards(TW.V, S.HALF);
      expect(halfViewer.map((card) => card.cardId).sort()).toEqual([C.HALF_A, C.HALF_B].sort());
      expect(halfViewer.every((card) => card.isOwned === false)).toBe(true);

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
          trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details,
          show_unowned_card_name, show_unowned_card_image, show_unowned_card_description
        ) VALUES (${streamerId}, ${`tv-partner-${cardStart}`}, ${`tv-partner-${cardStart}`}, ${name}, TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE)`;
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
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details,
        show_unowned_card_name, show_unowned_card_image, show_unowned_card_description
      ) VALUES (${S.QTY}, 'tv-qty', 'tv-qty', 'TV qty', TRUE, FALSE, TRUE, TRUE, TRUE, TRUE, TRUE)`;
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
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details,
        show_unowned_card_name, show_unowned_card_image, show_unowned_card_description
      ) VALUES (${S.WANT}, 'tv-want', 'tv-want', 'TV want', TRUE, FALSE, TRUE, TRUE, TRUE, TRUE, TRUE)`;
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

  // ---------------------------------------------------------------------------
  // 未所持カードの項目別公開（#2070 フォローアップ）。
  //
  // 行の可視性 = is_active AND (所持 OR show_unowned_cards)。名前/画像は
  // resolveUnownedCardVisibility と同じ規則（a〜d）で読み取り時にマスクする。
  // 旧 trade_unowned_card_names_visible は使わない。
  // ---------------------------------------------------------------------------
  describe("unowned card item visibility (follow-up of #2070)", () => {
    const numberMapFor = async (streamerId: string) => {
      const { createCollectionNumberMap } = await import("@/lib/collection-utils");
      const rows = await sql!<Array<{
        id: string;
        card_number: number | null;
        created_at: string;
      }>>`
        SELECT id, card_number, created_at FROM cards WHERE streamer_id = ${streamerId}`;
      return createCollectionNumberMap(rows);
    };

    it("(f) name-only reveals the name but never the image; image-only is the mirror", async () => {
      const { listTradeOffers, listWantableCards } = await import("@/lib/trade");

      const nameOnly = await listTradeOffers({
        streamerId: S.NAMEONLY,
        scope: "in_channel",
        page: 1,
      });
      const nameOffer = nameOnly.offers.find((offer) => offer.id === OF.NAMEONLY);
      expect(nameOffer?.offeredCard).toMatchObject({ name: "NameOnly A", imageUrl: null });
      expect(nameOffer?.wantedCard).toMatchObject({ name: "NameOnly B", imageUrl: null });
      expect(JSON.stringify(nameOnly)).not.toContain(NAMEONLY_IMAGES.A);
      expect(JSON.stringify(nameOnly)).not.toContain(NAMEONLY_IMAGES.B);

      const imageOnly = await listTradeOffers({
        streamerId: S.IMAGEONLY,
        scope: "in_channel",
        page: 1,
      });
      const imageOffer = imageOnly.offers.find((offer) => offer.id === OF.IMAGEONLY);
      expect(imageOffer?.offeredCard).toEqual({
        name: "",
        rarity: "common",
        imageUrl: NAMEONLY_IMAGES.IMAGE_A,
        collectionNumber: (await numberMapFor(S.IMAGEONLY)).get(C.IMAGEONLY_A),
      });
      expect(imageOffer?.wantedCard).toMatchObject({
        name: "",
        imageUrl: NAMEONLY_IMAGES.IMAGE_B,
      });

      // The picker uses the same flags: names hidden for image-only, kept for
      // name-only; images appear only for the image-only channel.
      const nameOnlyCards = await listWantableCards(null, S.NAMEONLY);
      expect(nameOnlyCards.map((card) => card.name).sort()).toEqual(["NameOnly A", "NameOnly B"]);
      expect(nameOnlyCards.every((card) => card.imageUrl === null)).toBe(true);
      const imageOnlyCards = await listWantableCards(null, S.IMAGEONLY);
      expect(imageOnlyCards.every((card) => card.name === "")).toBe(true);
      expect(imageOnlyCards.map((card) => card.imageUrl).sort()).toEqual(
        [NAMEONLY_IMAGES.IMAGE_A, NAMEONLY_IMAGES.IMAGE_B].sort(),
      );
    });

    it("(g) guard c: details=false with all three item flags true masks every item", async () => {
      const { listTradeOffers } = await import("@/lib/trade");
      const board = await listTradeOffers({
        streamerId: S.GUARD_C,
        scope: "in_channel",
        page: 1,
      });
      const offer = board.offers.find((item) => item.id === OF.GUARD_C);
      expect(offer).toBeDefined();
      expect(offer?.offeredCard).toMatchObject({ name: "", imageUrl: null });
      expect(offer?.wantedCard).toMatchObject({ name: "", imageUrl: null });
      expect(offer?.offeredCard.collectionNumber).not.toBeNull();
      const serialized = JSON.stringify(board);
      expect(serialized).not.toContain(NAMEONLY_IMAGES.GUARD_A);
      expect(serialized).not.toContain(NAMEONLY_IMAGES.GUARD_B);
      expect(serialized).not.toContain("Guard C A");
    });

    it("(b) show_unowned_cards=false keeps unowned rows out even when every item flag is on", async () => {
      const { listTradeOffers, listWantableCards } = await import("@/lib/trade");
      const board = await listTradeOffers({
        streamerId: S.MASTER_OFF,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.NOV,
      });
      expect(board.offers.map((offer) => offer.id)).not.toContain(OF.MASTER_OFF);
      expect(JSON.stringify(board)).not.toContain("Master Off");
      // 一覧フォームも未所持カードを出さない。V はこのチャネルのカードを
      // 1枚も所持していないので空になる（所持カードは show_unowned_cards に
      // 関係なく選べるため、NOV ではなく V で確認する）。
      await expect(listWantableCards(TW.V, S.MASTER_OFF)).resolves.toEqual([]);
    });

    it("(c) the offerer and the acceptor see the same #N, matching createCollectionNumberMap", async () => {
      const { listTradeOffers } = await import("@/lib/trade");
      const expected = await numberMapFor(S.NUMBER);
      expect(expected.get(C.NUMBER_A)).toBe(2);
      expect(expected.get(C.NUMBER_B)).toBe(3);

      const offerer = await listTradeOffers({
        streamerId: S.NUMBER,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.O,
      });
      const acceptor = await listTradeOffers({
        streamerId: S.NUMBER,
        scope: "in_channel",
        page: 1,
        twitchUserId: TW.V,
      });
      const fromOfferer = offerer.offers.find((offer) => offer.id === OF.NUMBER);
      const fromAcceptor = acceptor.offers.find((offer) => offer.id === OF.NUMBER);
      expect(fromOfferer?.offeredCard.collectionNumber).toBe(2);
      expect(fromOfferer?.wantedCard.collectionNumber).toBe(3);
      expect(fromAcceptor?.offeredCard.collectionNumber).toBe(2);
      expect(fromAcceptor?.wantedCard.collectionNumber).toBe(3);
      // 名前は所持している側だけ見える（未所持側は #N のみ）。snapshot の名前は
      // offer() が保存した "snap" で、番号は両者で同じ。
      expect(fromOfferer?.offeredCard.name).toBe("snap");
      expect(fromOfferer?.wantedCard.name).toBe("");
      expect(fromAcceptor?.offeredCard.name).toBe("");
      expect(fromAcceptor?.wantedCard.name).toBe("snap");
    });

    it("(d) an inactive card is part of the number table, and numbers do not depend on the viewer", async () => {
      const { listWantableCards, listMyTradeOffers } = await import("@/lib/trade");
      // NUMBER_OLD is inactive but card_number=1; it must still occupy #1.
      const cards = await listWantableCards(TW.V, S.NUMBER);
      expect(cards.map((card) => card.cardId)).toEqual([C.NUMBER_A, C.NUMBER_B]);
      expect(cards.map((card) => card.collectionNumber)).toEqual([2, 3]);
      expect(cards.map((card) => card.cardId)).not.toContain(C.NUMBER_OLD);

      // 閲覧者を変えても同じ番号（所持していない O でも 2/3）。
      const asOfferer = await listWantableCards(TW.O, S.NUMBER);
      expect(asOfferer.map((card) => card.collectionNumber)).toEqual([2, 3]);

      // /mine の応答でも同じ番号が付く（snapshot は保存時のまま）。
      // O の /mine は 20 件の bulk が新しいので、OF.NUMBER は 2 ページ目。
      const mine = await listMyTradeOffers(TW.O, { page: 2 });
      const row = mine.offers.find((offer) => offer.id === OF.NUMBER);
      expect(row?.offeredCard.collectionNumber).toBe(2);
      expect(row?.wantedCard.collectionNumber).toBe(3);
    });

    it("(e) listWantableCards is ordered by rarity_order → #N → id, never by name", async () => {
      const { listWantableCards } = await import("@/lib/trade");
      // 名前は「番号順と逆」: NUMBER_A="Zzz…"(#2), NUMBER_B="Aaa…"(#3)。
      // 名前順なら B → A になるが、期待は番号順の A → B。
      const cards = await listWantableCards(TW.V, S.NUMBER);
      expect(cards.map((card) => card.cardId)).toEqual([C.NUMBER_A, C.NUMBER_B]);
      expect(cards.map((card) => card.collectionNumber)).toEqual([2, 3]);
      // 名前非公開のカードが "" でも、順序に名前情報が混ざらない。
      expect(cards[0].name).toBe("");
    });

    it("(a)(h) an all-items-hidden offer trades by #N, and the given-away card keeps only #N", async () => {
      const { acceptTradeOffer, listMyTradeOffers } = await import("@/lib/trade");
      const expected = await numberMapFor(S.HIDDEN_ALL);

      const result = await acceptTradeOffer({
        twitchUserId: TW.NOV,
        tradeOfferId: OF.HIDDEN_ALL,
        requestId: id(520),
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // RPC 直後の所持: 受け取った A は名前・画像とも可視（所持 ≥ 1）、
      // 手放した B は名前 "" / 画像 null / #N のみ。
      expect(result.offeredCardSnapshot).toMatchObject({
        name: "Hidden All A",
        imageUrl: NAMEONLY_IMAGES.HIDDEN_A,
      });
      expect(result.wantedCardSnapshot).toEqual({
        name: "",
        rarity: "rare",
        imageUrl: null,
        collectionNumber: expected.get(C.HIDDEN_ALL_B),
      });

      const mine = await listMyTradeOffers(TW.NOV);
      const row = mine.offers.find((offer) => offer.id === OF.HIDDEN_ALL);
      expect(row?.status).toBe("completed");
      expect(row?.offeredCard).toMatchObject({
        name: "Hidden All A",
        imageUrl: NAMEONLY_IMAGES.HIDDEN_A,
      });
      expect(row?.wantedCard).toEqual({
        name: "",
        rarity: "rare",
        imageUrl: null,
        collectionNumber: expected.get(C.HIDDEN_ALL_B),
      });
    });
  });
  // ---------------------------------------------------------------------------
  // #2079: ハブのコレクション別一覧。専用の世界（ids 77xx、専用の配信者・
  // ユーザー）を beforeAll で作り、既存の PUB/PRIV の総数を変えない。
  // 後片付けはこのファイル共通の cleanup() が S/U の全 id を消す。
  // ---------------------------------------------------------------------------
  describe("collection lists (#2079)", () => {
    const K = {
      A: id(7701),
      B: id(7702),
      A2: id(7703),
      B2: id(7704),
      MANY: id(7705),
      MANY_WANT: id(7706),
      VIS: id(7707),
      NAMEONLY: id(7708),
      HIDDEN: id(7709),
    };
    const IMAGES = {
      VIS: "https://secret.example/col-vis.png",
      NAMEONLY: "https://secret.example/col-nameonly.png",
      HIDDEN: "https://secret.example/col-hidden.png",
    };
    const OFFERS = {
      CROSS_BOTH: id(7730),
      CROSS_ONE: id(7731),
      MANY: Array.from({ length: 6 }, (_, index) => id(7732 + index)),
      NAMEONLY: id(7738),
      HIDDEN: id(7739),
    };
    const COL_UC = {
      OFF_A: id(7710),
      OFF_A2: id(7711),
      OFF_MANY: Array.from({ length: 6 }, (_, index) => id(7712 + index)),
      OFF_VIS_1: id(7718),
      OFF_VIS_2: id(7719),
      V_A: id(7720),
      V_B: id(7721),
      V_A2: id(7722),
      V_MANY: id(7723),
      V_MANY_WANT: id(7724),
      V_VIS: id(7725),
    };

    beforeAll(async () => {
      const s = sql!;
      await s`INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        trade_enabled, cross_channel_trade_enabled, show_unowned_cards,
        show_unowned_card_details, show_unowned_card_name, show_unowned_card_image,
        show_unowned_card_description
      ) VALUES
        (${S.COL_A}, 'tv-col-a', 'tv-col-a', 'TV col a', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
        (${S.COL_B}, 'tv-col-b', 'tv-col-b', 'TV col b', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
        (${S.COL_A2}, 'tv-col-a2', 'tv-col-a2', 'TV col a2', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
        (${S.COL_B2}, 'tv-col-b2', 'tv-col-b2', 'TV col b2', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE),
        (${S.COL_MANY}, 'tv-col-many', 'tv-col-many', 'TV col many', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
        (${S.COL_VIS}, 'tv-col-vis', 'tv-col-vis', 'TV col vis', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
        (${S.COL_NAMEONLY}, 'tv-col-nameonly', 'tv-col-nameonly', 'TV col nameonly', TRUE, TRUE, TRUE, FALSE, TRUE, FALSE, FALSE),
        (${S.COL_HIDDEN}, 'tv-col-hidden', 'tv-col-hidden', 'TV col hidden', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE)`;
      await s`INSERT INTO users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
        (${U.COL_OFF}, ${TW.COL_OFF}, ${TW.COL_OFF}, 'Collection Offerer'),
        (${U.COL_V}, ${TW.COL_V}, ${TW.COL_V}, 'Collection Viewer')`;
      await s`INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active, image_url) VALUES
        (${K.A}, ${S.COL_A}, 'Col A', 'common', 0.1, TRUE, NULL),
        (${K.B}, ${S.COL_B}, 'Col B', 'common', 0.1, TRUE, NULL),
        (${K.A2}, ${S.COL_A2}, 'Col A2', 'common', 0.1, TRUE, NULL),
        (${K.B2}, ${S.COL_B2}, 'Col B2', 'common', 0.1, TRUE, NULL),
        (${K.MANY}, ${S.COL_MANY}, 'Col Many', 'common', 0.1, TRUE, NULL),
        (${K.MANY_WANT}, ${S.COL_MANY}, 'Col Many Wanted', 'common', 0.1, TRUE, NULL),
        (${K.VIS}, ${S.COL_VIS}, 'Col Vis', 'common', 0.1, TRUE, ${IMAGES.VIS}),
        (${K.NAMEONLY}, ${S.COL_NAMEONLY}, 'Col Wanted NameOnly', 'rare', 0.1, TRUE, ${IMAGES.NAMEONLY}),
        (${K.HIDDEN}, ${S.COL_HIDDEN}, 'Col Wanted Hidden', 'rare', 0.1, TRUE, ${IMAGES.HIDDEN})`;
      // The offerer owns the offered copies. The viewer owns one copy of each
      // card that makes a collection "collected" (CA, CB, CA2, MANY, VIS) and
      // the MANY wanted card, but nothing of CB2/NAMEONLY/HIDDEN.
      await s`INSERT INTO user_cards (id, user_id, card_id) VALUES
        (${COL_UC.OFF_A}, ${U.COL_OFF}, ${K.A}),
        (${COL_UC.OFF_A2}, ${U.COL_OFF}, ${K.A2}),
        (${COL_UC.OFF_MANY[0]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_MANY[1]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_MANY[2]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_MANY[3]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_MANY[4]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_MANY[5]}, ${U.COL_OFF}, ${K.MANY}),
        (${COL_UC.OFF_VIS_1}, ${U.COL_OFF}, ${K.VIS}),
        (${COL_UC.OFF_VIS_2}, ${U.COL_OFF}, ${K.VIS}),
        (${COL_UC.V_A}, ${U.COL_V}, ${K.A}),
        (${COL_UC.V_B}, ${U.COL_V}, ${K.B}),
        (${COL_UC.V_A2}, ${U.COL_V}, ${K.A2}),
        (${COL_UC.V_MANY}, ${U.COL_V}, ${K.MANY}),
        (${COL_UC.V_MANY_WANT}, ${U.COL_V}, ${K.MANY_WANT}),
        (${COL_UC.V_VIS}, ${U.COL_V}, ${K.VIS})`;

      const insertOffer = (
        offerId: string,
        userCardId: string,
        offeredCardId: string,
        offeredStreamerId: string,
        wantedCardId: string,
        wantedStreamerId: string,
        minutesAgo: number,
        offeredSnapshot: { name: string; rarity: string; imageUrl: string | null },
        wantedSnapshot: { name: string; rarity: string; imageUrl: string | null },
      ) => s`
        INSERT INTO trade_offers (
          id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
          wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot, created_at
        ) VALUES (
          ${offerId}, ${U.COL_OFF}, ${userCardId}, ${offeredCardId}, ${offeredStreamerId},
          ${wantedCardId}, ${wantedStreamerId},
          ${JSON.stringify(offeredSnapshot)}::jsonb, ${JSON.stringify(wantedSnapshot)}::jsonb,
          now() - make_interval(secs => ${minutesAgo * 60})
        )`;
      const snapshot = (name: string, imageUrl: string | null = null) =>
        ({ name, rarity: "common", imageUrl });

      // Case 1: cross offer where the viewer owns BOTH collections.
      await insertOffer(
        OFFERS.CROSS_BOTH, COL_UC.OFF_A, K.A, S.COL_A, K.B, S.COL_B, 10,
        snapshot("Col A"), snapshot("Col B"),
      );
      // Case 2: cross offer where the viewer owns only the offered side. CB2
      // is public so the wanted side is still visible, but the viewer owns no
      // CB2 card, so the offer must not be placed under it.
      await insertOffer(
        OFFERS.CROSS_ONE, COL_UC.OFF_A2, K.A2, S.COL_A2, K.B2, S.COL_B2, 9,
        snapshot("Col A2"), snapshot("Col B2"),
      );
      // Case 3/4: six in-channel offers, newest first. Six is one more than
      // the preview size, so rn <= 5 and the expanded page are both exercised.
      for (let i = 0; i < 6; i += 1) {
        await insertOffer(
          OFFERS.MANY[i], COL_UC.OFF_MANY[i], K.MANY, S.COL_MANY, K.MANY_WANT, S.COL_MANY,
          1 + i, snapshot("Col Many"), snapshot("Col Many Wanted"),
        );
      }
      // Case 5: the wanted card's names/images follow the WANTED streamer.
      // NAMEONLY names are public but its images are not; HIDDEN reveals
      // neither, so the whole offer disappears (the offered side is owned by
      // the viewer and would otherwise be visible).
      await insertOffer(
        OFFERS.NAMEONLY, COL_UC.OFF_VIS_1, K.VIS, S.COL_VIS, K.NAMEONLY, S.COL_NAMEONLY, 2,
        snapshot("Col Vis", IMAGES.VIS),
        { name: "Col Wanted NameOnly", rarity: "rare", imageUrl: IMAGES.NAMEONLY },
      );
      await insertOffer(
        OFFERS.HIDDEN, COL_UC.OFF_VIS_2, K.VIS, S.COL_VIS, K.HIDDEN, S.COL_HIDDEN, 1,
        snapshot("Col Vis", IMAGES.VIS),
        { name: "Col Wanted Hidden", rarity: "rare", imageUrl: IMAGES.HIDDEN },
      );
    });

    it("places a cross offer under both owned collections and counts it once in each total", async () => {
      const { listTradeOffersByCollection } = await import("@/lib/trade");
      const groups = await listTradeOffersByCollection({ twitchUserId: TW.COL_V });
      const byId = new Map(groups.map((group) => [group.streamer.id, group]));

      for (const streamerId of [S.COL_A, S.COL_B]) {
        expect(byId.get(streamerId)?.offers.map((offer) => offer.id))
          .toEqual([OFFERS.CROSS_BOTH]);
        // One row per placement; the union must not duplicate the offer
        // inside the same collection either.
        expect(byId.get(streamerId)?.total).toBe(1);
      }
    });

    it("places a cross offer only under the one collection the viewer owns", async () => {
      const { listTradeOffersByCollection } = await import("@/lib/trade");
      const groups = await listTradeOffersByCollection({ twitchUserId: TW.COL_V });
      const byId = new Map(groups.map((group) => [group.streamer.id, group]));

      expect(byId.get(S.COL_A2)?.offers.map((offer) => offer.id)).toEqual([OFFERS.CROSS_ONE]);
      expect(byId.get(S.COL_A2)?.total).toBe(1);
      // The viewer owns no COL_B2 card, so that collection must not appear
      // even though the wanted card is public.
      expect(byId.has(S.COL_B2)).toBe(false);
      expect(groups.flatMap((group) => group.offers).filter((offer) => offer.id === OFFERS.CROSS_ONE))
        .toHaveLength(1);
    });

    it("returns the first 5 of 6 offers with the full total, and the expanded page includes the 6th", async () => {
      const { listTradeOffersByCollection } = await import("@/lib/trade");
      const { listTradeCollectionPage } = await import("@/lib/trade-collections");
      const groups = await listTradeOffersByCollection({ twitchUserId: TW.COL_V });
      const group = groups.find((item) => item.streamer.id === S.COL_MANY);

      expect(group?.total).toBe(6);
      expect(group?.offers.map((offer) => offer.id)).toEqual(OFFERS.MANY.slice(0, 5));

      // The expand API uses the same function with a single streamer and
      // TRADE_PAGE_SIZE rows, so the 6th row (the oldest) is included.
      const expanded = await listTradeOffersByCollection({
        twitchUserId: TW.COL_V,
        streamerId: S.COL_MANY,
        page: 1,
      });
      expect(expanded).toHaveLength(1);
      expect(expanded[0].total).toBe(6);
      expect(expanded[0].offers.map((offer) => offer.id)).toEqual(OFFERS.MANY);

      const page = await listTradeCollectionPage({
        twitchUserId: TW.COL_V,
        streamerId: S.COL_MANY,
        kind: "offer",
        sort: "newest",
        page: 1,
      });
      expect(page).toMatchObject({
        kind: "offer",
        streamer: { id: S.COL_MANY },
        total: 6,
        page: 1,
        pageSize: 20,
        hasMore: false,
      });
      expect(page?.kind === "offer" ? page.offers.map((offer) => offer.id) : []).toEqual(OFFERS.MANY);
    });

    it("returns latestCreatedAt as a string that Date.parse accepts", async () => {
      const { listTradeOffersByCollection } = await import("@/lib/trade");
      const groups = await listTradeOffersByCollection({ twitchUserId: TW.COL_V });
      const latest = groups.find((group) => group.streamer.id === S.COL_MANY)?.latestCreatedAt;

      // Raw MAX(timestamptz) bypasses Drizzle's column decoder: this handle's
      // transparent parser returns the PG text string, while other driver
      // setups can return Date. The service normalizes both to an ISO string.
      expect(typeof latest).toBe("string");
      expect(Number.isNaN(Date.parse(latest!))).toBe(false);
      // ISO 8601 (UTC): environment-independent for Date.parse / new Date.
      expect(latest).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("masks the wanted card by the wanted streamer's settings (name and image)", async () => {
      const { listTradeOffersByCollection } = await import("@/lib/trade");
      const groups = await listTradeOffersByCollection({ twitchUserId: TW.COL_V });
      const byId = new Map(groups.map((group) => [group.streamer.id, group]));

      const nameOnly = byId.get(S.COL_VIS)?.offers.find((offer) => offer.id === OFFERS.NAMEONLY);
      expect(nameOnly?.offeredCard.imageUrl).toBe(IMAGES.VIS); // viewer owns the offered card
      expect(nameOnly?.wantedCard).toMatchObject({
        name: "Col Wanted NameOnly",
        rarity: "rare",
        imageUrl: null, // names public, images hidden (COL_NAMEONLY)
      });
      expect(byId.get(S.COL_VIS)?.total).toBe(1);

      // COL_HIDDEN reveals neither names nor images. The offered side is owned
      // by the viewer, so only the wanted-side settings can hide the row.
      expect(groups.flatMap((group) => group.offers).map((offer) => offer.id))
        .not.toContain(OFFERS.HIDDEN);
      const serialized = JSON.stringify(groups);
      expect(serialized).not.toContain("Col Wanted Hidden");
      expect(serialized).not.toContain(IMAGES.NAMEONLY);
      expect(serialized).not.toContain(IMAGES.HIDDEN);
    });
  });

});
