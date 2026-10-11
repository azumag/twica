import {
  and,
  asc,
  desc,
  eq,
  ne,
  or,
  getTableName,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import {
  cards as cardsTable,
  streamers as streamersTable,
  tradeOffers as tradeOffersTable,
  userCards as userCardsTable,
  users as usersTable,
} from "@/lib/db/schema";
import { getErrorChain, getSqlState, isPgUniqueViolationError } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import {
  isMissingTradeSettingsColumnError,
  withLiveDirectorySettingsColumnFallback,
} from "@/lib/db/streamers-safe-columns";
import { isCanonicalUuid } from "@/lib/uuid-validation";

export const TRADE_PAGE_SIZE = 20;
export const TRADE_MAX_OPEN_OFFERS = 10;

export type TradeScope = "in_channel" | "cross_channel";
export type TradeCanAccept = "yes" | "not_owned" | "all_listed";
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
  // The copy the offerer wants to give belongs to a card definition that is
  // no longer active (including pack completion reward cards, which are kept
  // inactive by design). Inactive cards cannot enter the trade market.
  | "TRADE_OFFERED_CARD_INACTIVE";

// -----------------------------------------------------------------------------
// Card visibility rules (product decision for #715/#726/#727)
//
//   visible(card, viewer) ⇔ card.is_active
//     AND ( viewer owns ≥1 copy of card.id (listed copies included)
//           OR (card's streamer.show_unowned_cards AND show_unowned_card_details) )
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
function qualifiedColumn(column: AnyColumn) {
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
// An unknown twitch_user_id makes the subquery NULL. Every comparison against
// NULL is not TRUE, which reproduces the previous "user not found" branches
// (anonymous visibility, empty result, not-found errors) without a branch.
// -----------------------------------------------------------------------------

/**
 * users.id of `twitchUserId` as a scalar subquery (NULL when unknown). The
 * literal alias keeps it independent of any outer `users` reference.
 */
function viewerUserIdOf(twitchUserId: string): SQL {
  return sql`(
    SELECT viewer.id
    FROM ${usersTable} AS viewer
    WHERE viewer.twitch_user_id = ${twitchUserId}
  )`;
}

/** `cardIdExpr` points at an active card definition (NULL id → false). */
function cardIsActive(cardIdExpr: AnyColumn) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS active_card
    WHERE active_card.id = ${qualifiedColumn(cardIdExpr)}
      AND active_card.is_active = TRUE
  )`;
}

/**
 * `cardIdExpr` is visible to `viewerUserId` according to the rule documented
 * above. Includes the is_active condition. `viewerUserId` is an SQL
 * expression producing users.id (viewerUserIdOf() or an outer column); null
 * means anonymous.
 */
function cardVisibleTo(cardIdExpr: AnyColumn, viewerUserId: SQL | null) {
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
        (
          visible_streamer.show_unowned_cards = TRUE
          AND visible_streamer.show_unowned_card_details = TRUE
        )
        OR ${ownedByViewer}
      )
  )`;
}

type TradeCardSnapshot = {
  name: string;
  rarity: string;
  imageUrl: string | null;
};

type TradeStreamerSummary = {
  id: string;
  twitchUsername: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
};

type TradeUserSummary = {
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
   * offer it is false when a card definition was deleted or deactivated, or
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

function normalizeSnapshot(value: unknown): TradeCardSnapshot {
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
        .select()
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

export async function createTradeOffer(input: {
  twitchUserId: string;
  offeredUserCardId: string;
  wantedCardId: string;
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
  const checkRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          userId: usersTable.id,
          // Full row of a previous create with the same requestId (or null).
          replay: createReplayOffer,
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
          offeredTradeEnabled: createOfferedGate.trade_enabled,
          offeredCrossEnabled: createOfferedGate.cross_channel_trade_enabled,
          wantedTradeEnabled: createWantedGate.trade_enabled,
          wantedCrossEnabled: createWantedGate.cross_channel_trade_enabled,
          // Same predicate as the partial unique index
          // idx_trade_offers_open_user_card (regardless of the offerer).
          offeredCopyListed: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${tradeOffersTable} AS open_listing
            WHERE open_listing.offered_user_card_id = ${input.offeredUserCardId}
              AND open_listing.status = 'open'
          )`,
          // count(*) is bigint → string in postgres.js.
          openOfferCount: sql<number>`(
            SELECT count(*)
            FROM ${tradeOffersTable} AS open_offer
            WHERE open_offer.offerer_user_id = ${qualifiedColumn(usersTable.id)}
              AND open_offer.status = 'open'
          )`.mapWith(Number),
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
            // falls into TRADE_WANTED_CARD_UNAVAILABLE below.
            cardVisibleTo(createWantedCard.id, qualifiedColumn(usersTable.id)),
          ),
        )
        .leftJoin(createOfferedGate, eq(createOfferedGate.id, createOfferedCard.streamer_id))
        .leftJoin(createWantedGate, eq(createWantedGate.id, createWantedCard.streamer_id))
        .where(eq(usersTable.twitch_user_id, input.twitchUserId))
        .limit(1);
    },
    "trade:create-checks",
    { idempotent: true },
  );
  const check = checkRows[0];
  if (!check) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }
  const userId = check.userId;

  // Create idempotency is checked before mutable business validation. A client
  // retry after a successful commit must return the original offer even if a
  // channel setting changes between attempts.
  if (check.replay) {
    return { kind: "ok", offer: check.replay, idempotentReplay: true };
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
  } satisfies typeof tradeOffersTable.$inferInsert;

  try {
    const rows = await withDbRetry(
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
    return { kind: "ok", offer, idempotentReplay: false };
  } catch (error) {
    if (!isPgUniqueViolationError(error)) throw error;

    // Rare conflict path: kept as separate follow-up reads (not part of the
    // round-trip budget of the normal path).
    const byRequest = await findOfferByCreateRequest(userId, input.requestId);
    if (byRequest) {
      return { kind: "ok", offer: byRequest, idempotentReplay: true };
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

function tradeEnabledGate(
  streamerColumn:
    | typeof tradeOffersTable.offered_streamer_id
    | typeof tradeOffersTable.wanted_streamer_id,
) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${streamersTable} AS trade_gate
    WHERE trade_gate.id = ${qualifiedColumn(streamerColumn)}
      AND trade_gate.trade_enabled = TRUE
  )`;
}

function crossEnabledGate(
  streamerColumn:
    | typeof tradeOffersTable.offered_streamer_id
    | typeof tradeOffersTable.wanted_streamer_id,
) {
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
    offer: tradeOffersTable,
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
 * open offers cannot be used to pay.
 *   not_owned  — the viewer owns no copy of the wanted card
 *   all_listed — every owned copy is listed in one of the viewer's own open offers
 *   yes        — at least one unlisted copy exists
 * The inner aliases are literal; the only outer references are the qualified
 * trade_offers.wanted_card_id and the viewer id.
 */
function acceptStateFor(viewerUserId: SQL) {
  const wantedCardId = qualifiedColumn(tradeOffersTable.wanted_card_id);
  return sql<TradeCanAccept>`CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ${userCardsTable} AS accept_owned
      WHERE accept_owned.user_id = ${viewerUserId}
        AND accept_owned.card_id = ${wantedCardId}
    ) THEN 'not_owned'
    WHEN NOT EXISTS (
      SELECT 1
      FROM ${userCardsTable} AS accept_free
      WHERE accept_free.user_id = ${viewerUserId}
        AND accept_free.card_id = ${wantedCardId}
        AND NOT EXISTS (
          SELECT 1
          FROM ${tradeOffersTable} AS active_listing
          WHERE active_listing.offered_user_card_id = accept_free.id
            AND active_listing.status = 'open'
            AND active_listing.offerer_user_id = ${viewerUserId}
        )
    ) THEN 'all_listed'
    ELSE 'yes'
  END`;
}

/**
 * Whether an open offer can still be accepted by somebody, evaluated in SQL
 * with the exact gate predicates the board filters with (#1754 item 4):
 *
 *   tradeable(offer) ⇔ both card definitions are active
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
function tradeableStateFor() {
  return sql<boolean>`(
    ${cardIsActive(tradeOffersTable.offered_card_id)}
    AND ${cardIsActive(tradeOffersTable.wanted_card_id)}
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
  const bothSidesVisible = and(
    cardVisibleTo(tradeOffersTable.offered_card_id, viewerUserId),
    cardVisibleTo(tradeOffersTable.wanted_card_id, viewerUserId),
  )!;
  const visibilityCondition = viewerUserId
    ? or(eq(tradeOffersTable.offerer_user_id, viewerUserId), bothSidesVisible)!
    : bothSidesVisible;

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
    visibilityCondition,
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
  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  const rows: OfferListRow[] = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          ...offerListFields(viewerUserId),
          acceptState: viewerUserId
            ? acceptStateFor(viewerUserId)
            : sql<TradeCanAccept | null>`NULL`,
        })
        .from(tradeOffersTable)
        .leftJoin(offeredStreamerMeta, eq(offeredStreamerMeta.id, tradeOffersTable.offered_streamer_id))
        .leftJoin(wantedStreamerMeta, eq(wantedStreamerMeta.id, tradeOffersTable.wanted_streamer_id))
        .leftJoin(offererMeta, eq(offererMeta.id, tradeOffersTable.offerer_user_id))
        .leftJoin(acceptorMeta, eq(acceptorMeta.id, tradeOffersTable.accepted_by_user_id))
        .where(and(...conditions))
        .orderBy(desc(tradeOffersTable.created_at), desc(tradeOffersTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade:list-open",
    { idempotent: true },
  );

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    offers: pageRows.map((row) => toOfferDto(row, "board")),
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
  const rows: OfferListRow[] = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          ...offerListFields(viewerUserId),
          tradeableState: tradeableStateFor(),
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
  );

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    offers: pageRows.map((row) => ({
      ...toOfferDto(row, "mine"),
      mineRole:
        row.offer.offerer_user_id === row.viewerUserId
          ? "offerer" as const
          : "acceptor" as const,
      tradeable: row.offer.status === "open" && row.tradeableState === true,
    })),
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
  | "CARD_NOT_OWNED";

const TRADE_ACCEPT_RPC_ERRORS = new Set<TradeAcceptRpcError>([
  "TRADE_OFFER_NOT_FOUND",
  "OFFER_NOT_OPEN",
  "SELF_ACCEPT_FORBIDDEN",
  "OFFER_INVALID",
  "TRADE_DISABLED",
  "CARD_NOT_OWNED",
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
    && result.tradeOfferId === expectedTradeOfferId
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

async function callAcceptTradeOfferRpc(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
}): Promise<TradeAcceptRpcResult> {
  const { sql: query } = await getDb();
  const rows = await query<Array<{ result: unknown }>>`
    SELECT public.accept_trade_offer(
      ${input.twitchUserId},
      ${input.tradeOfferId}::uuid,
      ${input.requestId}::uuid
    ) AS result
  `;
  const result = rows[0]?.result;
  if (!isValidTradeAcceptRpcResult(result, input.tradeOfferId)) {
    throw new Error("accept_trade_offer returned an invalid response");
  }
  return result;
}

function waitForTradeRetry(ms: number): Promise<void> {
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
async function precheckTradeAccept(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
}): Promise<TradeAcceptPrecheckError | null> {
  // The acceptor id is resolved inside the same statement (previously a
  // separate users lookup round trip before this read).
  const acceptorUserId = viewerUserIdOf(input.twitchUserId);
  const rows = await withDbRetry(
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
          // The wanted card needs no visibility check: the acceptor must own
          // a copy of it to pay, and owning a copy makes it visible.
          offeredVisible: cardVisibleTo(tradeOffersTable.offered_card_id, acceptorUserId),
        })
        .from(tradeOffersTable)
        .where(eq(tradeOffersTable.id, input.tradeOfferId))
        .limit(1);
    },
    "trade:accept-precheck",
    { idempotent: true },
  );
  const offer = rows[0];
  if (!offer) return null;
  // Unknown acceptor: delegated to the RPC, which classifies it (unchanged).
  const acceptorId = offer.acceptorUserId;
  if (!acceptorId) return null;

  // Replay first (explicit for readability; behaviorally it is also covered
  // by the `status !== "open"` delegation right below, since a replay is
  // always `completed`).
  const isReplay =
    offer.status === "completed"
    && offer.acceptedByUserId === acceptorId
    && offer.acceptedRequestId === input.requestId;
  if (isReplay) return null;
  if (offer.status !== "open") return null;
  if (offer.offererUserId === acceptorId) return null;
  if (!offer.offeredCardId || !offer.wantedCardId) return null;

  // One code for "inactive" and "not visible": the board already hides both
  // kinds of offers, and distinguishing them would tell a non-owner whether
  // a hidden card is merely secret or retired.
  if (
    offer.offeredActive !== true
    || offer.wantedActive !== true
    || offer.offeredVisible !== true
  ) {
    return "TRADE_OFFER_UNAVAILABLE";
  }
  return null;
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
}): Promise<
  | TradeAcceptRpcResult
  | { success: false; error: "TRADE_BUSY" | TradeAcceptPrecheckError }
> {
  const precheckError = await precheckTradeAccept(input);
  if (precheckError) {
    return { success: false, error: precheckError };
  }

  try {
    return await callAcceptTradeOfferRpc(input);
  } catch (error) {
    if (getSqlState(error) !== "40P01") throw error;
  }

  // Short full-jitter delay. One retry only: sustained deadlock pressure should
  // be surfaced to the caller instead of becoming an unbounded Worker task.
  await waitForTradeRetry(Math.floor(Math.random() * 51));

  try {
    return await callAcceptTradeOfferRpc(input);
  } catch (error) {
    if (getSqlState(error) === "40P01") {
      return { success: false, error: "TRADE_BUSY" };
    }
    throw error;
  }
}

/**
 * Audit metadata for successful ownership transfer. This read is deliberately
 * outside the RPC transaction: it is observability only and must never affect
 * the committed trade result.
 */
export async function getTradeOfferAuditParticipants(tradeOfferId: string): Promise<{
  offererTwitchUserId: string | null;
}> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ offererTwitchUserId: usersTable.twitch_user_id })
        .from(tradeOffersTable)
        .innerJoin(usersTable, eq(usersTable.id, tradeOffersTable.offerer_user_id))
        .where(eq(tradeOffersTable.id, tradeOfferId))
        .limit(1);
    },
    "trade:accept-audit-participants",
    { idempotent: true },
  );
  return { offererTwitchUserId: rows[0]?.offererTwitchUserId ?? null };
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
   * true when unowned cards are shown WITH names/images
   * (show_unowned_cards AND show_unowned_card_details). When false, viewers
   * can only trade towards cards they already own a copy of.
   */
  revealsUnownedCards: boolean;
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
    revealsUnownedCards:
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
  /** This exact copy is already in an open offer (cannot be listed again). */
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

  const rows = await withDbRetry(
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
          // Same predicate as the create-time ALREADY_LISTED check (the
          // partial UNIQUE index is on offered_user_card_id regardless of
          // the offerer).
          isListed: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${tradeOffersTable} AS copy_listing
            WHERE copy_listing.offered_user_card_id = ${qualifiedColumn(userCardsTable.id)}
              AND copy_listing.status = 'open'
          )`,
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
  );

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
 * ask for. In a channel that does not reveal unowned cards this is exactly the
 * set of cards the viewer owns; hidden cards are dropped by the SQL WHERE
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

  const rows = await withDbRetry(
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
        })
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            eq(cardsTable.is_active, true),
            cardVisibleTo(cardsTable.id, viewerUserId),
          ),
        )
        .orderBy(asc(cardsTable.rarity_order), asc(cardsTable.name), asc(cardsTable.id));
    },
    "trade:wantable-cards",
    { idempotent: true },
  );

  return rows.map((row) => ({
    cardId: row.cardId,
    name: row.name,
    rarity: row.rarity,
    imageUrl: row.imageUrl,
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
