import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  ne,
  or,
  getTableColumns,
  getTableName,
  inArray,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import {
  cards as cardsTable,
  cardTradeSettings as cardTradeSettingsTable,
  streamers as streamersTable,
  tradeOffers as tradeOffersTable,
  tradeWantedAllowlistItems as tradeWantedAllowlistItemsTable,
  tradeWantedAllowlistRules as tradeWantedAllowlistRulesTable,
  userCards as userCardsTable,
  users as usersTable,
} from "@/lib/db/schema";
import {
  getErrorChain,
  getSqlState,
  isPgMissingNamedColumnError,
  isPgUniqueViolationError,
} from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import { collectedStreamerIdsSubquery } from "@/lib/collected-streamers";
import {
  isMissingTradeSettingsColumnError,
  isMissingUnownedCardItemColumnError,
  withLiveDirectorySettingsColumnFallback,
} from "@/lib/db/streamers-safe-columns";
import { createCollectionNumberMap } from "@/lib/collection-utils";
import {
  resolveUnownedCardVisibility,
  unownedCardItemVisibleSql,
  type UnownedCardVisibilityColumns,
} from "@/lib/unowned-card-visibility";
import { logger } from "@/lib/logger.server";
import { isCanonicalUuid } from "@/lib/uuid-validation";

export const TRADE_PAGE_SIZE = 20;
/**
 * ハブの各コレクションで最初に出す件数 (#2079)。
 *
 * 一覧は所持する全コレクションを1クエリで読み、配置先ごとに
 * ROW_NUMBER() を付けて SQL の外側 WHERE で先頭 N 件に絞る。TS 側で
 * slice しないのは、total（COUNT OVER）と先頭 N 件が必ず同じ集合から
 * 出るようにするため。展開ボタンはこの値ではなく total と表示件数の差で
 * 決まる（展開後は TRADE_PAGE_SIZE 件ずつ返す）。
 */
export const TRADE_COLLECTION_PREVIEW_SIZE = 5;
export const TRADE_MAX_OPEN_OFFERS = 10;
/**
 * Upper bound of trade_offers.wanted_quantity (#1789). Must match the
 * trade_offers_wanted_quantity_range CHECK of 20261011120000. Small on
 * purpose: an offer asks the acceptor to give up to this many copies at once,
 * and the RPC locks that many rows.
 */
export const TRADE_MAX_WANTED_QUANTITY = 10;

export type TradeScope = "in_channel" | "cross_channel";

/**
 * ハブのコレクション別一覧の並び順 (#2079)。
 *
 * - newest: 新着順（出品・オークションとも created_at DESC）
 * - ending_soon: 締切が近い順。オークションだけに効き、トレードは新着順のまま。
 *   入札中を先に並べ、選択待ちはその後ろ（直近に終了した順）に置く。
 *
 * レアリティ順は意図的に用意しない。カスタムレアリティ (#2029) には全配信者で
 * 共通の順序が無く、画面ごとに「レアリティ順」の意味が変わってしまうため。
 */
export type TradeCollectionSort = "newest" | "ending_soon";
export const DEFAULT_TRADE_COLLECTION_SORT: TradeCollectionSort = "newest";

const TRADE_COLLECTION_SORTS: readonly TradeCollectionSort[] = ["newest", "ending_soon"];

/**
 * URL クエリ `?sort=` を許可リストで正規化する。不明な値・空・配列は
 * 既定の newest へ黙って落とす（利用者が自由に書き換えられる値であり、
 * エラーページにする理由がない。値を SQL の ORDER BY へ直接埋めない）。
 */
export function parseTradeCollectionSort(
  value: string | string[] | undefined,
): TradeCollectionSort {
  return typeof value === "string"
    && (TRADE_COLLECTION_SORTS as readonly string[]).includes(value)
    ? (value as TradeCollectionSort)
    : DEFAULT_TRADE_COLLECTION_SORT;
}

/** 展開 API が受け付ける一覧の種類 (#2079)。 */
export type TradeCollectionKind = "offer" | "auction";
/**
 *   yes        — the viewer can pay wanted_quantity unlisted copies
 *   not_owned  — the viewer owns no copy of the wanted card
 *   not_enough — the viewer owns some copies, but fewer than wanted_quantity
 *   all_listed — enough copies are owned, but too many of them are locked
 *                (listed in an open offer, an auction listing or an active
 *                bid; #1791, see trade_copy_locked)
 */
export type TradeCanAccept = "yes" | "not_owned" | "not_enough" | "all_listed";
export type TradeOfferStatus = "open" | "completed" | "cancelled";

export type TradeServiceErrorCode =
  | "TRADE_DISABLED"
  | "TRADE_OFFER_NOT_FOUND"
  | "TRADE_OFFER_NOT_OPEN"
  | "TRADE_CARD_NOT_OWNED"
  | "TRADE_CARD_ALREADY_LISTED"
  | "TRADE_OFFER_LIMIT"
  // #2079: the viewer does not own the collection addressed by the
  // per-collection page endpoint. Hidden and missing are indistinguishable
  // (404), like the other trade reads.
  | "TRADE_COLLECTION_NOT_FOUND"
  | "TRADE_SAME_CARD"
  | "TRADE_WANTED_CARD_UNAVAILABLE"
  // #1790: the wanted card is visible and active, but its streamer turned
  // off "can be requested in trades" (cards.trade_wantable = false).
  | "TRADE_WANTED_CARD_NOT_WANTABLE"
  // The offered card's streamer restricted what its cards can be traded for
  // (the streamer's exchange-target list) and the wanted card is not in it.
  | "TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED"
  // The copy the offerer wants to give belongs to a card definition that is
  // no longer active (including pack completion reward cards, which are kept
  // inactive by design). Inactive cards cannot enter the trade market.
  | "TRADE_OFFERED_CARD_INACTIVE";

// -----------------------------------------------------------------------------
// Card visibility rules (product decision for #715/#726/#727, refined by #2070
// and the follow-up item-level visibility work)
//
// Visibility has TWO levels. They must not be conflated: a channel can reveal
// the NAME (or the IMAGE) of its unowned cards independently, so a single
// row-level EXISTS cannot express that.
//
// Row level (does the row exist for the viewer at all, i.e. may they see it in
// the board and trade for it?) — cardVisibleTo():
//
//   visible(card, viewer) ⇔ card.is_active
//     AND ( viewer owns ≥1 copy of card.id (listed copies included)
//           OR card's streamer.show_unowned_cards )
//
//   The master switch alone decides whether unowned cards exist for a viewer.
//   Whether their NAME/IMAGE may be shown is a separate, item-level question
//   (see below). A row with every item hidden is still tradeable: the viewer
//   picks it by the collection number (#N) the DTO carries. show_unowned_cards
//   = false keeps the pre-existing behaviour: unowned cards are not tradeable
//   at all (no row), exactly like the collection page hides them entirely.
//
// Name level (may the viewer receive name?) and image level (may the viewer
// receive imageUrl?) — cardNameVisibleTo() / cardImageVisibleTo():
//
//   nameVisible(card, viewer) ⇔ viewer owns ≥1 copy
//     OR resolve(card's streamer).name
//
//   imageVisible(card, viewer) ⇔ viewer owns ≥1 copy
//     OR resolve(card's streamer).image
//
//   `resolve` is the same rule as src/lib/unowned-card-visibility.ts
//   (resolveUnownedCardVisibility, rules a-d), rendered as SQL by
//   unownedCardItemVisibleSql() so the RSC collection page and the trade API
//   cannot disagree. Neither item rule requires is_active: the row has already
//   passed the row-level rule, and a card that was deactivated after the
//   snapshot was taken still follows the same ownership/reveal rule. Neither
//   rule reads the retired trade-only name setting
//   (streamers.trade_unowned_card_names_visible, #2070): it is no longer
//   referenced by the code (the DB column stays for the migration history and
//   production had no users of it).
//
// The old "show_unowned_card_details OR trade_unowned_card_names_visible"
// name-level branch is gone. Names are now masked per row at read time
// (maskTradeCards), so the board can show a #N-only row instead of hiding the
// card entirely.
//
// Anonymous viewers own nothing. Each card is evaluated against ITS OWN
// streamer's settings, which is what makes cross-channel offers safe.
//
// These fragments use literal aliases for the inner tables and reference the
// outer row ONLY through qualifiedColumn(). The ownership probe is
// `(user_id, card_id)` equality, which is served by idx_user_cards_user_card.
// -----------------------------------------------------------------------------

/**
 * Always render `"table"."column"` for a correlated outer reference.
 *
 * Drizzle renders `${table.column}` as a bare `"column"` only for top-level
 * columns in the SELECT list of a single-table statement without joins;
 * WHERE and other clauses keep the table qualification. Inside a correlated
 * subquery in the SELECT list (or in a JOIN .. ON clause) a
 * bare name binds to the INNER table first if it has a column of that name:
 * e.g. `active_listing.offered_user_card_id = "id"` silently compared two
 * columns of the same inner row (active_listing.id) instead of user_cards.id
 * (verified on real PostgreSQL by tests/integration/trade-visibility-pg.test.ts,
 * which is how the pre-existing canAccept "all_listed" bug was found), and
 * `visible_card.id = "id"` fails with 42702 (ambiguous). Qualifying with the
 * outer table name is unambiguous because every inner table is aliased.
 *
 * Precondition: the referenced table name is unique in the outer FROM list.
 * For a column of an alias() table getTableName returns the alias, so
 * `wanted_card.id` etc. are rendered correctly; an unaliased table must
 * appear only once (every other occurrence of it is aliased).
 */
export function qualifiedColumn(column: AnyColumn) {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

// -----------------------------------------------------------------------------
// Round-trip budget (2026-10 performance work)
//
// Every DB round trip from the Worker goes through Hyperdrive to PlanetScale
// and was measured at a few hundred ms on preview, while the CPU time of the
// trade APIs was only 15–60 ms. Latency is therefore dominated by the NUMBER
// of sequential statements, not by query cost. The service functions below
// are written so that each one issues a fixed, small number of statements
// (pinned by tests/unit/trade-service.test.ts):
//
//   * The viewer's users.id is resolved INSIDE the statement that needs it
//     (viewerUserIdOf: an uncorrelated scalar subquery; PostgreSQL runs each
//     occurrence once per statement as an InitPlan, a unique-index lookup on
//     users_twitch_user_id_key) instead of a separate users round trip.
//   * Display metadata (streamers / participants) is LEFT JOINed onto the page
//     query instead of being fetched by follow-up queries.
//   * Validation reads are combined into one row-returning statement and the
//     business rules are still evaluated in TypeScript in the original order,
//     so error precedence (and what each error reveals) is unchanged.
//
// The item-level visibility work adds TWO deliberate extra round trips to
// every read that returns card snapshots: maskTradeCards() has to ask the
// database (1) which of the page's card ids the viewer may see the NAME/IMAGE
// of, because "owned now" cannot be derived from the snapshot, and (2) the
// encyclopedia number table of the involved streamers, because the #N shown to
// the offerer and to the acceptor must be identical and must match the
// collection page (the number table is built from ALL cards of a streamer,
// including inactive ones, i.e. it is viewer-independent by design).
//
// Both statements are per page/function (one each, never one per row), are
// skipped entirely when no snapshot has a card id, and never drop rows (they
// only mask name/imageUrl and add collectionNumber), so pagination / hasMore
// stay untouched. The budget per function is pinned by
// tests/unit/trade-service.test.ts and tests/unit/trade-auction-service.test.ts.
//
// An unknown twitch_user_id makes the subquery NULL. Every comparison against
// NULL is not TRUE, which reproduces the previous "user not found" branches
// (anonymous visibility, empty result, not-found errors) without a branch.
// -----------------------------------------------------------------------------

/**
 * users.id of `twitchUserId` as a scalar subquery (NULL when unknown). The
 * literal alias keeps it independent of any outer `users` reference.
 */
export function viewerUserIdOf(twitchUserId: string): SQL {
  return sql`(
    SELECT viewer.id
    FROM ${usersTable} AS viewer
    WHERE viewer.twitch_user_id = ${twitchUserId}
  )`;
}

/**
 * `MAX(timestamptz)` / `created_at` を DTO の ISO 8601（UTC）文字列にそろえる
 * (#2079)。
 *
 * Drizzle の生 SQL (`sql<...>`) は列の mapFromDriverValue を通らないため、
 * 実行環境のドライバ設定によって timestamptz が Date でも文字列でも返る
 * （本番の postgres.js は installIsoTimestampParsers で ISO 文字列を返すが、
 * Drizzle の透過パーサだけを通るテストや素の postgres.js では Date、PG の
 * テキスト形式の文字列になることもある）。UI 側は
 * `Date.parse(latestCreatedAt)` でコレクションを並べるので、ここで ISO に
 * 正規化し、パース結果を環境に依存させない。パースできない値だけは
 * データ破損時に画面を壊さないよう元の文字列のまま返す。
 */
export function toIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

// -----------------------------------------------------------------------------
// Deploy window of cards.trade_wantable (#1790)
//
// planetscale-migrate and the app deploy run independently (issue #788), so
// the new app can briefly run against a database without 20261014100000.
// (The same-shaped wanted_quantity window (#1789) was measured on production
// and preview and its fallback removed in #1792, like the #954 cleanup.) The
// column lives in the narrow
// cardTradeSettings definition (src/lib/db/schema.ts explains why it is not
// part of `cards`), so only the trade statements below reference it, and
// only through explicit fragments. On 42703 for that column they are retried
// with every card treated as wantable. That is exact, not an approximation:
// before the migration no card can be non-wantable (the column default is
// true and the old schema has no way to store anything else). Becomes a dead
// branch once 20261014100000 is applied everywhere.
// -----------------------------------------------------------------------------

/**
 * Every trade_offers column of `table` (the table or one of its aliases),
 * with wanted_quantity as a Number mapped integer column.
 */
function offerRowFields(table: typeof tradeOffersTable | typeof createReplayOffer) {
  const { wanted_quantity: wantedQuantity, ...columns } = getTableColumns(table);
  return {
    ...columns,
    wanted_quantity: sql<number>`${qualifiedColumn(wantedQuantity)}`.mapWith(Number),
  };
}

const TRADE_WANTABLE_COLUMNS = ["trade_wantable"] as const;

export async function withTradeWantableColumnFallback<T>(
  attempt: (withoutWantable: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isPgMissingNamedColumnError(error, TRADE_WANTABLE_COLUMNS)) throw error;
    return attempt(true);
  }
}

// -----------------------------------------------------------------------------
// Deploy window of the item-level unowned-card visibility (#2070 follow-up)
//
// Same independent-deploy problem as cards.trade_wantable above (#788): the
// new app can briefly run against a database without 20261122120000, the
// migration that adds streamers.show_unowned_card_name / _image /
// _description. Those three columns are referenced only by
// unownedCardItemVisibleSql() (name/image masks and listWantableCards). On
// 42703 for any of them the readers are retried with the legacy rule
// `show_unowned_cards AND show_unowned_card_details`, which is exactly what
// src/lib/unowned-card-visibility.ts rule b does in TypeScript: before the
// migration no streamer can have item-level settings (the columns default to
// false and the old schema cannot store anything else), so the legacy
// "details" switch is the best available meaning of the row.
//
// This is now the ONE fallback for the three item columns. The old
// withTradeUnownedCardNamesColumnFallback (streamers.trade_unowned_card_names_
// visible, #2070) is gone together with the setting itself; that column is not
// referenced by the code any more. Becomes a dead branch once 20261122120000
// is applied everywhere.
// -----------------------------------------------------------------------------

export async function withUnownedCardItemColumnFallback<T>(
  attempt: (withoutItemColumns: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isMissingUnownedCardItemColumnError(error)) throw error;
    return attempt(true);
  }
}

/**
 * streamers の列一式を、unownedCardItemVisibleSql() が期待する形へ写す。
 * 呼び出し側の別名（visible_streamer など）をそのまま渡せるようにするための
 * 小さなアダプタで、列の意味は変えない。
 */
function unownedVisibilityColumns(streamer: {
  show_unowned_cards: AnyColumn;
  show_unowned_card_details: AnyColumn;
  show_unowned_card_name: AnyColumn;
  show_unowned_card_image: AnyColumn;
  show_unowned_card_description: AnyColumn;
}): UnownedCardVisibilityColumns {
  return {
    show_unowned_cards: streamer.show_unowned_cards,
    show_unowned_card_details: streamer.show_unowned_card_details,
    show_unowned_card_name: streamer.show_unowned_card_name,
    show_unowned_card_image: streamer.show_unowned_card_image,
    show_unowned_card_description: streamer.show_unowned_card_description,
  };
}

/**
 * `cardIdExpr` points at a card definition that may be requested in trades
 * (cards.trade_wantable = TRUE, #1790). A NULL id is false, like
 * cardIsActive; every caller also requires cardIsActive, so a deleted card is
 * excluded either way. `withoutWantable` (deploy window) renders TRUE.
 */
export function cardIsWantable(cardIdExpr: AnyColumn, withoutWantable: boolean) {
  if (withoutWantable) return sql<boolean>`TRUE`;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardTradeSettingsTable} AS wantable_card
    WHERE wantable_card.id = ${qualifiedColumn(cardIdExpr)}
      AND wantable_card.trade_wantable = TRUE
  )`;
}

/**
 * The wanted card may be requested against the offered card under the
 * exchange-target restriction (allowlist) of the offered card's streamer:
 *
 *   restricted(offered) ⇔ the offered card's streamer has a rule
 *   allowed(offered, wanted) ⇔ not restricted
 *                              OR the wanted card is in that streamer's rule
 *
 * The rule is keyed by the STREAMER of the offered card (an auction's listed
 * card for bids), resolved through cards.streamer_id, because a streamer has a
 * single list that applies to every one of their cards. A rule with an empty
 * allowed set allows nothing (the rule row itself is the restriction), so
 * deleting every allowed card never lifts it. ANDs with cardIsWantable. Like
 * cardIsWantable it is advisory in the app queries and authoritative in
 * createTradeOffer and the accept / bid RPCs (20261124000000). No deploy-window
 * fallback: migrations are applied before the app deploys (docs/QA.md
 * "migrationとアプリの適用順序").
 *
 * A missing offered card row (NULL id after a card deletion) makes the
 * "restricted" test false, so the pair passes here. Every caller also requires
 * cardIsActive(offered) / an existing card, and accept_trade_offer rejects a
 * NULL offered_card_id with OFFER_INVALID before this check, so this cannot let
 * a deleted card through (the same shape as the RPC).
 */
export function wantedAllowedForOffered(
  offeredCardIdExpr: AnyColumn,
  wantedCardIdExpr: AnyColumn,
) {
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1
      FROM ${cardsTable} AS restriction_offered_card
      JOIN ${tradeWantedAllowlistRulesTable} AS restriction_rule
        ON restriction_rule.streamer_id = restriction_offered_card.streamer_id
      WHERE restriction_offered_card.id = ${qualifiedColumn(offeredCardIdExpr)}
    )
    OR EXISTS (
      SELECT 1
      FROM ${cardsTable} AS restriction_offered_card
      JOIN ${tradeWantedAllowlistItemsTable} AS restriction_item
        ON restriction_item.streamer_id = restriction_offered_card.streamer_id
      WHERE restriction_offered_card.id = ${qualifiedColumn(offeredCardIdExpr)}
        AND restriction_item.wanted_card_id = ${qualifiedColumn(wantedCardIdExpr)}
    )
  )`;
}

/** `cardIdExpr` points at an active card definition (NULL id → false). */
export function cardIsActive(cardIdExpr: AnyColumn) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS active_card
    WHERE active_card.id = ${qualifiedColumn(cardIdExpr)}
      AND active_card.is_active = TRUE
  )`;
}

// -----------------------------------------------------------------------------
// Copy locks and the deploy window of the auction schema (#1791)
//
// A copy (user_cards row) is "locked" while it is used by an open regular
// offer, an auction listing, or an active bid; a locked copy cannot be listed,
// bid, or used to pay for an accept. The authoritative rule is the SQL
// function public.trade_copy_locked() of 20261018030000_trade_auctions.sql,
// which every RPC and the trade_offers BEFORE INSERT trigger evaluate under a
// FOR UPDATE lock of the copy. The app-side reads below call the SAME function
// so that the listing form, canAccept and the create precheck can never
// disagree with the database about which copies are free.
//
// Deploy window: the new app can run before the migration (planetscale-migrate
// and the app deploy are independent, issue #788). Then the function/tables do
// not exist (42883 / 42P01) and these reads are retried with the pre-auction
// rule "locked = listed in an open offer". That is exact, not an
// approximation: without the tables no auction or bid can exist. The
// detection is narrow (SQLSTATE AND an auction object name in the same error
// layer, like isPgMissingNamedColumnError), so an unrelated missing relation
// or function still surfaces as a 500. Becomes a dead branch once
// 20261018030000 is applied everywhere.
// -----------------------------------------------------------------------------

/** Object names introduced by 20261018030000 (substring match). */
const TRADE_AUCTION_SCHEMA_OBJECTS = [
  "trade_auction", // trade_auctions, trade_auction_bids, *_trade_auction_* RPCs, ...
  "trade_copy_locked",
  "trade_copy_auction_locked",
] as const;

/**
 * 42P01 (missing table) or 42883 (missing function) about one of the auction
 * objects. Code and name must be on the SAME layer of the cause chain: the
 * top-level DrizzleQueryError message contains the whole SQL text, so it would
 * mention the names for any error.
 */
export function isTradeAuctionSchemaMissingError(error: unknown): boolean {
  return getErrorChain(error).some((layer) => {
    if (!layer || typeof layer !== "object") return false;
    const candidate = layer as { code?: unknown; message?: unknown };
    if (candidate.code !== "42P01" && candidate.code !== "42883") return false;
    const message = typeof candidate.message === "string" ? candidate.message : "";
    return TRADE_AUCTION_SCHEMA_OBJECTS.some((name) => message.includes(name));
  });
}

async function withTradeAuctionSchemaFallback<T>(
  attempt: (withoutAuctions: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isTradeAuctionSchemaMissingError(error)) throw error;
    return attempt(true);
  }
}

/**
 * `userCardIdExpr` (an SQL expression producing user_cards.id) is locked.
 * `withoutAuctions` (deploy window) renders the pre-auction rule, which is the
 * partial unique index predicate of idx_trade_offers_open_user_card
 * (regardless of the offerer).
 */
function copyLockedExpr(userCardIdExpr: SQL, withoutAuctions: boolean) {
  if (withoutAuctions) {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM ${tradeOffersTable} AS open_listing
      WHERE open_listing.offered_user_card_id = ${userCardIdExpr}
        AND open_listing.status = 'open'
    )`;
  }
  return sql<boolean>`public.trade_copy_locked(${userCardIdExpr})`;
}

/**
 * Number of open listings of `sellerUserIdExpr` counted against
 * TRADE_MAX_OPEN_OFFERS: open regular offers plus auctions that still hold
 * their card (bidding / selecting). Regular and auction listings share the
 * limit (#1791 spec). Same counting as create_trade_auction. count(*) is
 * bigint → string in postgres.js, hence mapWith(Number).
 */
function openListingCountExpr(sellerUserIdExpr: SQL, withoutAuctions: boolean) {
  const offers = sql`(
    SELECT count(*)
    FROM ${tradeOffersTable} AS open_offer
    WHERE open_offer.offerer_user_id = ${sellerUserIdExpr}
      AND open_offer.status = 'open'
  )`;
  if (withoutAuctions) return sql<number>`${offers}`.mapWith(Number);
  return sql<number>`(${offers} + (
    SELECT count(*)
    FROM public.trade_auctions AS open_auction
    WHERE open_auction.seller_user_id = ${sellerUserIdExpr}
      AND open_auction.status = 'open'
      AND public.trade_auction_holds_cards(open_auction.id)
  ))`.mapWith(Number);
}

/**
 * The trade_offers BEFORE INSERT trigger of 20261018030000 rejected the
 * INSERT (RAISE ... USING ERRCODE 'P0001', MESSAGE = `message`).
 */
function isTradeOfferTriggerError(
  error: unknown,
  message: "TRADE_CARD_LOCKED" | "TRADE_CARD_NOT_OWNED",
): boolean {
  return getErrorChain(error).some((layer) => {
    if (!layer || typeof layer !== "object") return false;
    const candidate = layer as { code?: unknown; message?: unknown };
    return candidate.code === "P0001" && candidate.message === message;
  });
}

/**
 * `cardIdExpr`'s ROW is visible to `viewerUserId` (see the rule documented at
 * the top of this file), including the is_active condition. `viewerUserId` is
 * an SQL expression producing users.id (viewerUserIdOf() or an outer column);
 * null means anonymous.
 *
 * The rule is now `owned >= 1 OR show_unowned_cards` (master switch only).
 * Whether the viewer may see the NAME or IMAGE of an unowned row is decided
 * separately by cardNameVisibleTo / cardImageVisibleTo and applied as a
 * read-time mask; a row with every item hidden is still tradeable (the viewer
 * picks it by #N).
 *
 * C3b: 旧第3引数 withoutNameOnly は撤去した。C3a ではオークション側の
 * 呼び出しを一度に変えないための互換引数として残し `void` で握り潰していたが、
 * 行ルールが streamers の項目列を一切読まなくなった以上、引数は意味を持たない。
 * デプロイ窓の面倒は maskTradeCards() 側の withUnownedCardItemColumnFallback
 * が単独で見る（この関数には 42703 を再試行する材料がない）。
 */
export function cardVisibleTo(
  cardIdExpr: AnyColumn,
  viewerUserId: SQL | null,
) {
  // Anonymous viewers have no ownership branch at all instead of comparing
  // against NULL, so the intent is explicit in the generated SQL.
  const ownedByViewer = viewerUserId
    ? sql`EXISTS (
        SELECT 1
        FROM ${userCardsTable} AS visible_owned
        WHERE visible_owned.user_id = ${viewerUserId}
          AND visible_owned.card_id = visible_card.id
      )`
    : sql`FALSE`;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS visible_card
    INNER JOIN ${streamersTable} AS visible_streamer
      ON visible_streamer.id = visible_card.streamer_id
    WHERE visible_card.id = ${qualifiedColumn(cardIdExpr)}
      AND visible_card.is_active = TRUE
      AND (
        visible_streamer.show_unowned_cards = TRUE
        OR ${ownedByViewer}
      )
  )`;
}

/**
 * `cardIdExpr`'s NAME is visible to `viewerUserId` (see the rule at the top of
 * this file): the viewer owns a copy, OR the card's streamer reveals the NAME
 * of unowned cards (resolveUnownedCardVisibility rule a-d, rendered by
 * unownedCardItemVisibleSql). It intentionally does NOT include is_active
 * (row-level visibility already decided that) and does not read the retired
 * trade-only name setting.
 *
 * Inner aliases are literal and distinct from the other fragments so this one
 * can appear next to cardVisibleTo / cardImageVisibleTo in the same statement.
 */
export function cardNameVisibleTo(
  cardIdExpr: AnyColumn,
  viewerUserId: SQL | null,
  withoutItemColumns = false,
) {
  // 相関サブクエリの別名は drizzle の alias() で作る。SQL 文本体の
  // `AS name_streamer` と、unownedCardItemVisibleSql() に渡す列オブジェクトを
  // 同じ別名に揃えるため、片方だけを手書きしない。
  const nameStreamer = alias(streamersTable, "name_streamer");
  const ownedByViewer = viewerUserId
    ? sql`EXISTS (
        SELECT 1
        FROM ${userCardsTable} AS name_owned
        WHERE name_owned.user_id = ${viewerUserId}
          AND name_owned.card_id = name_card.id
      )`
    : sql`FALSE`;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS name_card
    INNER JOIN ${streamersTable} AS name_streamer
      ON name_streamer.id = name_card.streamer_id
    WHERE name_card.id = ${qualifiedColumn(cardIdExpr)}
      AND (
        ${unownedCardItemVisibleSql(
          unownedVisibilityColumns(nameStreamer),
          "name",
          { withoutItemColumns },
        )}
        OR ${ownedByViewer}
      )
  )`;
}

/**
 * `cardIdExpr`'s IMAGE is visible to `viewerUserId`: the viewer owns a copy,
 * OR the card's streamer reveals the IMAGE of unowned cards
 * (resolveUnownedCardVisibility rule a-d). It intentionally does NOT include
 * is_active (row-level visibility already decided that) and never consults the
 * NAME setting: name-only and image-only channels are both representable.
 *
 * `withoutItemColumns` is the deploy-window flag of
 * withUnownedCardItemColumnFallback (new 3 columns missing → legacy details
 * rule), mirroring rule b of the TypeScript resolver.
 */
export function cardImageVisibleTo(
  cardIdExpr: AnyColumn,
  viewerUserId: SQL | null,
  withoutItemColumns = false,
) {
  const imageStreamer = alias(streamersTable, "image_streamer");
  const ownedByViewer = viewerUserId
    ? sql`EXISTS (
        SELECT 1
        FROM ${userCardsTable} AS image_owned
        WHERE image_owned.user_id = ${viewerUserId}
          AND image_owned.card_id = image_card.id
      )`
    : sql`FALSE`;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS image_card
    INNER JOIN ${streamersTable} AS image_streamer
      ON image_streamer.id = image_card.streamer_id
    WHERE image_card.id = ${qualifiedColumn(cardIdExpr)}
      AND (
        ${unownedCardItemVisibleSql(
          unownedVisibilityColumns(imageStreamer),
          "image",
          { withoutItemColumns },
        )}
        OR ${ownedByViewer}
      )
  )`;
}

/**
 * One snapshot plus the card definition it was taken from. `cardId` is NULL
 * when the definition was deleted (ON DELETE SET NULL) or the id is unknown.
 */
export type TradeCardRef = {
  cardId: string | null;
  snapshot: TradeCardSnapshot;
};

/** 旧 export 名との互換用。新規コードは TradeCardRef を使う。 */
export type TradeCardImageRef = TradeCardRef;

/**
 * 配信者ごとの百科事典番号（#N）を、閲覧者に依存しない入力から作る。
 *
 * 入力は「その配信者の全カード（is_active=false も含む）」でなければならない。
 * コレクション画面（src/app/collection/[streamerId]/page.tsx）と同じ
 * createCollectionNumberMap() を使うため、出品者・応諾者・コレクション画面の
 * どこで見ても同じカードが同じ #N になる。所持カードだけ・アクティブカードだけを
 * 渡すとカード番号がずれ、名前非公開カードを #N で選べなくなる。
 *
 * 呼び出し側は「カードID → streamer_id」を自分のクエリで解決してから渡す
 * （maskTradeCards は可視性クエリで同じ行から streamer_id を取るので、
 * 追加のルックアップは不要。listWantableCards は配信者IDを直接知っている）。
 * これにより、参照カードが何枚あっても配信者数に依存しない1クエリで済む。
 */
async function loadCollectionNumberMapsForStreamers(
  streamerIds: readonly string[],
): Promise<Map<string, number>> {
  const uniqueStreamerIds = [...new Set(streamerIds.filter(Boolean))];
  const numbers = new Map<string, number>();
  if (uniqueStreamerIds.length === 0) return numbers;

  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: cardsTable.id,
          streamerId: cardsTable.streamer_id,
          cardNumber: cardsTable.card_number,
          createdAt: cardsTable.created_at,
        })
        .from(cardsTable)
        .where(inArray(cardsTable.streamer_id, uniqueStreamerIds));
    },
    "trade:collection-numbers",
    { idempotent: true },
  );

  const cardsByStreamer = new Map<
    string,
    Array<{ id: string; card_number: number | null; created_at: string }>
  >();
  for (const row of rows) {
    let list = cardsByStreamer.get(row.streamerId);
    if (!list) {
      list = [];
      cardsByStreamer.set(row.streamerId, list);
    }
    list.push({
      id: row.id,
      card_number: row.cardNumber,
      created_at: row.createdAt ?? "",
    });
  }
  for (const cards of cardsByStreamer.values()) {
    for (const [cardId, number] of createCollectionNumberMap(cards)) {
      numbers.set(cardId, number);
    }
  }
  return numbers;
}

/**
 * Read-time mask for every card snapshot that leaves a trade service function.
 *
 * 1関数・2クエリで「名前」と「画像」を同時に隠し、表示番号を付ける:
 *   1. 参照カードIDについて、閲覧者が名前/画像を見てよいかと配信者IDを1クエリで解決
 *   2. その配信者の全カード（無効化含む）から #N の番号表を作る
 *
 * 入力スナップショットは変更しない（保存済み JSONB は完全なまま。読み取り時に
 * マスクすることで、後からカードを取得した人には画像・名前が見える）。戻り値は
 * 常に新しいオブジェクトで、deny-by-default:
 *   - カードIDが NULL（削除済み定義・不明）
 *   - マスククエリの結果に現れないID
 * は name="" / imageUrl=null / collectionNumber=null になる。
 *
 * 名前の判定は「所持 ≥ 1 OR 解決済み name 公開」、画像は「所持 ≥ 1 OR
 * 解決済み image 公開」で、行の可視性（show_unowned_cards）とは独立している。
 * 全項目非公開でも行は残り、#N だけで選べる（要件）。
 *
 * デプロイ窓: 可視性クエリは新3列を参照するため、42703 のときは
 * withUnownedCardItemColumnFallback が旧 details 規則で1回だけ再試行する
 * （TypeScript の resolveUnownedCardVisibility 規則 b と同じ）。
 *
 * 失敗時（DBエラー）は呼び出し側が fail-closed にする。一覧 API は従来どおり
 * 例外をそのまま返し、COMMIT 後の作成/応諾レスポンスだけは catch して
 * 空・null に倒す（既存挙動）。
 */
export async function maskTradeCards(
  refs: readonly TradeCardRef[],
  viewerUserId: string | null,
): Promise<TradeCardSnapshot[]> {
  if (refs.length === 0) return [];

  const ids = [...new Set(refs.flatMap((ref) => (ref.cardId !== null ? [ref.cardId] : [])))];
  if (ids.length === 0) {
    // カード定義が分からない参照は、名前も画像も番号も証明できない。
    return refs.map((ref) => ({
      ...ref.snapshot,
      name: "",
      imageUrl: null,
      collectionNumber: null,
    }));
  }

  const maskRows = await withDbRetry(
    () =>
      withUnownedCardItemColumnFallback(async (withoutItemColumns) => {
        const { db } = await getDb();
        // users.id は解決済みの文字列なので uuid パラメータとして明示的に束縛する。
        // NULL（匿名・不明ユーザー）は所持なしの分岐になる。
        const viewerSql =
          viewerUserId === null ? null : sql`${viewerUserId}::uuid`;
        return db
          .select({
            cardId: cardsTable.id,
            streamerId: cardsTable.streamer_id,
            nameVisible: cardNameVisibleTo(cardsTable.id, viewerSql, withoutItemColumns),
            imageVisible: cardImageVisibleTo(cardsTable.id, viewerSql, withoutItemColumns),
          })
          .from(cardsTable)
          .where(inArray(cardsTable.id, ids));
      }),
    "trade:card-item-visibility",
    { idempotent: true },
  );

  const rowByCardId = new Map(maskRows.map((row) => [row.cardId, row]));
  const numberMap = await loadCollectionNumberMapsForStreamers(
    maskRows.map((row) => row.streamerId),
  );

  return refs.map((ref) => {
    const row = ref.cardId === null ? undefined : rowByCardId.get(ref.cardId);
    if (!row || ref.cardId === null) {
      return { ...ref.snapshot, name: "", imageUrl: null, collectionNumber: null };
    }
    return {
      ...ref.snapshot,
      name: row.nameVisible === true ? ref.snapshot.name : "",
      imageUrl: row.imageVisible === true ? ref.snapshot.imageUrl : null,
      collectionNumber: numberMap.get(ref.cardId) ?? null,
    };
  });
}

/**
 * 旧名（画像だけを隠すマスク）の互換エクスポート。実体は maskTradeCards()。
 *
 * 重要: 名前もマスクする。cardVisibleTo の行ルールが
 * 「所持 OR show_unowned_cards」へ広がったため、オークションの行も
 * 名前非公開のまま表示され得る。ここで名前を素通しすると、オークションが
 * 未所持カード名の side channel になってしまう（トレード板と同一の
 * セキュリティ境界）。C3b 以降、オークションサービスはこの互換名ではなく
 * maskTradeCards() を直接呼ぶ（名前・画像・#N の3点セットであることを
 * import で明示するため）。旧名は既存の呼び出し・テストとの互換に残す。
 */
export async function maskTradeCardImages(
  refs: readonly TradeCardImageRef[],
  viewerUserId: string | null,
): Promise<TradeCardSnapshot[]> {
  return maskTradeCards(refs, viewerUserId);
}

/**
 * DTO / 読み取り時のカードスナップショット。
 *
 * collectionNumber は「閲覧者に依存しない」百科事典番号（#N）。コレクション
 * 画面と同じ createCollectionNumberMap（その配信者の全カード、無効化含む）で
 * 作るため、出品者・応諾者・コレクション画面で同じ値になる。カード定義が
 * 削除済み（cardId = NULL）で番号を証明できない場合は null。
 *
 * この型は DTO 専用で、DB の JSONB へ書き込む形ではない。
 * 保存形式は StoredTradeCardSnapshot を使うこと（collectionNumber を保存すると
 * 後から番号表が変わったときに古い値が残り、画面間で食い違う）。
 */
export type TradeCardSnapshot = {
  name: string;
  rarity: string;
  imageUrl: string | null;
  collectionNumber: number | null;
};

/**
 * trade_offers / trade_auctions の JSONB に保存する形（保存形式）。
 *
 * collectionNumber を持たない。保存済みスナップショットは完全なまま残し
 * （後からカードを取得した人にも名前・画像を見せるため）、読み取り時に
 * maskTradeCards() がマスクと番号付与を行う。
 */
export type StoredTradeCardSnapshot = Omit<TradeCardSnapshot, "collectionNumber">;

export type TradeStreamerSummary = {
  id: string;
  twitchUsername: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
};

export type TradeUserSummary = {
  twitchUsername: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
};

type TradeOfferRow = typeof tradeOffersTable.$inferSelect;

export type TradeOfferDto = {
  id: string;
  /**
   * Internal user_cards id of the listed copy. Only returned for the viewer's
   * own offers on the public board, and always on /mine (every row there is
   * either the viewer's listing or a copy the viewer received).
   */
  offeredUserCardId?: string;
  offeredCardId: string | null;
  offeredStreamerId: string;
  wantedCardId: string | null;
  wantedStreamerId: string;
  offeredCard: TradeCardSnapshot;
  wantedCard: TradeCardSnapshot;
  isCrossChannel: boolean;
  /** Copies of the wanted card the acceptor gives (1 = classic 1:1 offer, #1789). */
  wantedQuantity: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  offerer: TradeUserSummary | null;
  /** Acceptor of a completed offer (null while open/cancelled or if deleted). */
  acceptedBy: TradeUserSummary | null;
  offeredStreamer: TradeStreamerSummary | null;
  wantedStreamer: TradeStreamerSummary | null;
  isOwnOffer?: boolean;
  canAccept?: TradeCanAccept;
  /**
   * GET /api/trades/mine rows only: whether anybody can still accept this
   * listing (#1754 item 4). Always false outside `status === "open"` (a
   * completed/cancelled offer is not acceptable by definition). For an open
   * offer it is false when a card definition was deleted or deactivated, when
   * the wanted card was switched to "cannot be requested" (#1790), or
   * when a channel's trade_enabled / (for cross-channel offers)
   * cross_channel_trade_enabled is off — the same gates that decide whether
   * the board lists the offer, so "not tradeable" is exactly a row nobody can
   * accept and the offerer has to cancel. The viewer-dependent visibility
   * rule is deliberately NOT part of it: visibility decides who may SEE the
   * offer, while an acceptor must own a copy of the wanted card to pay with
   * it anyway.
   */
  tradeable?: boolean;
  mineRole?: "offerer" | "acceptor";
};

/**
 * 1コレクション分の出品一覧 (#2079)。total は画面に出す先頭
 * TRADE_COLLECTION_PREVIEW_SIZE 件ではなく、その配置先に属する全件数
 * （SQL の COUNT(*) OVER）。latestCreatedAt はハブのコレクション並び
 * （最新の出品が新しい順）に使う全件の最大値。
 */
export type TradeCollectionOfferGroup = {
  streamer: TradeStreamerSummary;
  offers: TradeOfferDto[];
  total: number;
  latestCreatedAt: string;
};

function cardSnapshot(card: {
  name: string;
  rarity: string;
  image_url: string | null;
}): StoredTradeCardSnapshot {
  return {
    name: card.name,
    rarity: card.rarity,
    imageUrl: card.image_url,
  };
}

/**
 * 保存済み JSONB / RPC 応答のスナップショットを DTO の土台へ正規化する。
 *
 * collectionNumber は保存されていない（保存形式を変えない）ため、ここでは
 * null を入れておき、maskTradeCards() が読み取り時に実値を与える。マスクを
 * 通さずにこの値をクライアントへ返してはならない（番号なし・マスクなしに
 * なる）。未知の形は fail-closed で空文字 / null にする。
 */
export function normalizeSnapshot(value: unknown): TradeCardSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: "", rarity: "", imageUrl: null, collectionNumber: null };
  }
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : "",
    rarity: typeof record.rarity === "string" ? record.rarity : "",
    imageUrl:
      typeof record.imageUrl === "string"
        ? record.imageUrl
        : typeof record.image_url === "string"
          ? record.image_url
          : null,
    collectionNumber: null,
  };
}

// Aliases used by the single-statement queries below. Each one is joined at
// most once per statement, so qualifiedColumn() on them is unambiguous.
const createReplayOffer = alias(tradeOffersTable, "replay_offer");
const createOfferedCopy = alias(userCardsTable, "offered_copy");
const createOfferedCard = alias(cardsTable, "offered_card");
const createWantedCard = alias(cardsTable, "wanted_card");
const createOfferedGate = alias(streamersTable, "offered_gate");
const createWantedGate = alias(streamersTable, "wanted_gate");
const offeredStreamerMeta = alias(streamersTable, "offered_streamer");
const wantedStreamerMeta = alias(streamersTable, "wanted_streamer");
// #2079: the collection whose section a row is placed under (for a cross
// offer this can be either side of the trade).
const placementStreamerMeta = alias(streamersTable, "collection_streamer");
const offererMeta = alias(usersTable, "offerer_user");
const acceptorMeta = alias(usersTable, "acceptor_user");

async function findOfferByCreateRequest(userId: string, requestId: string) {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select(offerRowFields(tradeOffersTable))
        .from(tradeOffersTable)
        .where(
          and(
            eq(tradeOffersTable.offerer_user_id, userId),
            eq(tradeOffersTable.request_id, requestId),
          ),
        )
        .limit(1);
    },
    "trade:create-replay-lookup",
    { idempotent: true },
  );
  return rows[0] ?? null;
}

async function findOpenOfferForUserCard(userCardId: string) {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ id: tradeOffersTable.id })
        .from(tradeOffersTable)
        .where(
          and(
            eq(tradeOffersTable.offered_user_card_id, userCardId),
            eq(tradeOffersTable.status, "open"),
          ),
        )
        .limit(1);
    },
    "trade:open-user-card-lookup",
    { idempotent: true },
  );
  return rows[0] ?? null;
}

function uniqueConstraintName(error: unknown): string | null {
  for (const layer of getErrorChain(error)) {
    if (!layer || typeof layer !== "object") continue;
    const constraint = (layer as { constraint_name?: unknown; constraint?: unknown })
      .constraint_name
      ?? (layer as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Card visibility (security)
//
// Row visibility and item visibility are decided separately:
//   * cardVisibleTo decides whether the row exists for the viewer at all
//     (owned OR show_unowned_cards, is_active required). It is part of every
//     WHERE / JOIN condition, so hidden rows never reach the Worker and cannot
//     leak through counts / hasMore / pagination either.
//   * name / image are masked per snapshot by maskTradeCards, because a row
//     can be visible with every item hidden (the #N-only case).
//
// This is a security boundary, not a UI preference. Creating an offer
// snapshots the wanted card's name/rarity/image into trade_offers and echoes
// it back, and the public board returns those snapshots. A stored snapshot is
// deliberately complete (a later owner must still see the image), so every
// read masks it again for the current viewer. Each card is evaluated against
// ITS OWN streamer's settings, which keeps cross-channel offers safe.
// -----------------------------------------------------------------------------

export async function createTradeOffer(input: {
  twitchUserId: string;
  offeredUserCardId: string;
  wantedCardId: string;
  /** 1..TRADE_MAX_WANTED_QUANTITY (validated by the API route). Default 1. */
  wantedQuantity?: number;
  requestId: string;
}): Promise<
  | {
    kind: "ok";
    offer: TradeOfferRow;
    /**
     * DTO-ready snapshots (masked name/image + collectionNumber). The route
     * MUST return these instead of re-reading offer.*_snapshot, so the
     * idempotent replay path cannot bypass the mask either.
     */
    offeredCard: TradeCardSnapshot;
    wantedCard: TradeCardSnapshot;
    idempotentReplay: boolean;
  }
  | { kind: "error"; code: TradeServiceErrorCode }
> {
  // One read for every create-time check (previously 7 sequential reads:
  // user, replay, offered copy, wanted card, streamer gates, open listing of
  // the copy, open-offer count). Each LEFT JOIN matches at most one row
  // (primary keys / the (offerer_user_id, request_id) unique index), so the
  // statement returns exactly one row for a known user and none otherwise.
  // Only decisions moved to TypeScript; their order below is unchanged.
  //
  // The trade_wantable fallback (#1790) only affects this read (the INSERT
  // does not touch cards) and is allowed for any quantity.
  //
  // #1791: "already listed" now means "locked" (open offer, auction listing or
  // active bid; see copyLockedExpr) and the open-listing limit counts auction
  // listings too. Both read the auction schema, so the whole check also runs
  // inside withTradeAuctionSchemaFallback (outermost). Any combination of the
  // deploy windows converges (each layer only handles its own 42703/42P01/
  // 42883 and rethrows the rest outward, and the retry keeps the flags it
  // already resolved), only during the windows. C3b: この読み取りは行ルール
  // (show_unowned_cards) しか使わないため、新3列のデプロイ窓
  // (withUnownedCardItemColumnFallback) はここには不要になった。名前・画像の
  // マスクは応答直前に呼ぶ maskTradeCards() が自分で 42703 を検出して
  // 旧 details 規則へ縮退する（C3a で入った一元化）。
  const wantedQuantity = input.wantedQuantity ?? 1;
  const runChecks = async (
    withoutWantable: boolean,
    withoutAuctions: boolean,
  ) => ({
    rows: await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            userId: usersTable.id,
            // Full row of a previous create with the same requestId (or null).
            replay: offerRowFields(createReplayOffer),
            offeredUserCardId: createOfferedCopy.id,
            offeredCardId: createOfferedCard.id,
            offeredStreamerId: createOfferedCard.streamer_id,
            offeredName: createOfferedCard.name,
            offeredRarity: createOfferedCard.rarity,
            offeredImageUrl: createOfferedCard.image_url,
            offeredIsActive: createOfferedCard.is_active,
            wantedCardId: createWantedCard.id,
            wantedStreamerId: createWantedCard.streamer_id,
            wantedName: createWantedCard.name,
            wantedRarity: createWantedCard.rarity,
            wantedImageUrl: createWantedCard.image_url,
            // #1790: whether the wanted card may be requested at all. Only
            // read for a card that already passed the visibility JOIN, so it
            // reveals nothing about hidden cards.
            wantedWantable: cardIsWantable(createWantedCard.id, withoutWantable),
            // Exchange-target restriction of the offered card's streamer
            // (the streamer's allowlist, resolved through cards.streamer_id).
            wantedAllowed: wantedAllowedForOffered(createOfferedCard.id, createWantedCard.id),
            offeredTradeEnabled: createOfferedGate.trade_enabled,
            offeredCrossEnabled: createOfferedGate.cross_channel_trade_enabled,
            wantedTradeEnabled: createWantedGate.trade_enabled,
            wantedCrossEnabled: createWantedGate.cross_channel_trade_enabled,
            // #1791: locked by an open offer (the partial unique index
            // predicate of idx_trade_offers_open_user_card), an auction
            // listing or an active bid. Advisory only: the trade_offers
            // trigger re-checks it under a row lock (TRADE_CARD_LOCKED below).
            offeredCopyListed: copyLockedExpr(
              sql`${input.offeredUserCardId}::uuid`,
              withoutAuctions,
            ),
            // Open regular offers + auction listings (shared limit, #1791).
            openOfferCount: openListingCountExpr(qualifiedColumn(usersTable.id), withoutAuctions),
          })
          .from(usersTable)
          .leftJoin(
            createReplayOffer,
            and(
              eq(createReplayOffer.offerer_user_id, usersTable.id),
              eq(createReplayOffer.request_id, input.requestId),
            ),
          )
          .leftJoin(
            createOfferedCopy,
            and(
              eq(createOfferedCopy.id, input.offeredUserCardId),
              eq(createOfferedCopy.user_id, usersTable.id),
            ),
          )
          .leftJoin(createOfferedCard, eq(createOfferedCard.id, createOfferedCopy.card_id))
          .leftJoin(
            createWantedCard,
            and(
              eq(createWantedCard.id, input.wantedCardId),
              eq(createWantedCard.is_active, true),
              // Visibility is part of the JOIN condition (not a post-read
              // filter) with the same row predicate as the board, so hidden
              // cards (show_unowned_cards = false) are never read into the
              // Worker (the same policy as listWantableCards). A hidden card
              // joins to NULL and falls into TRADE_WANTED_CARD_UNAVAILABLE
              // below. Name and image are masked later by maskTradeCards, so a
              // card whose items are all private never echoes them back.
              cardVisibleTo(
                createWantedCard.id,
                qualifiedColumn(usersTable.id),
              ),
            ),
          )
          .leftJoin(createOfferedGate, eq(createOfferedGate.id, createOfferedCard.streamer_id))
          .leftJoin(createWantedGate, eq(createWantedGate.id, createWantedCard.streamer_id))
          .where(eq(usersTable.twitch_user_id, input.twitchUserId))
          .limit(1);
      },
      "trade:create-checks",
      { idempotent: true },
    ),
  });
  const { rows: checkRows } = await withTradeAuctionSchemaFallback(
    (withoutAuctions) => withTradeWantableColumnFallback(
      (withoutWantable) => runChecks(withoutWantable, withoutAuctions),
    ),
  );
  const check = checkRows[0];
  if (!check) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }
  const userId = check.userId;

  // The snapshot columns stay complete in the database (a later owner must
  // still see the image/name), so the response row is masked at read time.
  // Every `ok` return below goes through this helper (including the idempotent
  // replay and the 23505 recovery row), and the route returns the DTO
  // snapshots it produces. The mask needs two statements (visibility + number
  // table) and is skipped only when both snapshots have no card id.
  //
  // Devin Review on #2073: the mask runs AFTER the trade_offers INSERT has
  // committed (or after a replay row was read back). If that follow-up read
  // throws, the offer already exists and the copy is already locked, so letting
  // the exception escape would report a failure for a published offer (and the
  // retry would only see the replay). Like acceptTradeOffer, fail CLOSED
  // instead: keep the committed offer and blank BOTH items (name/image) and the
  // number, which are the values that could not be proven visible. rarity is
  // always public and stays.
  type MaskedOffer = {
    offer: TradeOfferRow;
    offeredCard: TradeCardSnapshot;
    wantedCard: TradeCardSnapshot;
  };
  const maskOfferRow = async (offer: TradeOfferRow): Promise<MaskedOffer> => {
    const offeredSnapshot = normalizeSnapshot(offer.offered_card_snapshot);
    const wantedSnapshot = normalizeSnapshot(offer.wanted_card_snapshot);
    try {
      const [offeredCard, wantedCard] = await maskTradeCards(
        [
          { cardId: offer.offered_card_id, snapshot: offeredSnapshot },
          { cardId: offer.wanted_card_id, snapshot: wantedSnapshot },
        ],
        userId,
      );
      return {
        offer: { ...offer, offered_card_snapshot: offeredCard, wanted_card_snapshot: wantedCard },
        offeredCard,
        wantedCard,
      };
    } catch (error) {
      // Exactly one warning per affected response. The snapshots (which hold
      // imageUrl) and user identifiers are never passed explicitly; the shared
      // logger additionally redacts Drizzle bind params in the error object.
      logger.warn(
        "trade:create card mask failed after COMMIT; returning the offer without names/images",
        { error },
      );
      const offeredCard: TradeCardSnapshot = {
        ...offeredSnapshot,
        name: "",
        imageUrl: null,
        collectionNumber: null,
      };
      const wantedCard: TradeCardSnapshot = {
        ...wantedSnapshot,
        name: "",
        imageUrl: null,
        collectionNumber: null,
      };
      return {
        offer: { ...offer, offered_card_snapshot: offeredCard, wanted_card_snapshot: wantedCard },
        offeredCard,
        wantedCard,
      };
    }
  };

  // Create idempotency is checked before mutable business validation. A client
  // retry after a successful commit must return the original offer even if a
  // channel setting changes between attempts.
  if (check.replay) {
    return {
      kind: "ok",
      ...(await maskOfferRow(check.replay)),
      idempotentReplay: true,
    };
  }

  // The copy must exist, belong to the user and reference an existing card
  // definition (the previous INNER JOIN semantics).
  if (
    !check.offeredUserCardId
    || !check.offeredCardId
    || !check.offeredStreamerId
  ) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }

  // Inactive card definitions (retired cards and pack completion reward cards)
  // are excluded from trading entirely. `is_active` is nullable in the schema
  // (DEFAULT true without NOT NULL), so only an explicit TRUE is accepted.
  // The offerer owns this copy, so revealing its inactive state leaks nothing.
  if (check.offeredIsActive !== true) {
    return { kind: "error", code: "TRADE_OFFERED_CARD_INACTIVE" };
  }

  if (check.offeredCardId === input.wantedCardId) {
    return { kind: "error", code: "TRADE_SAME_CARD" };
  }

  // Hidden and non-existent/inactive cards share one error code on purpose:
  // a distinct "hidden" error (or reaching the TRADE_DISABLED gate below)
  // would confirm that an unrevealed card id exists. This check therefore
  // runs before the streamer gate checks. (Visibility already filtered the
  // JOIN above, so a hidden card arrives here as NULL, indistinguishable
  // from a missing/inactive one, and its name was never read.)
  if (!check.wantedCardId || !check.wantedStreamerId) {
    return { kind: "error", code: "TRADE_WANTED_CARD_UNAVAILABLE" };
  }

  // A missing streamer row reads as NULL here, i.e. disabled (fail closed).
  if (check.offeredTradeEnabled !== true || check.wantedTradeEnabled !== true) {
    return { kind: "error", code: "TRADE_DISABLED" };
  }
  if (
    check.offeredStreamerId !== check.wantedStreamerId
    && (check.offeredCrossEnabled !== true || check.wantedCrossEnabled !== true)
  ) {
    return { kind: "error", code: "TRADE_DISABLED" };
  }

  // #1790: the wanted card's streamer does not allow requesting it. Checked
  // after the visibility check above (a hidden card must keep answering
  // TRADE_WANTED_CARD_UNAVAILABLE so its existence is not confirmed) and after
  // the channel gates (a disabled channel is the more fundamental answer).
  // This server check is authoritative; listWantableCards only keeps such
  // cards out of the listing form. Only an explicit TRUE passes.
  if (check.wantedWantable !== true) {
    return { kind: "error", code: "TRADE_WANTED_CARD_NOT_WANTABLE" };
  }

  // The offered card's streamer restricted its exchange targets and the wanted
  // card is not in the streamer's list. Ordered after the visibility / gate /
  // wantable checks for the same reason as above (a hidden card must keep
  // answering TRADE_WANTED_CARD_UNAVAILABLE). The accept RPC re-checks it for
  // offers that become disallowed after listing. Only an explicit TRUE passes.
  if (check.wantedAllowed !== true) {
    return { kind: "error", code: "TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED" };
  }

  if (check.offeredCopyListed === true) {
    return { kind: "error", code: "TRADE_CARD_ALREADY_LISTED" };
  }

  if (Number(check.openOfferCount ?? 0) >= TRADE_MAX_OPEN_OFFERS) {
    return { kind: "error", code: "TRADE_OFFER_LIMIT" };
  }

  const values = {
    offerer_user_id: userId,
    offered_user_card_id: check.offeredUserCardId,
    offered_card_id: check.offeredCardId,
    offered_streamer_id: check.offeredStreamerId,
    wanted_card_id: check.wantedCardId,
    wanted_streamer_id: check.wantedStreamerId,
    offered_card_snapshot: cardSnapshot({
      name: check.offeredName ?? "",
      rarity: check.offeredRarity ?? "",
      image_url: check.offeredImageUrl,
    }),
    wanted_card_snapshot: cardSnapshot({
      name: check.wantedName ?? "",
      rarity: check.wantedRarity ?? "",
      image_url: check.wantedImageUrl,
    }),
    request_id: input.requestId,
    wanted_quantity: wantedQuantity,
  } satisfies typeof tradeOffersTable.$inferInsert;

  try {
    const rows: TradeOfferRow[] = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .insert(tradeOffersTable)
          .values(values)
          .returning();
      },
      "trade:create-insert",
      // request_id makes replay result-safe. If a connection dies after COMMIT,
      // a retry may hit 23505 and is resolved below through the same request_id.
      { idempotent: true },
    );
    const offer = rows[0];
    if (!offer) throw new Error("Trade offer INSERT returned no row");
    return { kind: "ok", ...(await maskOfferRow(offer)), idempotentReplay: false };
  } catch (error) {
    // #1791: the trade_offers BEFORE INSERT trigger serializes on the copy's
    // user_cards row and rejects a copy that an auction listing / active bid
    // took between the check above and this INSERT (TRADE_CARD_LOCKED), or
    // that a concurrent auction settlement moved to another user
    // (TRADE_CARD_NOT_OWNED). Both are the same answers as the precheck.
    // withDbRetry does not retry P0001, so the INSERT ran exactly once. The
    // existing 23505 handling below is unchanged.
    if (isTradeOfferTriggerError(error, "TRADE_CARD_LOCKED")) {
      return { kind: "error", code: "TRADE_CARD_ALREADY_LISTED" };
    }
    if (isTradeOfferTriggerError(error, "TRADE_CARD_NOT_OWNED")) {
      return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
    }
    if (!isPgUniqueViolationError(error)) throw error;

    // Rare conflict path: kept as separate follow-up reads (not part of the
    // round-trip budget of the normal path).
    const byRequest = await findOfferByCreateRequest(userId, input.requestId);
    if (byRequest) {
      return { kind: "ok", ...(await maskOfferRow(byRequest)), idempotentReplay: true };
    }

    const constraint = uniqueConstraintName(error);
    if (
      constraint === "idx_trade_offers_open_user_card"
      || await findOpenOfferForUserCard(input.offeredUserCardId)
    ) {
      return { kind: "error", code: "TRADE_CARD_ALREADY_LISTED" };
    }
    throw error;
  }
}

export function tradeEnabledGate(streamerColumn: AnyColumn) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${streamersTable} AS trade_gate
    WHERE trade_gate.id = ${qualifiedColumn(streamerColumn)}
      AND trade_gate.trade_enabled = TRUE
  )`;
}

export function crossEnabledGate(streamerColumn: AnyColumn) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${streamersTable} AS cross_gate
    WHERE cross_gate.id = ${qualifiedColumn(streamerColumn)}
      AND cross_gate.cross_channel_trade_enabled = TRUE
  )`;
}

type ListContext = "board" | "mine";

/**
 * Columns of one listing statement: the offer row itself plus the display
 * metadata that used to be fetched by two follow-up queries (streamers and
 * participants). The metadata tables are LEFT JOINed through aliases, so a
 * missing streamer/user row (or an open offer without acceptor) yields NULL
 * fields instead of dropping the offer.
 */
function offerListFields(viewerUserId: SQL | null) {
  return {
    offer: offerRowFields(tradeOffersTable),
    // The resolved viewer id is returned with every row so that isOwnOffer /
    // mineRole are computed from the same snapshot as the WHERE clause. NULL
    // for anonymous viewers and for unknown twitch user ids.
    viewerUserId: viewerUserId
      ? sql<string | null>`${viewerUserId}`
      : sql<string | null>`NULL::uuid`,
    offeredStreamer: streamerSummaryFields(offeredStreamerMeta),
    wantedStreamer: streamerSummaryFields(wantedStreamerMeta),
    offerer: userSummaryFields(offererMeta),
    acceptedBy: userSummaryFields(acceptorMeta),
  };
}

function streamerSummaryFields<
  T extends typeof offeredStreamerMeta | typeof wantedStreamerMeta | typeof placementStreamerMeta,
>(table: T) {
  return {
    id: table.id,
    twitchUsername: table.twitch_username,
    twitchDisplayName: table.twitch_display_name,
    twitchProfileImageUrl: table.twitch_profile_image_url,
  };
}

function userSummaryFields<T extends typeof offererMeta | typeof acceptorMeta>(table: T) {
  return {
    // Only used to tell "joined" from "no row"; not exposed in the DTO.
    id: table.id,
    twitchUsername: table.twitch_username,
    twitchDisplayName: table.twitch_display_name,
    twitchProfileImageUrl: table.twitch_profile_image_url,
  };
}

type NullableFields<T> = { [K in keyof T]: T[K] | null };
type JoinedStreamer = NullableFields<TradeStreamerSummary> | null;
type JoinedUser = (NullableFields<TradeUserSummary> & { id: string | null }) | null;

type OfferListRow = {
  offer: TradeOfferRow;
  viewerUserId: string | null;
  offeredStreamer: JoinedStreamer;
  wantedStreamer: JoinedStreamer;
  offerer: JoinedUser;
  acceptedBy: JoinedUser;
  acceptState?: TradeCanAccept | null;
  /** Only computed (and only used) by listMyTradeOffers — see the DTO field. */
  tradeableState?: boolean | null;
};

/**
 * Drizzle returns a nested object of a LEFT JOINed table either as null or
 * with all-null fields depending on the selection shape; both mean "no row".
 */
function toStreamerSummary(row: JoinedStreamer): TradeStreamerSummary | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    twitchUsername: row.twitchUsername ?? "",
    twitchDisplayName: row.twitchDisplayName ?? "",
    twitchProfileImageUrl: row.twitchProfileImageUrl ?? null,
  };
}

function toUserSummary(row: JoinedUser): TradeUserSummary | null {
  if (!row?.id) return null;
  return {
    twitchUsername: row.twitchUsername ?? "",
    twitchDisplayName: row.twitchDisplayName ?? "",
    twitchProfileImageUrl: row.twitchProfileImageUrl ?? null,
  };
}

/**
 * Board canAccept, evaluated per row in SQL (previously a third follow-up
 * query over the viewer's copies). Same exclusion rule as the accept RPC
 * (which excludes the acceptor's own open offers via
 * `offerer_user_id = acceptor`): a copy listed in one of the viewer's own
 * open offers cannot be used to pay. The RPC needs wanted_quantity such
 * copies (#1789), so the states compare COUNTS with it (see TradeCanAccept).
 * With wanted_quantity = 1 they reduce to the previous EXISTS checks.
 *
 * Unlike the former EXISTS probes, count(*) does not stop at the first row,
 * but it only scans the viewer's copies of ONE card definition
 * (idx_user_cards_user_card), a handful of rows in practice.
 *
 * Both counts come from ONE pass over those copies (#1792 item 3): `owned`
 * is count(*) and `free` is the same count restricted by FILTER to copies
 * that are not in the viewer's own open offers. The CASE then reads the two
 * numbers from the derived table `counts`, so `owned` is computed once (it
 * used to be a scalar subquery repeated in two CASE branches, i.e. up to
 * twice per row) and the viewer's copies are scanned once instead of twice.
 * The `free` probe now runs for every owned copy instead of only when
 * owned >= wanted_quantity; that is one index probe on
 * trade_offers(offered_user_card_id) per copy, negligible for the same
 * handful of rows. A plain derived table (not LATERAL) is enough because the
 * only outer references are the qualified trade_offers columns and the viewer
 * id, which a correlated sub-select may use from the enclosing query. The
 * inner aliases are literal; the result is identical to the previous form.
 */
function acceptStateFor(viewerUserId: SQL, withoutAuctions: boolean) {
  const wantedCardId = qualifiedColumn(tradeOffersTable.wanted_card_id);
  const wantedQuantity = qualifiedColumn(tradeOffersTable.wanted_quantity);
  // #1791: `free` excludes every locked copy (open offer, auction listing or
  // active bid) with the same trade_copy_locked() the accept RPC now uses to
  // pick the payment copies, so "all_listed" also covers copies held by the
  // viewer's auction listings and bids. The former predicate only looked at
  // the viewer's own open offers. A lingering open offer left by a previous
  // owner would still lock the copy through trade_copy_locked() (which keys on
  // the user_card, not the seller), so the free count stays correct even then;
  // such rows are a data-hygiene problem (the new owner cannot cancel them)
  // rather than an accept-correctness problem. accept and settle move only
  // unlisted copies in the normal path. Deploy window: copyLockedExpr falls back to
  // "listed in an open offer".
  const counts = sql`(
    SELECT
      count(*) AS owned,
      count(*) FILTER (
        WHERE NOT ${copyLockedExpr(sql`accept_owned.id`, withoutAuctions)}
      ) AS free
    FROM ${userCardsTable} AS accept_owned
    WHERE accept_owned.user_id = ${viewerUserId}
      AND accept_owned.card_id = ${wantedCardId}
  )`;
  return sql<TradeCanAccept>`(
    SELECT CASE
      WHEN counts.owned = 0 THEN 'not_owned'
      WHEN counts.owned < ${wantedQuantity} THEN 'not_enough'
      WHEN counts.free < ${wantedQuantity} THEN 'all_listed'
      ELSE 'yes'
    END
    FROM ${counts} AS counts
  )`;
}

/**
 * Whether an open offer can still be accepted by somebody, evaluated in SQL
 * with the exact gate predicates the board filters with (#1754 item 4):
 *
 *   tradeable(offer) ⇔ both card definitions are active
 *     AND the wanted card may be requested (cards.trade_wantable, #1790)
 *     AND both channels have trade_enabled = TRUE
 *     AND (the offer is not cross-channel
 *          OR both channels have cross_channel_trade_enabled = TRUE)
 *
 * A deleted card definition (offered_card_id / wanted_card_id NULL) makes
 * cardIsActive() false, and a missing streamer row makes the gates false, so
 * both fail closed exactly like listTradeOffers and precheckTradeAccept.
 * `IS NOT TRUE` (instead of NOT) keeps a NULL is_cross_channel on the
 * "in-channel" side rather than turning the whole expression into NULL.
 */
function tradeableStateFor(withoutWantable: boolean) {
  return sql<boolean>`(
    ${cardIsActive(tradeOffersTable.offered_card_id)}
    AND ${cardIsActive(tradeOffersTable.wanted_card_id)}
    AND ${cardIsWantable(tradeOffersTable.wanted_card_id, withoutWantable)}
    AND ${wantedAllowedForOffered(tradeOffersTable.offered_card_id, tradeOffersTable.wanted_card_id)}
    AND ${tradeEnabledGate(tradeOffersTable.offered_streamer_id)}
    AND ${tradeEnabledGate(tradeOffersTable.wanted_streamer_id)}
    AND (
      ${qualifiedColumn(tradeOffersTable.is_cross_channel)} IS NOT TRUE
      OR (
        ${crossEnabledGate(tradeOffersTable.offered_streamer_id)}
        AND ${crossEnabledGate(tradeOffersTable.wanted_streamer_id)}
      )
    )
  )`;
}

function toOfferDto(row: OfferListRow, context: ListContext): TradeOfferDto {
  const offer = row.offer;
  const viewerUserId = row.viewerUserId;
  const isOwnOffer = viewerUserId !== null && offer.offerer_user_id === viewerUserId;
  const dto: TradeOfferDto = {
    id: offer.id,
    offeredCardId: offer.offered_card_id,
    offeredStreamerId: offer.offered_streamer_id,
    wantedCardId: offer.wanted_card_id,
    wantedStreamerId: offer.wanted_streamer_id,
    wantedQuantity: offer.wanted_quantity,
    offeredCard: normalizeSnapshot(offer.offered_card_snapshot),
    wantedCard: normalizeSnapshot(offer.wanted_card_snapshot),
    isCrossChannel: Boolean(offer.is_cross_channel),
    status: offer.status,
    createdAt: offer.created_at,
    updatedAt: offer.updated_at,
    completedAt: offer.completed_at,
    offerer: toUserSummary(row.offerer),
    acceptedBy: offer.accepted_by_user_id ? toUserSummary(row.acceptedBy) : null,
    offeredStreamer: toStreamerSummary(row.offeredStreamer),
    wantedStreamer: toStreamerSummary(row.wantedStreamer),
  };

  // offered_user_card_id is an internal row id of somebody else's copy. It
  // is not needed to accept (the RPC resolves it) and would let third
  // parties track individual copies, so the public board only exposes it
  // for the viewer's own listings (needed for the cancel UI). Every /mine
  // row is the viewer's listing or a copy the viewer received.
  if (context === "mine" || isOwnOffer) {
    dto.offeredUserCardId = offer.offered_user_card_id;
  }

  if (viewerUserId !== null) {
    dto.isOwnOffer = isOwnOffer;
  }
  // canAccept is meaningless for own and /mine rows (skipped as before).
  if (
    context === "board"
    && viewerUserId !== null
    && !isOwnOffer
    && offer.wanted_card_id
    && row.acceptState
  ) {
    dto.canAccept = row.acceptState;
  }
  return dto;
}

/**
 * Read-time mask for a page of offer DTOs: ONE maskTradeCards() call for both
 * sides of every row, so name/image are hidden and collectionNumber is filled
 * consistently while the row itself (rarity/paging/hasMore) is untouched. The
 * viewer id is the one the page SELECT already resolved (NULL for
 * anonymous/unknown), so no extra users lookup is needed.
 *
 * Every offer DTO that leaves a service function must pass through here (or
 * through maskOfferRow in createTradeOffer); the DTO is built with
 * normalizeSnapshot() first, whose collectionNumber is null until this mask.
 */
async function maskOfferListCards(
  offers: TradeOfferDto[],
  viewerUserId: string | null,
): Promise<TradeOfferDto[]> {
  if (offers.length === 0) return offers;
  const masked = await maskTradeCards(
    offers.flatMap((offer) => [
      { cardId: offer.offeredCardId, snapshot: offer.offeredCard },
      { cardId: offer.wantedCardId, snapshot: offer.wantedCard },
    ]),
    viewerUserId,
  );
  return offers.map((offer, index) => ({
    ...offer,
    offeredCard: masked[index * 2],
    wantedCard: masked[index * 2 + 1],
  }));
}

/**
 * WHERE 条件 shared by every public offer list (#2079 で抽出): the board and
 * the hub's per-collection list must agree on what an acceptable, visible
 * open offer is.
 *
 * Both sides must be visible to the viewer at the ROW level (owned OR
 * show_unowned_cards). Whether the name/image of a visible row is revealed is
 * irrelevant here: an all-items-private row is still tradeable by #N, so
 * filtering it out would contradict the product rule. Own offers bypass only
 * this row rule (a channel switching show_unowned_cards off later must not
 * hide the viewer's own listing, whose wanted card they chose themselves), not
 * the is_active / trade_enabled gates below: an offer with an inactive card
 * is not tradeable for anyone, exactly like a trade_enabled=false channel,
 * and stays reachable (cancellable) through /api/trades/mine.
 *
 * Every condition is part of the SQL WHERE clause so that LIMIT/OFFSET,
 * hasMore and the card filters are all computed over the visible set only.
 * Post-filtering a fetched page would let a client infer hidden offers from
 * short pages or hasMore=true with no rows.
 *
 * cardIsActive() covers a NULL card_id on its own: a card definition deleted
 * after the offer was created sets offered_card_id/wanted_card_id to NULL
 * (ON DELETE SET NULL, see 20260817100000_add_card_trading.sql), and then
 * `active_card.id = NULL` is never TRUE so the EXISTS is false. No separate
 * IS NOT NULL condition is needed (verified on real PostgreSQL by
 * tests/integration/trade-visibility-pg.test.ts).
 *
 * #1790: an offer whose wanted card was switched to "cannot be requested"
 * after listing is hidden for everyone, the offerer included — the same
 * treatment as an inactive card above (nobody can accept it; the offerer
 * finds it on /mine as not tradeable). It is not cancelled, so switching the
 * card back brings the offer back. The condition depends on the deploy-window
 * shape, so withoutWantable is passed explicitly.
 *
 * 行ルール (cardVisibleTo) は新3列を読まないため、C3b で
 * withoutItemColumns の受け渡しを削除した。新3列のデプロイ窓は、名前・画像を
 * 実際に読む maskTradeCards() 側のフォールバックだけが扱う。
 */
function openOfferConditions(
  viewerUserId: SQL | null,
  withoutWantable: boolean,
) {
  const bothSidesVisible = and(
    cardVisibleTo(tradeOffersTable.offered_card_id, viewerUserId),
    cardVisibleTo(tradeOffersTable.wanted_card_id, viewerUserId),
  )!;
  const visibilityCondition = viewerUserId
    ? or(eq(tradeOffersTable.offerer_user_id, viewerUserId), bothSidesVisible)!
    : bothSidesVisible;
  return [
    eq(tradeOffersTable.status, "open"),
    tradeEnabledGate(tradeOffersTable.offered_streamer_id),
    tradeEnabledGate(tradeOffersTable.wanted_streamer_id),
    cardIsActive(tradeOffersTable.offered_card_id),
    cardIsActive(tradeOffersTable.wanted_card_id),
    cardIsWantable(tradeOffersTable.wanted_card_id, withoutWantable),
    // The offered card's streamer's exchange-target list: an offer that the
    // streamer's rule no longer allows leaves the board (and the hub) like a
    // no-longer-wantable one, and returns if the rule is lifted.
    wantedAllowedForOffered(tradeOffersTable.offered_card_id, tradeOffersTable.wanted_card_id),
    // A cross-channel offer exists on the board only while BOTH channels
    // still allow cross-channel trade (same predicate as tradeableStateFor).
    // In-channel offers keep appearing when cross trade is off; `IS NOT TRUE`
    // keeps a NULL is_cross_channel on the in-channel side rather than
    // turning the whole expression into NULL. This is part of the shared
    // conditions because the hub's per-collection list has no scope filter
    // that could otherwise drop cross offers on its own (#2079).
    or(
      sql<boolean>`${qualifiedColumn(tradeOffersTable.is_cross_channel)} IS NOT TRUE`,
      and(
        crossEnabledGate(tradeOffersTable.offered_streamer_id),
        crossEnabledGate(tradeOffersTable.wanted_streamer_id),
      )!,
    )!,
    visibilityCondition,
  ];
}

export async function listTradeOffers(input: {
  streamerId: string;
  scope: TradeScope;
  wantedCardId?: string;
  offeredCardId?: string;
  page: number;
  twitchUserId?: string;
}) {
  const viewerUserId = input.twitchUserId ? viewerUserIdOf(input.twitchUserId) : null;

  // The shared conditions are rebuilt inside the deploy-window closures so
  // that one request keeps a single fallback decision (cardIsWantable reads
  // cards.trade_wantable). The item columns are only read by the mask below,
  // which owns its own fallback (C3b).
  const conditionsFor = (withoutWantable: boolean) => {
    const conditions = [
      ...openOfferConditions(viewerUserId, withoutWantable),
    ];

    if (input.scope === "cross_channel") {
      conditions.push(
        eq(tradeOffersTable.is_cross_channel, true),
        or(
          eq(tradeOffersTable.offered_streamer_id, input.streamerId),
          eq(tradeOffersTable.wanted_streamer_id, input.streamerId),
        )!,
      );
    } else {
      conditions.push(
        eq(tradeOffersTable.is_cross_channel, false),
        eq(tradeOffersTable.offered_streamer_id, input.streamerId),
      );
    }

    if (input.wantedCardId) {
      conditions.push(eq(tradeOffersTable.wanted_card_id, input.wantedCardId));
    }
    if (input.offeredCardId) {
      conditions.push(eq(tradeOffersTable.offered_card_id, input.offeredCardId));
    }
    return conditions;
  };

  // Single statement (previously user lookup → page → metadata → canAccept,
  // i.e. 4 sequential round trips for a logged-in viewer).
  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  // #1791: canAccept reads the copy locks (acceptStateFor), hence the
  // outermost auction-schema fallback (only reachable for a logged-in viewer).
  const rows: OfferListRow[] = await withTradeAuctionSchemaFallback((withoutAuctions) =>
    withTradeWantableColumnFallback((withoutWantable) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          ...offerListFields(viewerUserId),
          acceptState: viewerUserId
            ? acceptStateFor(viewerUserId, withoutAuctions)
            : sql<TradeCanAccept | null>`NULL`,
        })
        .from(tradeOffersTable)
        .leftJoin(offeredStreamerMeta, eq(offeredStreamerMeta.id, tradeOffersTable.offered_streamer_id))
        .leftJoin(wantedStreamerMeta, eq(wantedStreamerMeta.id, tradeOffersTable.wanted_streamer_id))
        .leftJoin(offererMeta, eq(offererMeta.id, tradeOffersTable.offerer_user_id))
        .leftJoin(acceptorMeta, eq(acceptorMeta.id, tradeOffersTable.accepted_by_user_id))
        .where(and(...conditionsFor(withoutWantable)))
        .orderBy(desc(tradeOffersTable.created_at), desc(tradeOffersTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade:list-open",
    { idempotent: true },
  )));

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    offers: await maskOfferListCards(
      pageRows.map((row) => toOfferDto(row, "board")),
      rows[0]?.viewerUserId ?? null,
    ),
    page: input.page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
}

/**
 * SQL predicate: `streamerColumn` is one of the collections the viewer owns.
 * The definition itself lives in collected-streamers.ts so the hub's
 * collection sections and the expand API cannot drift apart (#2079).
 */
function placementIsCollected(streamerColumn: AnyColumn, twitchUserId: string) {
  return sql<boolean>`${qualifiedColumn(streamerColumn)} IN ${collectedStreamerIdsSubquery(twitchUserId)}`;
}

type CollectionOfferRow = OfferListRow & {
  placement: JoinedStreamer;
  placementStreamerId: string;
  rn: number;
  total: number;
  /** MAX(timestamptz): raw SQL bypasses the column decoder (see toIsoTimestamp). */
  latestCreatedAt: string | Date;
};

/**
 * ハブのコレクション別出品一覧 (#2079)。
 *
 * 設計上の要点:
 *
 * 1. 出品とオークションでそれぞれ1クエリ。配信者ごとに問い合わせる N+1 は
 *    作らない。`streamerId` を渡したときだけ、同じ関数を1配信者に絞って
 *    展開 API から呼ぶ（折りたたみ時と同じ条件・同じ DTO・同じマスク）。
 *
 * 2. クロスの出品は、渡す側・求める側のうち閲覧者が持っている配信者の
 *    掲示板に出す。両方持っていれば両方に出す。UNION ALL の2分岐で
 *    「offered 側の配置」と「wanted 側の配置」を作る。分岐2は
 *    is_cross_channel かつ offered <> wanted のときだけなので、同じ
 *    (offer, 配置先) が2回数えられることはない。各分岐の WHERE には
 *    所持コレクションの述語を必ず入れるため、持っていない配信者の下には
 *    行が作られない。
 *
 * 3. 各配置先の先頭 TRADE_COLLECTION_PREVIEW_SIZE 件は SQL で選ぶ。
 *    ROW_NUMBER() で並べ、外側の WHERE rn <= TRADE_COLLECTION_PREVIEW_SIZE
 *    で切る。TS 側で slice しないので、total（COUNT OVER）と先頭 N 件が
 *    必ず同じ集合から出る。latestCreatedAt（MAX OVER）は
 *    ハブのコレクション並び（最新の出品が新しい順）に使う。MAX/COUNT は
 *    外側の rn 絞り込みより前に評価されるため、6件目以降も含めた全件の
 *    値になる。
 *
 * 4. 可視性・ゲート・項目マスクは既存の listTradeOffers と同じ関数
 *    (openOfferConditions / acceptStateFor / toOfferDto / maskOfferListCards)
 *    をそのまま使う。UNION で新しい DTO を作らない。クロスの wanted 側の
 *    名前・画像は wanted カード自身の配信者設定で maskTradeCards が判定する。
 *
 * sort は「新着順」と「締切が近い順」だけ。締切はオークションにしか無いので、
 * 出品一覧は sort に関わらず created_at DESC のままにする（呼び出し側の
 * ending_soon は無視する）。レアリティ順はカスタムレアリティ (#2029) に
 * 全体共通の順序が無いため作らない。
 */
export async function listTradeOffersByCollection(input: {
  twitchUserId: string;
  /** undefined: 所持する全コレクションの先頭 TRADE_COLLECTION_PREVIEW_SIZE 件。 */
  streamerId?: string;
  /** streamerId 指定時のみ使う（1始まり）。 */
  page?: number;
}): Promise<TradeCollectionOfferGroup[]> {
  const viewerUserId = viewerUserIdOf(input.twitchUserId);
  const page = input.page ?? 1;
  const offset = (page - 1) * TRADE_PAGE_SIZE;

  const rows: CollectionOfferRow[] = await withTradeAuctionSchemaFallback((withoutAuctions) =>
    withTradeWantableColumnFallback((withoutWantable) => withDbRetry(
    async () => {
      const { db } = await getDb();
      const conditions = openOfferConditions(viewerUserId, withoutWantable);

      // 分岐1: offered 側が所持コレクション（in-channel も cross も含む）。
      const offeredPlacement = db
        .select({
          offerId: tradeOffersTable.id,
          placementStreamerId: tradeOffersTable.offered_streamer_id,
          createdAt: tradeOffersTable.created_at,
        })
        .from(tradeOffersTable)
        .where(and(
          ...conditions,
          placementIsCollected(tradeOffersTable.offered_streamer_id, input.twitchUserId),
          // Push the single-collection filter below the window so expanding
          // one collection does not rank every collection first.
          ...(input.streamerId
            ? [eq(tradeOffersTable.offered_streamer_id, input.streamerId)]
            : []),
        ));

      // 分岐2: cross の wanted 側が所持コレクション。offered 側も所持して
      // いる場合は分岐1と両方に出る（要件どおり両方の下に表示）。
      const wantedPlacement = db
        .select({
          offerId: tradeOffersTable.id,
          placementStreamerId: tradeOffersTable.wanted_streamer_id,
          createdAt: tradeOffersTable.created_at,
        })
        .from(tradeOffersTable)
        .where(and(
          ...conditions,
          eq(tradeOffersTable.is_cross_channel, true),
          ne(tradeOffersTable.wanted_streamer_id, tradeOffersTable.offered_streamer_id),
          placementIsCollected(tradeOffersTable.wanted_streamer_id, input.twitchUserId),
          ...(input.streamerId
            ? [eq(tradeOffersTable.wanted_streamer_id, input.streamerId)]
            : []),
        ));

      const placed = offeredPlacement
        .unionAll(wantedPlacement)
        .as("placed_collection_offers");

      // 分岐をまたいだ後に順位と件数を付ける。ORDER BY の第2キー id で
      // 同時刻でも順位が決定的になる。
      const ranked = db
        .select({
          offerId: placed.offerId,
          placementStreamerId: placed.placementStreamerId,
          rn: sql<number>`row_number() OVER (
            PARTITION BY ${placed.placementStreamerId}
            ORDER BY ${placed.createdAt} DESC, ${placed.offerId} DESC
          )`.mapWith(Number).as("rn"),
          total: sql<number>`count(*) OVER (
            PARTITION BY ${placed.placementStreamerId}
          )`.mapWith(Number).as("total"),
          // 生 SQL は Drizzle の列デコーダを通らない。実値は Date になりうる
          // ため string | Date とし、DTO へ渡す前に toIsoTimestamp でそろえる。
          latestCreatedAt: sql<string | Date>`max(${placed.createdAt}) OVER (
            PARTITION BY ${placed.placementStreamerId}
          )`.as("latestCreatedAt"),
        })
        .from(placed)
        .as("ranked_collection_offers");

      const rankedConditions = input.streamerId
        ? [
          eq(ranked.placementStreamerId, input.streamerId),
          // 2ページ目以降は rn をページ範囲に絞る。
          ...(page > 1 ? [gt(ranked.rn, offset)] : []),
          lte(ranked.rn, offset + TRADE_PAGE_SIZE),
        ]
        : [lte(ranked.rn, TRADE_COLLECTION_PREVIEW_SIZE)];

      return db
        .select({
          ...offerListFields(viewerUserId),
          acceptState: viewerUserId
            ? acceptStateFor(viewerUserId, withoutAuctions)
            : sql<TradeCanAccept | null>`NULL`,
          placement: streamerSummaryFields(placementStreamerMeta),
          placementStreamerId: ranked.placementStreamerId,
          rn: ranked.rn,
          total: ranked.total,
          latestCreatedAt: ranked.latestCreatedAt,
        })
        .from(ranked)
        .innerJoin(tradeOffersTable, eq(tradeOffersTable.id, ranked.offerId))
        .leftJoin(offeredStreamerMeta, eq(offeredStreamerMeta.id, tradeOffersTable.offered_streamer_id))
        .leftJoin(wantedStreamerMeta, eq(wantedStreamerMeta.id, tradeOffersTable.wanted_streamer_id))
        .leftJoin(offererMeta, eq(offererMeta.id, tradeOffersTable.offerer_user_id))
        .leftJoin(acceptorMeta, eq(acceptorMeta.id, tradeOffersTable.accepted_by_user_id))
        .leftJoin(
          placementStreamerMeta,
          eq(placementStreamerMeta.id, ranked.placementStreamerId),
        )
        .where(and(...rankedConditions))
        .orderBy(asc(ranked.placementStreamerId), asc(ranked.rn));
    },
    "trade:list-collections-offers",
    { idempotent: true },
  )));

  // Name/image/number are masked in ONE maskTradeCards() call for every
  // collection on this page, exactly like listTradeOffers. The mapping keeps
  // row order.
  const masked = await maskOfferListCards(
    rows.map((row) => toOfferDto(row, "board")),
    rows[0]?.viewerUserId ?? null,
  );

  const groups = new Map<string, TradeCollectionOfferGroup>();
  rows.forEach((row, index) => {
    const streamer = toStreamerSummary(row.placement);
    if (!streamer) return;
    let group = groups.get(streamer.id);
    if (!group) {
      group = {
        streamer,
        offers: [],
        total: Number(row.total),
        latestCreatedAt: toIsoTimestamp(row.latestCreatedAt),
      };
      groups.set(streamer.id, group);
    }
    group.offers.push(masked[index]);
  });
  return [...groups.values()];
}

/**
 * The viewer's own trade history: offers they listed plus offers they
 * accepted. Unlike the public board this is NOT filtered by visibility,
 * is_active or trade_enabled: the viewer chose / received both cards, and
 * they must always be able to find (and cancel) their own open listings.
 */
export async function listMyTradeOffers(
  twitchUserId: string,
  options: { status?: TradeOfferStatus; page?: number } = {},
) {
  const page = options.page ?? 1;
  const viewerUserId = viewerUserIdOf(twitchUserId);

  // An unknown user resolves to NULL and therefore matches no row (the
  // previous explicit "user not found → empty page" branch).
  const participantCondition = or(
    eq(tradeOffersTable.offerer_user_id, viewerUserId),
    eq(tradeOffersTable.accepted_by_user_id, viewerUserId),
  )!;
  const where = options.status
    ? and(participantCondition, eq(tradeOffersTable.status, options.status))
    : participantCondition;

  // Bounded page (LIMIT pageSize+1 for hasMore). History grows without bound
  // for active traders, so an unpaged SELECT would eventually exceed Worker
  // CPU/memory limits. Single statement (previously user lookup → page →
  // metadata, 3 sequential round trips); `tradeableState` rides along in the
  // same SELECT list as one boolean expression, so the flag costs no extra
  // round trip.
  const offset = (page - 1) * TRADE_PAGE_SIZE;
  const rows: OfferListRow[] = await withTradeWantableColumnFallback((withoutWantable) =>
    withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          ...offerListFields(viewerUserId),
          tradeableState: tradeableStateFor(withoutWantable),
        })
        .from(tradeOffersTable)
        .leftJoin(offeredStreamerMeta, eq(offeredStreamerMeta.id, tradeOffersTable.offered_streamer_id))
        .leftJoin(wantedStreamerMeta, eq(wantedStreamerMeta.id, tradeOffersTable.wanted_streamer_id))
        .leftJoin(offererMeta, eq(offererMeta.id, tradeOffersTable.offerer_user_id))
        .leftJoin(acceptorMeta, eq(acceptorMeta.id, tradeOffersTable.accepted_by_user_id))
        .where(where)
        .orderBy(desc(tradeOffersTable.created_at), desc(tradeOffersTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade:list-mine",
    { idempotent: true },
  ));

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  // /mine is not exempt from the item mask. The row exemption below (the viewer
  // chose/received these cards, so no visibility WHERE) is about which offers
  // exist for them; name/image are only returned when the viewer owns that card
  // NOW or the channel reveals the item. In particular a completed offer does
  // not imply current ownership (the copy may have been traded on), so a card
  // the viewer gave away follows the same mask (#N-only when the name is
  // private) as any other unowned card.
  const offers = await maskOfferListCards(
    pageRows.map((row) => ({
      ...toOfferDto(row, "mine"),
      mineRole:
        row.offer.offerer_user_id === row.viewerUserId
          ? "offerer" as const
          : "acceptor" as const,
      tradeable: row.offer.status === "open" && row.tradeableState === true,
    })),
    rows[0]?.viewerUserId ?? null,
  );
  return {
    offers,
    page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
}

export async function cancelTradeOffer(input: {
  twitchUserId: string;
  tradeOfferId: string;
}): Promise<
  | { kind: "ok"; id: string }
  | { kind: "error"; code: "TRADE_OFFER_NOT_FOUND" | "TRADE_OFFER_NOT_OPEN" }
> {
  // The owner check resolves the user inside the CAS (previously a separate
  // users lookup first). An unknown user matches no row and ends in the same
  // TRADE_OFFER_NOT_FOUND as before via the state read below.
  const ownerUserId = viewerUserIdOf(input.twitchUserId);

  const updated = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .update(tradeOffersTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(tradeOffersTable.id, input.tradeOfferId),
            eq(tradeOffersTable.offerer_user_id, ownerUserId),
            eq(tradeOffersTable.status, "open"),
          ),
        )
        .returning({ id: tradeOffersTable.id });
    },
    "trade:cancel",
    // The CAS is idempotent in state but a retry after success returns zero rows,
    // so do not let the DB retry layer turn a successful first COMMIT into 409.
  );
  if (updated[0]) {
    return { kind: "ok", id: updated[0].id };
  }

  const ownRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ status: tradeOffersTable.status })
        .from(tradeOffersTable)
        .where(
          and(
            eq(tradeOffersTable.id, input.tradeOfferId),
            eq(tradeOffersTable.offerer_user_id, ownerUserId),
          ),
        )
        .limit(1);
    },
    "trade:cancel-state",
    { idempotent: true },
  );
  return ownRows[0]
    ? { kind: "error", code: "TRADE_OFFER_NOT_OPEN" }
    : { kind: "error", code: "TRADE_OFFER_NOT_FOUND" };
}

export type TradeAcceptRpcError =
  | "TRADE_OFFER_NOT_FOUND"
  | "OFFER_NOT_OPEN"
  | "SELF_ACCEPT_FORBIDDEN"
  | "OFFER_INVALID"
  | "TRADE_DISABLED"
  | "CARD_NOT_OWNED"
  // #1789: the offer's wanted_quantity differs from the quantity the viewer
  // was shown and agreed to (stale client). Nothing was transferred.
  | "QUANTITY_MISMATCH"
  // #1790 (20261014100000): the wanted card's cards.trade_wantable is false.
  // The offer stays open (it comes back if the streamer switches the card
  // back). Nothing was transferred.
  | "WANTED_CARD_NOT_WANTABLE"
  // 20261124000000: the offered card's streamer's exchange-target list does
  // not include the wanted card. The offer stays open (it comes back if the
  // streamer lifts the rule). Nothing was transferred.
  | "WANTED_CARD_NOT_ALLOWED_FOR_OFFERED";

// テストが旧アプリ（ロールバック時）の既知コード集合との差分を固定できるよう公開する
// （#1801。実行コードはこの Set を参照しない追加の経路を作らないこと）。
export const TRADE_ACCEPT_RPC_ERRORS = new Set<TradeAcceptRpcError>([
  "TRADE_OFFER_NOT_FOUND",
  "OFFER_NOT_OPEN",
  "SELF_ACCEPT_FORBIDDEN",
  "OFFER_INVALID",
  "TRADE_DISABLED",
  "CARD_NOT_OWNED",
  "QUANTITY_MISMATCH",
  "WANTED_CARD_NOT_WANTABLE",
  "WANTED_CARD_NOT_ALLOWED_FOR_OFFERED",
]);

export type TradeAcceptRpcResult = {
  success: boolean;
  error?: TradeAcceptRpcError;
  tradeOfferId?: string;
  receivedUserCardId?: string;
  givenUserCardId?: string;
  offeredCardSnapshot?: unknown;
  wantedCardSnapshot?: unknown;
  completedAt?: string;
  idempotentReplay?: boolean;
};

function isValidTradeAcceptRpcResult(
  value: unknown,
  expectedTradeOfferId: string,
): value is TradeAcceptRpcResult {
  if (!value || typeof value !== "object") return false;

  const result = value as Record<string, unknown>;
  if (typeof result.success !== "boolean") return false;

  if (result.success === false) {
    return (
      typeof result.error === "string"
      && TRADE_ACCEPT_RPC_ERRORS.has(result.error as TradeAcceptRpcError)
    );
  }

  return (
    result.error === undefined
    // #2061: PostgreSQL prints uuid values in lowercase, while the client may
    // send the uppercase spelling that isCanonicalUuid also accepts. The RPC
    // may already have committed the ownership transfer at this point, so an
    // exact-string mismatch must not reject a valid success as a 500. Compare
    // only the case of the same id; every other field is validated as before.
    && typeof result.tradeOfferId === "string"
    && result.tradeOfferId.toLowerCase() === expectedTradeOfferId.toLowerCase()
    && typeof result.receivedUserCardId === "string"
    && isCanonicalUuid(result.receivedUserCardId)
    && typeof result.givenUserCardId === "string"
    && isCanonicalUuid(result.givenUserCardId)
    && Object.prototype.hasOwnProperty.call(result, "offeredCardSnapshot")
    && Object.prototype.hasOwnProperty.call(result, "wantedCardSnapshot")
    && typeof result.completedAt === "string"
    && !Number.isNaN(Date.parse(result.completedAt))
    && typeof result.idempotentReplay === "boolean"
  );
}

/**
 * Calls the 4-argument accept_trade_offer (#1789), which transfers only when
 * `expectedQuantity` — the quantity the viewer was shown and agreed to —
 * equals the offer's wanted_quantity (compare-and-set).
 */
async function callAcceptTradeOfferRpc(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
  expectedQuantity: number;
}): Promise<TradeAcceptRpcResult> {
  const { sql: query } = await getDb();
  const rows = await query<Array<{ result: unknown }>>`
      SELECT public.accept_trade_offer(
        ${input.twitchUserId},
        ${input.tradeOfferId}::uuid,
        ${input.requestId}::uuid,
        ${input.expectedQuantity}::smallint
      ) AS result
    `;
  const result = rows[0]?.result;
  if (!isValidTradeAcceptRpcResult(result, input.tradeOfferId)) {
    throw new Error("accept_trade_offer returned an invalid response");
  }
  return result;
}

export function waitForTradeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejections decided by the API layer before the RPC is called. */
export type TradeAcceptPrecheckError = "TRADE_OFFER_UNAVAILABLE";

/**
 * API-layer acceptance checks for the visibility / is_active product rules.
 *
 * These rules are enforced here instead of inside accept_trade_offer() because
 * changing the RPC requires a PlanetScale migration and its deploy window
 * (app and migration roll out independently); the RPC keeps owning every
 * ownership/locking invariant.
 *
 * Ordering (mirrors the RPC, §4.4 step 3): the idempotent replay is decided
 * FIRST. Only an offer that is still `open` is validated here; a completed
 * offer — in particular a replay (same acceptor + same accepted_request_id),
 * whose acceptor may already have given the received card away or whose card
 * may have been deactivated since — is passed to the RPC untouched so the
 * original success result is returned. Likewise every case the RPC already
 * classifies (not found, not open, self-accept, deleted card definition which
 * the RPC also cancels, unknown user) is delegated so those contracts stay
 * byte-for-byte identical.
 *
 * Race note: the offer may change between this read and the RPC (a card gets
 * deactivated or a channel hides unowned cards a few ms later). Accepting in
 * that window only transfers two existing copies between the two consenting
 * users — nothing is newly issued and the acceptor was already entitled to see
 * the offer when the check ran — so the impact is negligible compared to the
 * cost of a migration. The RPC still re-validates trade_enabled and ownership
 * under row locks.
 */
type TradeAcceptPrecheck = {
  error: TradeAcceptPrecheckError | null;
  /** Resolved users.id of the acceptor (NULL for an unknown twitch user). */
  viewerUserId: string | null;
  /**
   * Card ids of the offer row (NULL when the definition was deleted). They are
   * used after a successful RPC to apply the name/image/number mask without a
   * second offer lookup.
   */
  offeredCardId: string | null;
  wantedCardId: string | null;
};

async function precheckTradeAccept(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
}): Promise<TradeAcceptPrecheck> {
  // The acceptor id is resolved inside the same statement (previously a
  // separate users lookup round trip before this read).
  const acceptorUserId = viewerUserIdOf(input.twitchUserId);
  const rows = await withTradeWantableColumnFallback((withoutWantable) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          acceptorUserId: sql<string | null>`${acceptorUserId}`,
          status: tradeOffersTable.status,
          offererUserId: tradeOffersTable.offerer_user_id,
          acceptedByUserId: tradeOffersTable.accepted_by_user_id,
          acceptedRequestId: tradeOffersTable.accepted_request_id,
          offeredCardId: tradeOffersTable.offered_card_id,
          wantedCardId: tradeOffersTable.wanted_card_id,
          offeredActive: cardIsActive(tradeOffersTable.offered_card_id),
          wantedActive: cardIsActive(tradeOffersTable.wanted_card_id),
          // #1790: the board hides offers whose wanted card can no longer be
          // requested, so a direct API call must not complete one either.
          // accept_trade_offer re-checks it (WANTED_CARD_NOT_WANTABLE); this
          // read only turns the common case into the board's
          // "offer unavailable" answer without calling the RPC.
          wantedWantable: cardIsWantable(tradeOffersTable.wanted_card_id, withoutWantable),
          // The same for the offered card's streamer's exchange-target list
          // (accept_trade_offer: WANTED_CARD_NOT_ALLOWED_FOR_OFFERED).
          wantedAllowed: wantedAllowedForOffered(
            tradeOffersTable.offered_card_id,
            tradeOffersTable.wanted_card_id,
          ),
          // The wanted card needs no visibility check: the acceptor must own
          // a copy of it to pay, and owning a copy makes it visible.
          offeredVisible: cardVisibleTo(
            tradeOffersTable.offered_card_id,
            acceptorUserId,
          ),
        })
        .from(tradeOffersTable)
        .where(eq(tradeOffersTable.id, input.tradeOfferId))
        .limit(1);
    },
    "trade:accept-precheck",
    { idempotent: true },
  ));
  const offer = rows[0];
  const empty: TradeAcceptPrecheck = {
    error: null,
    viewerUserId: null,
    offeredCardId: null,
    wantedCardId: null,
  };
  if (!offer) return empty;
  // Unknown acceptor: delegated to the RPC, which classifies it (unchanged).
  const acceptorId = offer.acceptorUserId;
  if (!acceptorId) return empty;
  const ids = { offeredCardId: offer.offeredCardId, wantedCardId: offer.wantedCardId };
  const base: TradeAcceptPrecheck = { error: null, viewerUserId: acceptorId, ...ids };

  // Replay first (explicit for readability; behaviorally it is also covered
  // by the `status !== "open"` delegation right below, since a replay is
  // always `completed`).
  const isReplay =
    offer.status === "completed"
    && offer.acceptedByUserId === acceptorId
    && offer.acceptedRequestId === input.requestId;
  if (isReplay) return base;
  if (offer.status !== "open") return base;
  if (offer.offererUserId === acceptorId) return base;
  if (!offer.offeredCardId || !offer.wantedCardId) return base;

  // One code for "inactive", "not visible" and "wanted card not wantable"
  // (#1790): the board already hides all of these offers, and distinguishing
  // them would tell a non-owner whether a hidden card is merely secret or
  // retired.
  if (
    offer.offeredActive !== true
    || offer.wantedActive !== true
    || offer.wantedWantable !== true
    || offer.wantedAllowed !== true
    || offer.offeredVisible !== true
  ) {
    return { ...base, error: "TRADE_OFFER_UNAVAILABLE" };
  }
  return base;
}

/**
 * Issue #724: accept_trade_offer() owns the transaction and row locks. The API
 * layer only retries SQLSTATE 40P01 once with the SAME requestId. The RPC checks
 * its idempotency replay before mutable validation, so a retry after a commit
 * cannot transfer ownership twice. The visibility / is_active precheck runs
 * once before the first RPC attempt (see precheckTradeAccept for ordering).
 */
export async function acceptTradeOffer(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
  /** wantedQuantity the viewer agreed to (validated by the API route). Default 1. */
  expectedQuantity?: number;
}): Promise<
  | TradeAcceptRpcResult
  | { success: false; error: "TRADE_BUSY" | TradeAcceptPrecheckError }
> {
  const precheck = await precheckTradeAccept(input);
  if (precheck.error) {
    return { success: false, error: precheck.error };
  }
  const rpcInput = { ...input, expectedQuantity: input.expectedQuantity ?? 1 };

  let result: TradeAcceptRpcResult;
  try {
    result = await callAcceptTradeOfferRpc(rpcInput);
  } catch (error) {
    if (getSqlState(error) !== "40P01") throw error;
    // Short full-jitter delay. One retry only: sustained deadlock pressure
    // should be surfaced to the caller instead of becoming an unbounded Worker
    // task.
    await waitForTradeRetry(Math.floor(Math.random() * 51));
    try {
      result = await callAcceptTradeOfferRpc(rpcInput);
    } catch (retryError) {
      if (getSqlState(retryError) === "40P01") {
        return { success: false, error: "TRADE_BUSY" };
      }
      throw retryError;
    }
  }

  // A failed RPC result carries no snapshots and must stay byte-for-byte
  // unchanged (the error contract is pinned by trade-accept tests/routes).
  if (!result.success) return result;

  // The RPC returns the offer's full snapshot columns; the route spreads this
  // object into the response (`...result`), so the name/image/number mask must
  // happen HERE, not in the route. The card ids come from the precheck
  // statement (no extra offer read); an unknown id (deleted definition) is
  // denied. The mask runs after the ownership transfer, i.e. "owned now" is
  // the post-trade state: the received card's name/image becomes visible, a
  // card the acceptor gave away only keeps them when the channel reveals the
  // item (otherwise the DTO carries #N only, requirement 9).
  const offeredSnapshot = normalizeSnapshot(result.offeredCardSnapshot);
  const wantedSnapshot = normalizeSnapshot(result.wantedCardSnapshot);
  let masked: [TradeCardSnapshot, TradeCardSnapshot];
  try {
    const snapshots = await maskTradeCards(
      [
        { cardId: precheck.offeredCardId, snapshot: offeredSnapshot },
        { cardId: precheck.wantedCardId, snapshot: wantedSnapshot },
      ],
      precheck.viewerUserId,
    );
    masked = [snapshots[0], snapshots[1]];
  } catch {
    // The RPC already committed the transfer: a failure of the follow-up
    // visibility read must not turn a completed trade into a 500 (the route
    // treats the audit lookup the same way). Fail CLOSED: blank both names and
    // images rather than echo an item that could not be proven visible.
    masked = [
      { ...offeredSnapshot, name: "", imageUrl: null, collectionNumber: null },
      { ...wantedSnapshot, name: "", imageUrl: null, collectionNumber: null },
    ];
  }
  const [offeredCard, wantedCard] = masked;
  return { ...result, offeredCardSnapshot: offeredCard, wantedCardSnapshot: wantedCard };
}

/**
 * Audit metadata for successful ownership transfer. This read is deliberately
 * outside the RPC transaction: it is observability only and must never affect
 * the committed trade result.
 *
 * `givenUserCardIds` (#1792 item 2): accept_trade_offer returns only the
 * OLDEST of the N copies the acceptor gave (`givenUserCardId`), and returning
 * the whole set would need a new migration. The transfer sets
 * `user_cards.obtained_at = now()` on every moved copy and
 * `trade_offers.completed_at = now()` in the same transaction, so right after
 * commit the offerer's copies of the wanted card whose obtained_at equals the
 * offer's completed_at are exactly the copies that were given. This is a
 * best-effort reconstruction, not a stored record: once the offerer trades
 * those copies on again their obtained_at changes, so a later idempotent
 * replay can see fewer ids. Callers must therefore treat the list as
 * trustworthy only when its length equals the agreed quantity.
 * One statement: the LEFT JOIN yields one row per copy (or a single row with a
 * NULL copy), so no extra round trip is added to the accept request.
 */
export async function getTradeOfferAuditParticipants(tradeOfferId: string): Promise<{
  offererTwitchUserId: string | null;
  givenUserCardIds: string[];
}> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          offererTwitchUserId: usersTable.twitch_user_id,
          givenUserCardId: userCardsTable.id,
        })
        .from(tradeOffersTable)
        .innerJoin(usersTable, eq(usersTable.id, tradeOffersTable.offerer_user_id))
        .leftJoin(
          userCardsTable,
          and(
            eq(userCardsTable.user_id, tradeOffersTable.offerer_user_id),
            eq(userCardsTable.card_id, tradeOffersTable.wanted_card_id),
            eq(userCardsTable.obtained_at, tradeOffersTable.completed_at),
          ),
        )
        .where(eq(tradeOffersTable.id, tradeOfferId))
        .orderBy(asc(userCardsTable.id));
    },
    "trade:accept-audit-participants",
    { idempotent: true },
  );
  return {
    offererTwitchUserId: rows[0]?.offererTwitchUserId ?? null,
    givenUserCardIds: rows.flatMap((row) => (row.givenUserCardId ? [row.givenUserCardId] : [])),
  };
}


// =============================================================================
// Server helpers for the viewer trade UI (#726/#727)
//
// These are called directly from server components (no new public API). Every
// helper applies the visibility rule documented at the top of this file in
// SQL, so card names/images that the viewer is not entitled to see never leave
// the database layer.
// =============================================================================

export type TradeBoardStreamer = TradeStreamerSummary & {
  tradeEnabled: boolean;
  crossChannelTradeEnabled: boolean;
  /**
   * true when UNOWNED cards exist on the trade board at all, i.e. the viewer
   * can want a card they do not own yet (streamers.show_unowned_cards). This
   * is the row-level rule (cardVisibleTo): when false, unowned cards are not
   * tradeable and viewers can only trade towards cards they already own.
   * Whether the NAME/IMAGE of those rows is shown is reported separately:
   * a true here with both reveal flags false is the "#N only" board.
   */
  revealsUnownedCards: boolean;
  /**
   * true when the NAME of an unowned card is revealed, i.e. the resolved
   * name flag of resolveUnownedCardVisibility (show_unowned_cards + the
   * item-level name setting, with the deploy-window/legacy rules). This is
   * the same rule as cardNameVisibleTo, so the copy cannot contradict SQL.
   */
  revealsUnownedCardNames: boolean;
  /**
   * true when the IMAGE of an unowned card is revealed (resolved image flag,
   * same rule as cardImageVisibleTo). Independent of the name flag: a
   * name-only or image-only channel is a valid state.
   */
  revealsUnownedCardImages: boolean;
};

/**
 * Header / gate information for /trade/[streamerId]. Returns null for an
 * invalid or unknown id (callers render notFound()).
 *
 * trade_enabled / cross_channel_trade_enabled can be missing during the
 * app-vs-migration deploy window (#722). Like getStreamerById, the query is
 * retried without them through withLiveDirectorySettingsColumnFallback and
 * both flags fail closed to false.
 */
export async function getTradeBoardStreamer(
  streamerId: string,
): Promise<TradeBoardStreamer | null> {
  if (!isCanonicalUuid(streamerId)) return null;

  const rows = await withLiveDirectorySettingsColumnFallback((useSafeColumns) =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            twitchUsername: streamersTable.twitch_username,
            twitchDisplayName: streamersTable.twitch_display_name,
            twitchProfileImageUrl: streamersTable.twitch_profile_image_url,
            showUnownedCards: streamersTable.show_unowned_cards,
            showUnownedCardDetails: streamersTable.show_unowned_card_details,
            tradeEnabled: useSafeColumns
              ? sql<boolean>`FALSE`
              : sql<boolean>`${streamersTable.trade_enabled}`,
            crossChannelTradeEnabled: useSafeColumns
              ? sql<boolean>`FALSE`
              : sql<boolean>`${streamersTable.cross_channel_trade_enabled}`,
            // 項目別公開の新3列。デプロイ窓（safe columns）では列が存在しない
            // ため参照せず NULL にする。resolveUnownedCardVisibility は null を
            // 「取得できなかった」と解釈して旧 details から導出する（規則 b）。
            showUnownedCardName: useSafeColumns
              ? sql<boolean | null>`NULL`
              : streamersTable.show_unowned_card_name,
            showUnownedCardImage: useSafeColumns
              ? sql<boolean | null>`NULL`
              : streamersTable.show_unowned_card_image,
            showUnownedCardDescription: useSafeColumns
              ? sql<boolean | null>`NULL`
              : streamersTable.show_unowned_card_description,
          })
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .limit(1);
      },
      "trade:board-streamer",
      { idempotent: true },
    ),
  );
  const row = rows[0];
  if (!row) return null;
  // 行の可視性（revealsUnownedCards）と項目別公開（name/image）は別規則。
  // ここで TS resolver を通すことで、SQL 側（cardNameVisibleTo /
  // cardImageVisibleTo）と画面向けフラグが同じ規則を共有する。
  const unownedCardVisibility = resolveUnownedCardVisibility({
    show_unowned_cards: row.showUnownedCards,
    show_unowned_card_details: row.showUnownedCardDetails,
    show_unowned_card_name: row.showUnownedCardName,
    show_unowned_card_image: row.showUnownedCardImage,
    show_unowned_card_description: row.showUnownedCardDescription,
  });
  return {
    id: row.id,
    twitchUsername: row.twitchUsername,
    twitchDisplayName: row.twitchDisplayName,
    twitchProfileImageUrl: row.twitchProfileImageUrl,
    tradeEnabled: row.tradeEnabled === true,
    crossChannelTradeEnabled: row.crossChannelTradeEnabled === true,
    // 行の可視性 = マスタースイッチそのもの。未所持カードを欲しいカードに
    // できるか、という画面の説明とも一致する。
    revealsUnownedCards: row.showUnownedCards === true,
    // 名前・画像は resolver と同じ規則で個別に解決する。デプロイ窓では
    // 新3列が null になり、resolve の規則 b が旧 details から導出する。
    revealsUnownedCardNames: unownedCardVisibility.name,
    revealsUnownedCardImages: unownedCardVisibility.image,
  };
}

export type TradeableOwnedCopy = {
  userCardId: string;
  cardId: string;
  name: string;
  rarity: string;
  imageUrl: string | null;
  obtainedAt: string | null;
  /**
   * This exact copy is locked (#1791): listed in an open offer, an auction
   * listing or an active bid, so it cannot be listed or bid again. The field
   * name predates auctions and is kept for the listing UI.
   */
  isListed: boolean;
  /** Number of copies of the same card the viewer owns (listed included). */
  ownedCount: number;
};

/**
 * Step 1 of the listing flow: the viewer's copies of ACTIVE cards of one
 * channel, one entry per user_cards row. Inactive cards (including pack
 * completion reward cards) are excluded because they cannot be traded.
 */
export async function listTradeableOwnedCopies(
  twitchUserId: string,
  streamerId: string,
): Promise<TradeableOwnedCopy[]> {
  if (!isCanonicalUuid(streamerId)) return [];
  // One statement: the owner is resolved in SQL (unknown user → NULL → no
  // rows, the previous early return).
  const ownerUserId = viewerUserIdOf(twitchUserId);

  // #1791: isListed reads the copy locks, hence the auction-schema fallback.
  const rows = await withTradeAuctionSchemaFallback((withoutAuctions) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          userCardId: userCardsTable.id,
          cardId: userCardsTable.card_id,
          name: cardsTable.name,
          rarity: cardsTable.rarity,
          imageUrl: cardsTable.image_url,
          obtainedAt: userCardsTable.obtained_at,
          // Same predicate as the create-time ALREADY_LISTED check
          // (trade_copy_locked; see copyLockedExpr).
          isListed: copyLockedExpr(qualifiedColumn(userCardsTable.id), withoutAuctions),
          // Window count runs after WHERE, i.e. over this viewer's copies of
          // this channel's active cards. count(*) is bigint → string in
          // postgres.js, hence mapWith(Number).
          ownedCount: sql<number>`count(*) OVER (PARTITION BY ${userCardsTable.card_id})`
            .mapWith(Number),
        })
        .from(userCardsTable)
        .innerJoin(cardsTable, eq(cardsTable.id, userCardsTable.card_id))
        .where(
          and(
            eq(userCardsTable.user_id, ownerUserId),
            eq(cardsTable.streamer_id, streamerId),
            eq(cardsTable.is_active, true),
          ),
        )
        .orderBy(
          asc(cardsTable.rarity_order),
          asc(cardsTable.name),
          asc(cardsTable.id),
          asc(userCardsTable.obtained_at),
          asc(userCardsTable.id),
        );
    },
    "trade:tradeable-owned-copies",
    { idempotent: true },
  ));

  return rows.map((row) => ({
    userCardId: row.userCardId,
    cardId: row.cardId,
    name: row.name,
    rarity: row.rarity,
    imageUrl: row.imageUrl,
    obtainedAt: row.obtainedAt,
    isListed: row.isListed === true,
    ownedCount: Number(row.ownedCount),
  }));
}

export type WantableCard = {
  cardId: string;
  /** 名前非公開なら ""（表示は UI が #N で行う）。 */
  name: string;
  rarity: string;
  imageUrl: string | null;
  /**
   * 閲覧者に依存しない百科事典番号（#N）。コレクション画面と同じ番号表
   * （その配信者の全カード・無効化含む）から作る。
   */
  collectionNumber: number | null;
  /** The viewer owns ≥1 copy (listed copies included). */
  isOwned: boolean;
};

/**
 * Step 2 of the listing flow: active cards of one channel that the viewer may
 * ask for, excluding cards the streamer marked as not requestable
 * (cards.trade_wantable = false, #1790).
 *
 * 行の可視性は cardVisibleTo = 所持 OR show_unowned_cards。名前・画像は
 * 項目別公開に従ってこの関数でマスクする（名前非公開なら name=""、画像
 * 非公開なら imageUrl=null）。名前が非公開のカードも #N で選べるよう、
 * side channel になり得る名前順ではなく
 * 「rarity_order → collectionNumber → cardId」で並べる。
 */
export async function listWantableCards(
  twitchUserId: string | null,
  streamerId: string,
): Promise<WantableCard[]> {
  if (!isCanonicalUuid(streamerId)) return [];
  // One statement: an unknown twitch user resolves to NULL, which owns
  // nothing — the same result as the previous anonymous fallback.
  const viewerUserId = twitchUserId ? viewerUserIdOf(twitchUserId) : null;

  // #1790: cards whose streamer turned off "can be requested" are left out of
  // the choices. This is only a UI aid; createTradeOffer is authoritative.
  //
  // ORDER BY に name を入れない: 名前非公開カードが「名前順」という形で
  // 名前の大小関係を漏らすため。並びは rarity_order → 表示番号 → cardId を
  // JS で適用する（番号表は SQL の外で作るので、ここでは順序を付けない）。
  const rows = await withTradeWantableColumnFallback((withoutWantable) =>
    withUnownedCardItemColumnFallback((withoutItemColumns) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          cardId: cardsTable.id,
          name: cardsTable.name,
          rarity: cardsTable.rarity,
          rarityOrder: cardsTable.rarity_order,
          imageUrl: cardsTable.image_url,
          isOwned: viewerUserId
            ? sql<boolean>`EXISTS (
                SELECT 1
                FROM ${userCardsTable} AS wanted_owned
                WHERE wanted_owned.user_id = ${viewerUserId}
                  AND wanted_owned.card_id = ${qualifiedColumn(cardsTable.id)}
              )`
            : sql<boolean>`FALSE`,
          // The name/image rules ride along as scalar booleans instead of a
          // per-card follow-up query (this list is every active card of the
          // channel). Same fragments as maskTradeCards, so the picker and the
          // board cannot disagree.
          nameVisible: cardNameVisibleTo(cardsTable.id, viewerUserId, withoutItemColumns),
          imageVisible: cardImageVisibleTo(cardsTable.id, viewerUserId, withoutItemColumns),
        })
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            eq(cardsTable.is_active, true),
            cardIsWantable(cardsTable.id, withoutWantable),
            // 行レベル: 所持 OR show_unowned_cards。名前・画像は上の
            // nameVisible / imageVisible で個別に落とす。
            cardVisibleTo(cardsTable.id, viewerUserId),
          ),
        );
    },
    "trade:wantable-cards",
    { idempotent: true },
  )));

  // 番号表は「その配信者の全カード（無効化含む）」。表示中のアクティブ
  // カードだけから作ると、無効化カードの存在で番号がずれてコレクション画面と
  // 食い違う。1枚も返らないときは問い合わせない（空の画面で余分な
  // ラウンドトリップを作らない）。
  const numberMap = rows.length === 0
    ? new Map<string, number>()
    : await loadCollectionNumberMapsForStreamers([streamerId]);

  return [...rows]
    .sort((a, b) => {
      const rarityDiff =
        (a.rarityOrder ?? Number.MAX_SAFE_INTEGER)
        - (b.rarityOrder ?? Number.MAX_SAFE_INTEGER);
      if (rarityDiff !== 0) return rarityDiff;
      const aNumber = numberMap.get(a.cardId) ?? Number.MAX_SAFE_INTEGER;
      const bNumber = numberMap.get(b.cardId) ?? Number.MAX_SAFE_INTEGER;
      if (aNumber !== bNumber) return aNumber - bNumber;
      return a.cardId.localeCompare(b.cardId);
    })
    .map((row) => ({
      cardId: row.cardId,
      // deny-by-default: 解決済み name が TRUE のときだけ実値を返す。
      name: row.nameVisible === true ? row.name : "",
      rarity: row.rarity,
      imageUrl: row.imageVisible === true ? row.imageUrl : null,
      collectionNumber: numberMap.get(row.cardId) ?? null,
      isOwned: row.isOwned === true,
    }));
}

/**
 * Candidate partner channels for a cross-channel listing from the board of
 * `baseStreamerId`: channels where the viewer owns ≥1 active card copy AND that allow
 * trade + cross-channel trade. The base channel itself is excluded, and the
 * result is empty unless the base channel also allows cross-channel trade.
 *
 * Deliberately limited to channels the viewer already collects from: there is
 * no endpoint that enumerates every channel (product decision), and a channel
 * the viewer has never collected from would usually expose no wantable cards
 * anyway under the visibility rule.
 */
export async function listCrossTradePartnerStreamers(
  twitchUserId: string,
  baseStreamerId: string,
): Promise<TradeStreamerSummary[]> {
  if (!isCanonicalUuid(baseStreamerId)) return [];

  // One statement instead of base-streamer read → user lookup → partners.
  // The base gate is an EXISTS over the same columns (a disabled or unknown
  // base yields no rows) and the viewer is resolved in SQL (unknown → NULL →
  // owns nothing → no rows), matching the previous early returns. The owned
  // copy must be active so retired/completion-reward cards alone cannot make
  // a channel selectable when its cards cannot be traded (Refs #1749).
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: streamersTable.id,
          twitchUsername: streamersTable.twitch_username,
          twitchDisplayName: streamersTable.twitch_display_name,
          twitchProfileImageUrl: streamersTable.twitch_profile_image_url,
        })
        .from(streamersTable)
        .where(
          and(
            ne(streamersTable.id, baseStreamerId),
            eq(streamersTable.trade_enabled, true),
            eq(streamersTable.cross_channel_trade_enabled, true),
            sql`EXISTS (
              SELECT 1
              FROM ${streamersTable} AS base_streamer
              WHERE base_streamer.id = ${baseStreamerId}
                AND base_streamer.trade_enabled = TRUE
                AND base_streamer.cross_channel_trade_enabled = TRUE
            )`,
            sql`EXISTS (
              SELECT 1
              FROM ${userCardsTable} AS partner_owned
              INNER JOIN ${cardsTable} AS partner_card
                ON partner_card.id = partner_owned.card_id
              WHERE partner_owned.user_id = ${viewerUserIdOf(twitchUserId)}
                AND partner_card.streamer_id = ${qualifiedColumn(streamersTable.id)}
                AND partner_card.is_active = TRUE
            )`,
          ),
        )
        .orderBy(asc(streamersTable.twitch_display_name), asc(streamersTable.id));
    },
    "trade:cross-partner-streamers",
    { idempotent: true },
  ).catch((error: unknown) => {
    // Deploy window (#722): without the trade columns the base channel cannot
    // allow cross trade, so fail closed exactly like getTradeBoardStreamer's
    // FALSE fallback did for the former separate base read.
    if (isMissingTradeSettingsColumnError(error)) return [];
    throw error;
  });

  return rows.map((row) => ({
    id: row.id,
    twitchUsername: row.twitchUsername,
    twitchDisplayName: row.twitchDisplayName,
    twitchProfileImageUrl: row.twitchProfileImageUrl,
  }));
}
