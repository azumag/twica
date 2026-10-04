import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  getTableName,
  sql,
  type AnyColumn,
} from "drizzle-orm";

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
import { withLiveDirectorySettingsColumnFallback } from "@/lib/db/streamers-safe-columns";
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
 * Drizzle renders `${table.column}` as a bare `"column"` when the outer query
 * selects from a single table without joins. Inside a correlated subquery a
 * bare name binds to the INNER table first if it has a column of that name:
 * e.g. `active_listing.offered_user_card_id = "id"` silently compared two
 * columns of the same inner row (active_listing.id) instead of user_cards.id
 * (verified on real PostgreSQL by tests/integration/trade-visibility-pg.test.ts,
 * which is how the pre-existing canAccept "all_listed" bug was found), and
 * `visible_card.id = "id"` fails with 42702 (ambiguous). Qualifying with the
 * outer table name is unambiguous because every inner table is aliased.
 *
 * Precondition: the outer query references that table exactly once and
 * without alias() (true for every caller in this file). getTableName returns
 * the base table name, so an aliased or self-joined outer table would need a
 * different reference.
 */
function qualifiedColumn(column: AnyColumn) {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

type CardIdExpression = AnyColumn;

/** `cardIdExpr` points at an active card definition (NULL id → false). */
function cardIsActive(cardIdExpr: CardIdExpression) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${cardsTable} AS active_card
    WHERE active_card.id = ${qualifiedColumn(cardIdExpr)}
      AND active_card.is_active = TRUE
  )`;
}

/**
 * `cardIdExpr` is visible to `viewerUserId` (users.id, null = anonymous)
 * according to the rule documented above. Includes the is_active condition.
 */
function cardVisibleTo(cardIdExpr: CardIdExpression, viewerUserId: string | null) {
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

async function getUserByTwitchId(twitchUserId: string) {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: usersTable.id,
          twitch_user_id: usersTable.twitch_user_id,
        })
        .from(usersTable)
        .where(eq(usersTable.twitch_user_id, twitchUserId))
        .limit(1);
    },
    "trade:get-user",
    { idempotent: true },
  );
  return rows[0] ?? null;
}

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
  const user = await getUserByTwitchId(input.twitchUserId);
  if (!user) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }

  // Create idempotency is checked before mutable business validation. A client
  // retry after a successful commit must return the original offer even if a
  // channel setting changes between attempts.
  const replay = await findOfferByCreateRequest(user.id, input.requestId);
  if (replay) {
    return { kind: "ok", offer: replay, idempotentReplay: true };
  }

  const offeredRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          userCardId: userCardsTable.id,
          cardId: cardsTable.id,
          streamerId: cardsTable.streamer_id,
          name: cardsTable.name,
          rarity: cardsTable.rarity,
          imageUrl: cardsTable.image_url,
          isActive: cardsTable.is_active,
        })
        .from(userCardsTable)
        .innerJoin(cardsTable, eq(cardsTable.id, userCardsTable.card_id))
        .where(
          and(
            eq(userCardsTable.id, input.offeredUserCardId),
            eq(userCardsTable.user_id, user.id),
          ),
        )
        .limit(1);
    },
    "trade:create-offered-card",
    { idempotent: true },
  );
  const offered = offeredRows[0];
  if (!offered) {
    return { kind: "error", code: "TRADE_CARD_NOT_OWNED" };
  }

  // Inactive card definitions (retired cards and pack completion reward cards)
  // are excluded from trading entirely. `is_active` is nullable in the schema
  // (DEFAULT true without NOT NULL), so only an explicit TRUE is accepted.
  // The offerer owns this copy, so revealing its inactive state leaks nothing.
  if (offered.isActive !== true) {
    return { kind: "error", code: "TRADE_OFFERED_CARD_INACTIVE" };
  }

  if (offered.cardId === input.wantedCardId) {
    return { kind: "error", code: "TRADE_SAME_CARD" };
  }

  const wantedRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: cardsTable.id,
          streamerId: cardsTable.streamer_id,
          name: cardsTable.name,
          rarity: cardsTable.rarity,
          imageUrl: cardsTable.image_url,
          // Evaluated in SQL with the same predicate as the board so that the
          // create path cannot be used to probe hidden card ids.
          visible: cardVisibleTo(cardsTable.id, user.id),
        })
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.id, input.wantedCardId),
            eq(cardsTable.is_active, true),
          ),
        )
        .limit(1);
    },
    "trade:create-wanted-card",
    { idempotent: true },
  );
  const wanted = wantedRows[0];
  // Hidden and non-existent/inactive cards share one error code on purpose:
  // a distinct "hidden" error (or reaching the TRADE_DISABLED gate below)
  // would confirm that an unrevealed card id exists. This check therefore
  // runs before the streamer gate checks.
  if (!wanted || wanted.visible !== true) {
    return { kind: "error", code: "TRADE_WANTED_CARD_UNAVAILABLE" };
  }

  const streamerIds = [...new Set([offered.streamerId, wanted.streamerId])];
  const streamerRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: streamersTable.id,
          tradeEnabled: streamersTable.trade_enabled,
          crossEnabled: streamersTable.cross_channel_trade_enabled,
        })
        .from(streamersTable)
        .where(inArray(streamersTable.id, streamerIds));
    },
    "trade:create-streamer-gates",
    { idempotent: true },
  );
  const gates = new Map(streamerRows.map((row) => [row.id, row]));
  const offeredGate = gates.get(offered.streamerId);
  const wantedGate = gates.get(wanted.streamerId);
  if (!offeredGate?.tradeEnabled || !wantedGate?.tradeEnabled) {
    return { kind: "error", code: "TRADE_DISABLED" };
  }
  if (
    offered.streamerId !== wanted.streamerId
    && (!offeredGate.crossEnabled || !wantedGate.crossEnabled)
  ) {
    return { kind: "error", code: "TRADE_DISABLED" };
  }

  if (await findOpenOfferForUserCard(input.offeredUserCardId)) {
    return { kind: "error", code: "TRADE_CARD_ALREADY_LISTED" };
  }

  const openCountRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ value: count() })
        .from(tradeOffersTable)
        .where(
          and(
            eq(tradeOffersTable.offerer_user_id, user.id),
            eq(tradeOffersTable.status, "open"),
          ),
        );
    },
    "trade:create-open-count",
    { idempotent: true },
  );
  if (Number(openCountRows[0]?.value ?? 0) >= TRADE_MAX_OPEN_OFFERS) {
    return { kind: "error", code: "TRADE_OFFER_LIMIT" };
  }

  const values = {
    offerer_user_id: user.id,
    offered_user_card_id: offered.userCardId,
    offered_card_id: offered.cardId,
    offered_streamer_id: offered.streamerId,
    wanted_card_id: wanted.id,
    wanted_streamer_id: wanted.streamerId,
    offered_card_snapshot: cardSnapshot({
      name: offered.name,
      rarity: offered.rarity,
      image_url: offered.imageUrl,
    }),
    wanted_card_snapshot: cardSnapshot({
      name: wanted.name,
      rarity: wanted.rarity,
      image_url: wanted.imageUrl,
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

    const byRequest = await findOfferByCreateRequest(user.id, input.requestId);
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

type EnrichOptions = {
  /** users.id of the viewer (undefined = anonymous). */
  viewerUserId?: string;
  /**
   * "board": public listing. canAccept is computed and the internal
   * offeredUserCardId is only exposed for the viewer's own offers.
   * "mine": the viewer's own history. Every row is the viewer's listing or a
   * copy the viewer received, so offeredUserCardId is kept and canAccept
   * (meaningless for own/completed rows) is skipped to save a query.
   */
  context: "board" | "mine";
};

async function enrichOfferRows(
  rows: TradeOfferRow[],
  options: EnrichOptions,
): Promise<TradeOfferDto[]> {
  if (rows.length === 0) return [];

  const { viewerUserId, context } = options;
  const streamerIds = [...new Set(
    rows.flatMap((row) => [row.offered_streamer_id, row.wanted_streamer_id]),
  )];
  // Offerers and acceptors are resolved with one query (same column shape).
  const participantIds = [...new Set(
    rows.flatMap((row) =>
      row.accepted_by_user_id
        ? [row.offerer_user_id, row.accepted_by_user_id]
        : [row.offerer_user_id],
    ),
  )];

  const [streamers, participants] = await Promise.all([
    withDbRetry(
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
          .where(inArray(streamersTable.id, streamerIds));
      },
      "trade:list-streamer-metadata",
      { idempotent: true },
    ),
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: usersTable.id,
            twitchUsername: usersTable.twitch_username,
            twitchDisplayName: usersTable.twitch_display_name,
            twitchProfileImageUrl: usersTable.twitch_profile_image_url,
          })
          .from(usersTable)
          .where(inArray(usersTable.id, participantIds));
      },
      "trade:list-offerer-metadata",
      { idempotent: true },
    ),
  ]);

  const streamerMap = new Map(
    streamers.map((row) => [
      row.id,
      {
        id: row.id,
        twitchUsername: row.twitchUsername,
        twitchDisplayName: row.twitchDisplayName,
        twitchProfileImageUrl: row.twitchProfileImageUrl,
      } satisfies TradeStreamerSummary,
    ]),
  );
  const participantMap = new Map(
    participants.map((row) => [
      row.id,
      {
        twitchUsername: row.twitchUsername,
        twitchDisplayName: row.twitchDisplayName,
        twitchProfileImageUrl: row.twitchProfileImageUrl,
      } satisfies TradeUserSummary,
    ]),
  );

  const computeCanAccept = context === "board" && Boolean(viewerUserId);
  const ownership = new Map<string, Array<{ id: string; listed: boolean }>>();
  if (computeCanAccept && viewerUserId) {
    const wantedCardIds = [...new Set(
      rows
        .filter((row) => row.offerer_user_id !== viewerUserId)
        .map((row) => row.wanted_card_id)
        .filter((value): value is string => typeof value === "string"),
    )];
    if (wantedCardIds.length > 0) {
      const ownedRows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select({
              id: userCardsTable.id,
              cardId: userCardsTable.card_id,
              listed: sql<boolean>`EXISTS (
                SELECT 1
                FROM ${tradeOffersTable} AS active_listing
                WHERE active_listing.offered_user_card_id = ${qualifiedColumn(userCardsTable.id)}
                  AND active_listing.status = 'open'
              )`,
            })
            .from(userCardsTable)
            .where(
              and(
                eq(userCardsTable.user_id, viewerUserId),
                inArray(userCardsTable.card_id, wantedCardIds),
              ),
            );
        },
        "trade:list-can-accept",
        { idempotent: true },
      );
      for (const row of ownedRows) {
        const bucket = ownership.get(row.cardId) ?? [];
        bucket.push({ id: row.id, listed: Boolean(row.listed) });
        ownership.set(row.cardId, bucket);
      }
    }
  }

  return rows.map((row) => {
    const isOwnOffer = viewerUserId !== undefined && row.offerer_user_id === viewerUserId;
    const dto: TradeOfferDto = {
      id: row.id,
      offeredCardId: row.offered_card_id,
      offeredStreamerId: row.offered_streamer_id,
      wantedCardId: row.wanted_card_id,
      wantedStreamerId: row.wanted_streamer_id,
      offeredCard: normalizeSnapshot(row.offered_card_snapshot),
      wantedCard: normalizeSnapshot(row.wanted_card_snapshot),
      isCrossChannel: Boolean(row.is_cross_channel),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      offerer: participantMap.get(row.offerer_user_id) ?? null,
      acceptedBy: row.accepted_by_user_id
        ? participantMap.get(row.accepted_by_user_id) ?? null
        : null,
      offeredStreamer: streamerMap.get(row.offered_streamer_id) ?? null,
      wantedStreamer: streamerMap.get(row.wanted_streamer_id) ?? null,
    };

    // offered_user_card_id is an internal row id of somebody else's copy. It
    // is not needed to accept (the RPC resolves it) and would let third
    // parties track individual copies, so the public board only exposes it
    // for the viewer's own listings (needed for the cancel UI).
    if (context === "mine" || isOwnOffer) {
      dto.offeredUserCardId = row.offered_user_card_id;
    }

    if (viewerUserId) {
      dto.isOwnOffer = isOwnOffer;
    }
    if (computeCanAccept && !isOwnOffer && row.wanted_card_id) {
      const copies = ownership.get(row.wanted_card_id) ?? [];
      dto.canAccept =
        copies.length === 0
          ? "not_owned"
          : copies.every((copy) => copy.listed)
            ? "all_listed"
            : "yes";
    }
    return dto;
  });
}

export async function listTradeOffers(input: {
  streamerId: string;
  scope: TradeScope;
  wantedCardId?: string;
  offeredCardId?: string;
  page: number;
  twitchUserId?: string;
}) {
  const currentUser = input.twitchUserId
    ? await getUserByTwitchId(input.twitchUserId)
    : null;
  const viewerUserId = currentUser?.id ?? null;

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
  const conditions = [
    eq(tradeOffersTable.status, "open"),
    isNotNull(tradeOffersTable.offered_card_id),
    isNotNull(tradeOffersTable.wanted_card_id),
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

  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select()
        .from(tradeOffersTable)
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
    offers: await enrichOfferRows(pageRows, {
      viewerUserId: currentUser?.id,
      context: "board",
    }),
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
  const empty = { offers: [], page, pageSize: TRADE_PAGE_SIZE, hasMore: false };
  const user = await getUserByTwitchId(twitchUserId);
  if (!user) return empty;

  const participantCondition = or(
    eq(tradeOffersTable.offerer_user_id, user.id),
    eq(tradeOffersTable.accepted_by_user_id, user.id),
  )!;
  const where = options.status
    ? and(participantCondition, eq(tradeOffersTable.status, options.status))
    : participantCondition;

  // Bounded page (LIMIT pageSize+1 for hasMore). History grows without bound
  // for active traders, so an unpaged SELECT would eventually exceed Worker
  // CPU/memory limits.
  const offset = (page - 1) * TRADE_PAGE_SIZE;
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select()
        .from(tradeOffersTable)
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
  const offers = await enrichOfferRows(pageRows, {
    viewerUserId: user.id,
    context: "mine",
  });
  return {
    offers: offers.map((offer, index) => ({
      ...offer,
      mineRole:
        pageRows[index]?.offerer_user_id === user.id
          ? "offerer" as const
          : "acceptor" as const,
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
  const user = await getUserByTwitchId(input.twitchUserId);
  if (!user) {
    return { kind: "error", code: "TRADE_OFFER_NOT_FOUND" };
  }

  const updated = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .update(tradeOffersTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(tradeOffersTable.id, input.tradeOfferId),
            eq(tradeOffersTable.offerer_user_id, user.id),
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
            eq(tradeOffersTable.offerer_user_id, user.id),
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
  const acceptor = await getUserByTwitchId(input.twitchUserId);
  if (!acceptor) return null;

  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
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
          offeredVisible: cardVisibleTo(tradeOffersTable.offered_card_id, acceptor.id),
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

  // Replay first (explicit for readability; behaviorally it is also covered
  // by the `status !== "open"` delegation right below, since a replay is
  // always `completed`).
  const isReplay =
    offer.status === "completed"
    && offer.acceptedByUserId === acceptor.id
    && offer.acceptedRequestId === input.requestId;
  if (isReplay) return null;
  if (offer.status !== "open") return null;
  if (offer.offererUserId === acceptor.id) return null;
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
  const user = await getUserByTwitchId(twitchUserId);
  if (!user) return [];

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
            eq(userCardsTable.user_id, user.id),
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
  const viewer = twitchUserId ? await getUserByTwitchId(twitchUserId) : null;
  const viewerUserId = viewer?.id ?? null;

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
 * `baseStreamerId`: channels where the viewer owns ≥1 card copy AND that allow
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
  // getTradeBoardStreamer validates the UUID and fails closed (false flags)
  // during the trade-columns deploy window, so the partner query below, which
  // filters on those columns, is never reached without them.
  const base = await getTradeBoardStreamer(baseStreamerId);
  if (!base?.tradeEnabled || !base.crossChannelTradeEnabled) return [];

  const user = await getUserByTwitchId(twitchUserId);
  if (!user) return [];

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
            ne(streamersTable.id, base.id),
            eq(streamersTable.trade_enabled, true),
            eq(streamersTable.cross_channel_trade_enabled, true),
            sql`EXISTS (
              SELECT 1
              FROM ${userCardsTable} AS partner_owned
              INNER JOIN ${cardsTable} AS partner_card
                ON partner_card.id = partner_owned.card_id
              WHERE partner_owned.user_id = ${user.id}
                AND partner_card.streamer_id = ${qualifiedColumn(streamersTable.id)}
            )`,
          ),
        )
        .orderBy(asc(streamersTable.twitch_display_name), asc(streamersTable.id));
    },
    "trade:cross-partner-streamers",
    { idempotent: true },
  );

  return rows.map((row) => ({
    id: row.id,
    twitchUsername: row.twitchUsername,
    twitchDisplayName: row.twitchDisplayName,
    twitchProfileImageUrl: row.twitchProfileImageUrl,
  }));
}
