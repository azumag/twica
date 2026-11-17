import {
  and,
  asc,
  desc,
  eq,
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
import {
  isMissingTradeSettingsColumnError,
  withLiveDirectorySettingsColumnFallback,
} from "@/lib/db/streamers-safe-columns";
import { isCanonicalUuid } from "@/lib/uuid-validation";

export const TRADE_PAGE_SIZE = 20;
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
  | "TRADE_SAME_CARD"
  | "TRADE_WANTED_CARD_UNAVAILABLE"
  // #1790: the wanted card is visible and active, but its streamer turned
  // off "can be requested in trades" (cards.trade_wantable = false).
  | "TRADE_WANTED_CARD_NOT_WANTABLE"
  // The copy the offerer wants to give belongs to a card definition that is
  // no longer active (including pack completion reward cards, which are kept
  // inactive by design). Inactive cards cannot enter the trade market.
  | "TRADE_OFFERED_CARD_INACTIVE";

// -----------------------------------------------------------------------------
// Card visibility rules (product decision for #715/#726/#727, refined by #2070)
//
// Visibility has TWO levels. They must not be conflated: #2070 adds a state in
// which the NAME is public but the IMAGE is not, and a single row-level EXISTS
// cannot express that.
//
// Name level (does the row exist for the viewer at all, i.e. may they see the
// name/rarity and trade for it?) — cardVisibleTo():
//
//   visible(card, viewer) ⇔ card.is_active
//     AND ( viewer owns ≥1 copy of card.id (listed copies included)
//           OR (card's streamer.show_unowned_cards
//               AND (card's streamer.show_unowned_card_details
//                    OR card's streamer.trade_unowned_card_names_visible)) )
//
// Image level (may the viewer receive imageUrl?) — cardImageVisibleTo():
//
//   imageVisible(card, viewer) ⇔ viewer owns ≥1 copy
//     OR (card's streamer.show_unowned_cards
//         AND card's streamer.show_unowned_card_details)
//
// The image rule deliberately does NOT include trade_unowned_card_names_visible
// (that setting only ever promises names/rarities) and does NOT require
// is_active: the row has already passed the name-level rule, and a card that
// was deactivated after the snapshot was taken still follows the same
// ownership/details rule. show_unowned_cards is kept as the outer gate in both
// rules: without it the collection page hides unowned cards entirely, so the
// trade board must not become a side channel that reveals their names.
//
// `show_unowned_card_details = false` makes the collection page render unowned
// cards as placeholders (SortedCardGrid `maskUnownedDetails`), i.e. the card
// NAME itself is secret for non-owners. The trade market must not become a
// side channel that reveals those names, so every query that can surface a
// card name to a viewer filters with these predicates *inside SQL*. Filtering
// after pagination would still leak through row counts / hasMore / filters.
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
// #2070 adds ONE deliberate extra round trip to every read that returns
// `TradeCardSnapshot`s: the image-level mask (maskTradeCardImages) has to ask
// the database which of the page's card ids the viewer may see the image of,
// because "owned now" cannot be derived from the snapshot. The mask is per
// page/function (one statement, not one per row), is skipped entirely when no
// snapshot has an imageUrl or no card id is known, and never drops rows (it
// only nulls imageUrl), so pagination / hasMore stay untouched. The budget per
// function is pinned by tests/unit/trade-service.test.ts and
// tests/unit/trade-auction-service.test.ts.
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
// Deploy window of streamers.trade_unowned_card_names_visible (#2070)
//
// Same independent-deploy problem as cards.trade_wantable above (#788): the new
// app can briefly run against a database without 20261117120000. The column is
// referenced only by the NAME-level rule (cardVisibleTo), so on 42703 for it
// every reader that uses that rule is retried with the legacy rule
// `show_unowned_cards AND show_unowned_card_details`. That is exact, not an
// approximation: before the migration no streamer can have the setting on (the
// column default is false and the old schema cannot store it), so ignoring the
// new column reproduces the old behaviour. Becomes a dead branch once the
// migration is applied everywhere.
//
// The IMAGE-level rule never references this column, so the mask query does
// not need this fallback either.
// -----------------------------------------------------------------------------

const TRADE_UNOWNED_CARD_NAMES_COLUMNS = ["trade_unowned_card_names_visible"] as const;

export async function withTradeUnownedCardNamesColumnFallback<T>(
  attempt: (withoutNameOnly: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isPgMissingNamedColumnError(error, TRADE_UNOWNED_CARD_NAMES_COLUMNS)) throw error;
    return attempt(true);
  }
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
 * `cardIdExpr` is visible to `viewerUserId` at the NAME level (see the rule
 * documented at the top of this file), including the is_active condition.
 * `viewerUserId` is an SQL expression producing users.id (viewerUserIdOf() or
 * an outer column); null means anonymous.
 *
 * `withoutNameOnly` renders the pre-#2070 rule (`show_unowned_cards AND
 * show_unowned_card_details`) and never references the new column. It exists
 * only for the deploy window (see withTradeUnownedCardNamesColumnFallback) and
 * is passed explicitly at every call site so a fallback cannot be forgotten
 * halfway through a statement.
 */
export function cardVisibleTo(
  cardIdExpr: AnyColumn,
  viewerUserId: SQL | null,
  withoutNameOnly = false,
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
  // show_unowned_cards stays the outer gate: a channel that hides unowned
  // cards in the collection must not reveal their names only on the board.
  // With details off, the new setting (trade-only) reveals names/rarities.
  const unownedRevealed = withoutNameOnly
    ? sql`(
        visible_streamer.show_unowned_cards = TRUE
        AND visible_streamer.show_unowned_card_details = TRUE
      )`
    : sql`(
        visible_streamer.show_unowned_cards = TRUE
        AND (
          visible_streamer.show_unowned_card_details = TRUE
          OR visible_streamer.trade_unowned_card_names_visible = TRUE
        )
      )`;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS visible_card
    INNER JOIN ${streamersTable} AS visible_streamer
      ON visible_streamer.id = visible_card.streamer_id
    WHERE visible_card.id = ${qualifiedColumn(cardIdExpr)}
      AND visible_card.is_active = TRUE
      AND (
        ${unownedRevealed}
        OR ${ownedByViewer}
      )
  )`;
}

/**
 * `cardIdExpr`'s IMAGE is visible to `viewerUserId` (see the rule at the top of
 * this file): the viewer owns a copy, OR the card's streamer reveals unowned
 * card details. It intentionally does NOT include is_active (row-level
 * visibility already decided that) and never includes the name-only setting.
 *
 * Same conventions as cardVisibleTo: literal inner aliases, the outer row only
 * through qualifiedColumn(). Inner table names are distinct from the ones in
 * cardVisibleTo so both fragments can appear in the same statement (e.g. the
 * listWantableCards SELECT list plus its WHERE).
 */
export function cardImageVisibleTo(cardIdExpr: AnyColumn, viewerUserId: SQL | null) {
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
        (
          image_streamer.show_unowned_cards = TRUE
          AND image_streamer.show_unowned_card_details = TRUE
        )
        OR ${ownedByViewer}
      )
  )`;
}

/**
 * One snapshot plus the card definition it was taken from. `cardId` is NULL
 * when the definition was deleted (ON DELETE SET NULL) or the id is unknown.
 */
export type TradeCardImageRef = {
  cardId: string | null;
  snapshot: TradeCardSnapshot;
};

/**
 * Read-time image mask shared by every service function that returns card
 * snapshots (#2070). Returns NEW snapshot objects (the inputs are never
 * mutated, and the stored JSONB snapshots stay complete: masking at write time
 * would deny the image to a user who obtains the card later).
 *
 * One query resolves "which of these card ids may this viewer see the image
 * of" (ownership OR full details; never the name-only setting, never
 * is_active). It is skipped when there is nothing to decide: no refs, every
 * snapshot already has imageUrl=null, or no ref has a card id. Deny-by-default:
 * a card id that is not in the result set (including a failed/unknown row) is
 * masked.
 *
 * The query deliberately does not use withTradeUnownedCardNamesColumnFallback:
 * cardImageVisibleTo never references streamers.trade_unowned_card_names_visible,
 * so this statement is valid both before and after 20261117120000.
 */
export async function maskTradeCardImages(
  refs: readonly TradeCardImageRef[],
  viewerUserId: string | null,
): Promise<TradeCardSnapshot[]> {
  const ids = [
    ...new Set(
      refs.flatMap((ref) =>
        ref.cardId !== null && ref.snapshot.imageUrl !== null ? [ref.cardId] : [],
      ),
    ),
  ];
  if (ids.length === 0) {
    // No image can be proven visible, so every non-null image in `refs`
    // belongs to a card whose id we do not know (or there is no image at
    // all). Copy the snapshots so callers never share mutable objects.
    return refs.map((ref) => ({ ...ref.snapshot, imageUrl: null }));
  }

  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ cardId: cardsTable.id })
        .from(cardsTable)
        .where(
          and(
            inArray(cardsTable.id, ids),
            // users.id is a plain string here (already resolved), so bind it
            // as an explicit uuid parameter; NULL reproduces the anonymous
            // rule.
            cardImageVisibleTo(
              cardsTable.id,
              viewerUserId === null ? null : sql`${viewerUserId}::uuid`,
            ),
          ),
        );
    },
    "trade:image-visibility",
    { idempotent: true },
  );
  const visibleCardIds = new Set(
    rows.flatMap((row) => (typeof row.cardId === "string" ? [row.cardId] : [])),
  );

  return refs.map((ref) => ({
    ...ref.snapshot,
    // A NULL card id can never be proven visible (deny-by-default).
    imageUrl:
      ref.cardId !== null && visibleCardIds.has(ref.cardId) ? ref.snapshot.imageUrl : null,
  }));
}

export type TradeCardSnapshot = {
  name: string;
  rarity: string;
  imageUrl: string | null;
};

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

function cardSnapshot(card: {
  name: string;
  rarity: string;
  image_url: string | null;
}): TradeCardSnapshot {
  return {
    name: card.name,
    rarity: card.rarity,
    imageUrl: card.image_url,
  };
}

export function normalizeSnapshot(value: unknown): TradeCardSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: "", rarity: "", imageUrl: null };
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
// `show_unowned_card_details = false` makes the collection page render unowned
// cards as placeholders, i.e. the card NAME / image is secret for non-owners.
// The trade API must not become a side channel that reveals them: creating an
// offer snapshots the wanted card's name/rarity/image into trade_offers and
// echoes it back, and the public board returns those snapshots. So a card is
// treated as non-existent for a viewer unless it passes cardVisibleTo
// (name level, which since #2070 also accepts the trade-only
// trade_unowned_card_names_visible setting). Each card is evaluated against ITS
// OWN streamer's settings, which keeps cross-channel offers safe.
//
// Rows and images are decided separately: passing cardVisibleTo only means the
// NAME may be shown. Every snapshot that leaves a service function goes through
// maskTradeCardImages, which applies cardImageVisibleTo to each card id, so
// the name-only setting never leaks imageUrl through a DTO, the POST response
// or the accept response.
//
// The check is done in SQL (a JOIN/WHERE condition) rather than by filtering
// rows after the fact, so hidden cards never reach the Worker and cannot leak
// through counts / hasMore / pagination either.
// -----------------------------------------------------------------------------

export async function createTradeOffer(input: {
  twitchUserId: string;
  offeredUserCardId: string;
  wantedCardId: string;
  /** 1..TRADE_MAX_WANTED_QUANTITY (validated by the API route). Default 1. */
  wantedQuantity?: number;
  requestId: string;
}): Promise<
  | { kind: "ok"; offer: TradeOfferRow; idempotentReplay: boolean }
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
  // already resolved), only during the windows. #2070 adds the
  // trade_unowned_card_names_visible window innermost.
  const wantedQuantity = input.wantedQuantity ?? 1;
  const runChecks = async (
    withoutWantable: boolean,
    withoutAuctions: boolean,
    withoutNameOnly: boolean,
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
              // filter) with the same predicate as the board, so the name and
              // image of a hidden card are never read into the Worker (the same
              // policy as listWantableCards). A hidden card joins to NULL and
              // falls into TRADE_WANTED_CARD_UNAVAILABLE below. The image
              // itself is masked later (maskTradeCardImages) so a name-only
              // card never echoes its imageUrl back.
              cardVisibleTo(
                createWantedCard.id,
                qualifiedColumn(usersTable.id),
                withoutNameOnly,
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
      (withoutWantable) => withTradeUnownedCardNamesColumnFallback(
        (withoutNameOnly) => runChecks(withoutWantable, withoutAuctions, withoutNameOnly),
      ),
    ),
  );
  const check = checkRows[0];
  if (!check) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }
  const userId = check.userId;

  // #2070: the snapshot columns stay complete in the database (a later owner
  // must still see the image), so the response row is masked at read time.
  // Every `ok` return below goes through this helper; the mask is one extra
  // statement and is skipped when both snapshots have no imageUrl.
  const maskOfferRow = async (offer: TradeOfferRow): Promise<TradeOfferRow> => {
    const [offeredCard, wantedCard] = await maskTradeCardImages(
      [
        { cardId: offer.offered_card_id, snapshot: normalizeSnapshot(offer.offered_card_snapshot) },
        { cardId: offer.wanted_card_id, snapshot: normalizeSnapshot(offer.wanted_card_snapshot) },
      ],
      userId,
    );
    return { ...offer, offered_card_snapshot: offeredCard, wanted_card_snapshot: wantedCard };
  };

  // Create idempotency is checked before mutable business validation. A client
  // retry after a successful commit must return the original offer even if a
  // channel setting changes between attempts.
  if (check.replay) {
    return { kind: "ok", offer: await maskOfferRow(check.replay), idempotentReplay: true };
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
    return { kind: "ok", offer: await maskOfferRow(offer), idempotentReplay: false };
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
      return { kind: "ok", offer: await maskOfferRow(byRequest), idempotentReplay: true };
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
  T extends typeof offeredStreamerMeta | typeof wantedStreamerMeta,
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
 * Read-time image mask for a page of offer DTOs (#2070): one statement for
 * both sides of every row, so a name-only channel never returns imageUrl while
 * the row itself (name/rarity/paging/hasMore) is untouched. The viewer id is
 * the one the page SELECT already resolved (NULL for anonymous/unknown), so no
 * extra users lookup is needed.
 */
async function maskOfferListImages(
  offers: TradeOfferDto[],
  viewerUserId: string | null,
): Promise<TradeOfferDto[]> {
  if (offers.length === 0) return offers;
  const masked = await maskTradeCardImages(
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

export async function listTradeOffers(input: {
  streamerId: string;
  scope: TradeScope;
  wantedCardId?: string;
  offeredCardId?: string;
  page: number;
  twitchUserId?: string;
}) {
  const viewerUserId = input.twitchUserId ? viewerUserIdOf(input.twitchUserId) : null;

  // Both sides must be revealed to the viewer. Own offers bypass only the
  // *reveal* rule (a channel switching show_unowned_* off later must not hide
  // the viewer's own listing, whose wanted card they chose themselves), not
  // the is_active / trade_enabled gates below: an offer with an inactive card
  // is not tradeable for anyone, exactly like a trade_enabled=false channel,
  // and stays reachable (cancellable) through /api/trades/mine.
  const bothSidesVisible = (withoutNameOnly: boolean) => and(
    cardVisibleTo(tradeOffersTable.offered_card_id, viewerUserId, withoutNameOnly),
    cardVisibleTo(tradeOffersTable.wanted_card_id, viewerUserId, withoutNameOnly),
  )!;
  const visibilityCondition = (withoutNameOnly: boolean) => {
    const visible = bothSidesVisible(withoutNameOnly);
    return viewerUserId
      ? or(eq(tradeOffersTable.offerer_user_id, viewerUserId), visible)!
      : visible;
  };

  // Every condition is part of the SQL WHERE clause so that LIMIT/OFFSET,
  // hasMore and the wantedCardId/offeredCardId filters are all computed over
  // the visible set only. Post-filtering a fetched page would let a client
  // infer hidden offers from short pages or hasMore=true with no rows.
  //
  // cardIsActive() covers a NULL card_id on its own: a card definition deleted
  // after the offer was created sets offered_card_id/wanted_card_id to NULL
  // (ON DELETE SET NULL, see 20260817100000_add_card_trading.sql), and then
  // `active_card.id = NULL` is never TRUE so the EXISTS is false. No separate
  // IS NOT NULL condition is needed (verified on real PostgreSQL by
  // tests/integration/trade-visibility-pg.test.ts).
  const conditions = [
    eq(tradeOffersTable.status, "open"),
    tradeEnabledGate(tradeOffersTable.offered_streamer_id),
    tradeEnabledGate(tradeOffersTable.wanted_streamer_id),
    cardIsActive(tradeOffersTable.offered_card_id),
    cardIsActive(tradeOffersTable.wanted_card_id),
  ];

  if (input.scope === "cross_channel") {
    conditions.push(
      eq(tradeOffersTable.is_cross_channel, true),
      or(
        eq(tradeOffersTable.offered_streamer_id, input.streamerId),
        eq(tradeOffersTable.wanted_streamer_id, input.streamerId),
      )!,
      crossEnabledGate(tradeOffersTable.offered_streamer_id),
      crossEnabledGate(tradeOffersTable.wanted_streamer_id),
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

  // Single statement (previously user lookup → page → metadata → canAccept,
  // i.e. 4 sequential round trips for a logged-in viewer).
  //
  // #1790: an offer whose wanted card was switched to "cannot be requested"
  // after listing is hidden for everyone, the offerer included — the same
  // treatment as an inactive card above (nobody can accept it; the offerer
  // finds it on /mine as not tradeable). It is not cancelled, so switching
  // the card back brings the offer back. The condition is added inside the
  // fallback closure because its SQL depends on the deploy-window shape.
  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  // #1791: canAccept reads the copy locks (acceptStateFor), hence the
  // outermost auction-schema fallback (only reachable for a logged-in viewer).
  const rows: OfferListRow[] = await withTradeAuctionSchemaFallback((withoutAuctions) =>
    withTradeWantableColumnFallback((withoutWantable) =>
    withTradeUnownedCardNamesColumnFallback((withoutNameOnly) =>
    withDbRetry(
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
        .where(and(
          ...conditions,
          // #2070: the name-level visibility depends on the deploy window, so
          // it is built inside the fallback closure (own offers bypass only
          // this reveal rule, exactly as before).
          visibilityCondition(withoutNameOnly),
          cardIsWantable(tradeOffersTable.wanted_card_id, withoutWantable),
        ))
        .orderBy(desc(tradeOffersTable.created_at), desc(tradeOffersTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade:list-open",
    { idempotent: true },
  ))));

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    offers: await maskOfferListImages(
      pageRows.map((row) => toOfferDto(row, "board")),
      rows[0]?.viewerUserId ?? null,
    ),
    page: input.page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
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
  // #2070: /mine is not exempt from the IMAGE rule. The row exemption below
  // (the viewer chose/received these cards, so no visibility WHERE) is about
  // which offers exist for them; an image is only returned when the viewer owns
  // that card NOW or the channel reveals details. In particular a completed
  // offer does not imply current ownership (the copy may have been traded on).
  const offers = await maskOfferListImages(
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
  | "WANTED_CARD_NOT_WANTABLE";

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
   * used after a successful RPC to apply the image mask (#2070) without a
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
  const rows = await withTradeWantableColumnFallback((withoutWantable) =>
    withTradeUnownedCardNamesColumnFallback((withoutNameOnly) => withDbRetry(
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
          // The wanted card needs no visibility check: the acceptor must own
          // a copy of it to pay, and owning a copy makes it visible.
          offeredVisible: cardVisibleTo(
            tradeOffersTable.offered_card_id,
            acceptorUserId,
            withoutNameOnly,
          ),
        })
        .from(tradeOffersTable)
        .where(eq(tradeOffersTable.id, input.tradeOfferId))
        .limit(1);
    },
    "trade:accept-precheck",
    { idempotent: true },
  )));
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

  // #2070: the RPC returns the offer's full snapshot columns; the route spreads
  // this object into the response (`...result`), so the image mask must happen
  // HERE, not in the route. The card ids come from the precheck statement (no
  // extra offer read); an unknown id (deleted definition) is denied. The mask
  // runs after the ownership transfer, i.e. "owned now" is the post-trade
  // state: the received card's image becomes visible, a card the acceptor gave
  // away only keeps its image when the channel reveals details.
  const offeredSnapshot = normalizeSnapshot(result.offeredCardSnapshot);
  const wantedSnapshot = normalizeSnapshot(result.wantedCardSnapshot);
  let masked: [TradeCardSnapshot, TradeCardSnapshot];
  try {
    const snapshots = await maskTradeCardImages(
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
    // treats the audit lookup the same way). Fail CLOSED: hide both images
    // rather than echo an image that could not be proven visible.
    masked = [
      { ...offeredSnapshot, imageUrl: null },
      { ...wantedSnapshot, imageUrl: null },
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
   * true when the NAME of an unowned card is revealed on the trade screens:
   * show_unowned_cards AND (show_unowned_card_details OR
   * trade_unowned_card_names_visible). When false, viewers can only trade
   * towards cards they already own a copy of. This is the same rule as
   * cardVisibleTo, so the copy cannot contradict the SQL.
   */
  revealsUnownedCards: boolean;
  /**
   * true when the IMAGE of an unowned card may be revealed too
   * (show_unowned_cards AND show_unowned_card_details). When
   * revealsUnownedCards is true but this is false, screens show a name-only
   * channel: names and rarities are visible, images are placeholders.
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
            // #2070: during the deploy window (safe columns) the setting does
            // not exist, so fail closed to FALSE exactly like the trade flags
            // above. Otherwise this is the same column cardVisibleTo reads.
            tradeUnownedCardNamesVisible: useSafeColumns
              ? sql<boolean>`FALSE`
              : sql<boolean>`${streamersTable.trade_unowned_card_names_visible}`,
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
  return {
    id: row.id,
    twitchUsername: row.twitchUsername,
    twitchDisplayName: row.twitchDisplayName,
    twitchProfileImageUrl: row.twitchProfileImageUrl,
    tradeEnabled: row.tradeEnabled === true,
    crossChannelTradeEnabled: row.crossChannelTradeEnabled === true,
    // "Reveals unowned cards" means the NAME is revealed, which is what the
    // board/create-form copy talks about: details OR the trade-only name
    // setting, both gated by show_unowned_cards (the same rule as
    // cardVisibleTo). Image availability is reported separately below so the
    // screens can explain why a visible name has no picture.
    revealsUnownedCards:
      row.showUnownedCards === true
      && (row.showUnownedCardDetails === true || row.tradeUnownedCardNamesVisible === true),
    revealsUnownedCardImages:
      row.showUnownedCards === true && row.showUnownedCardDetails === true,
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
  name: string;
  rarity: string;
  imageUrl: string | null;
  /** The viewer owns ≥1 copy (listed copies included). */
  isOwned: boolean;
};

/**
 * Step 2 of the listing flow: active cards of one channel that the viewer may
 * ask for, excluding cards the streamer marked as not requestable
 * (cards.trade_wantable = false, #1790). In a channel that does not reveal
 * unowned cards this is otherwise exactly the set of cards the viewer owns;
 * hidden cards are dropped by the SQL WHERE
 * (cardVisibleTo), so their names/images are never read into the Worker.
 * `twitchUserId = null` (anonymous) only sees cards of revealing channels.
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
  const rows = await withTradeWantableColumnFallback((withoutWantable) =>
    withTradeUnownedCardNamesColumnFallback((withoutNameOnly) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          cardId: cardsTable.id,
          name: cardsTable.name,
          rarity: cardsTable.rarity,
          imageUrl: cardsTable.image_url,
          isOwned: viewerUserId
            ? sql<boolean>`EXISTS (
                SELECT 1
                FROM ${userCardsTable} AS wanted_owned
                WHERE wanted_owned.user_id = ${viewerUserId}
                  AND wanted_owned.card_id = ${qualifiedColumn(cardsTable.id)}
              )`
            : sql<boolean>`FALSE`,
          // #2070: the image rule rides along as a scalar boolean instead of a
          // per-card follow-up query (this list is every active card of the
          // channel). It is the same cardImageVisibleTo fragment the other
          // services mask with, so the picker and the board cannot disagree.
          imageVisible: cardImageVisibleTo(cardsTable.id, viewerUserId),
        })
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            eq(cardsTable.is_active, true),
            cardIsWantable(cardsTable.id, withoutWantable),
            // Name level only: a name-only card is selectable (that is the
            // point of #2070); the image is dropped below.
            cardVisibleTo(cardsTable.id, viewerUserId, withoutNameOnly),
          ),
        )
        .orderBy(asc(cardsTable.rarity_order), asc(cardsTable.name), asc(cardsTable.id));
    },
    "trade:wantable-cards",
    { idempotent: true },
  )));

  return rows.map((row) => ({
    cardId: row.cardId,
    name: row.name,
    rarity: row.rarity,
    // Deny-by-default: only an explicit TRUE keeps the image.
    imageUrl: row.imageVisible === true ? row.imageUrl : null,
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
