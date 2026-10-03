import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
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

export const TRADE_PAGE_SIZE = 20;
export const TRADE_MAX_OPEN_OFFERS = 10;

export type TradeScope = "in_channel" | "cross_channel";
export type TradeCanAccept = "yes" | "not_owned" | "all_listed";

export type TradeServiceErrorCode =
  | "TRADE_DISABLED"
  | "TRADE_OFFER_NOT_FOUND"
  | "TRADE_OFFER_NOT_OPEN"
  | "TRADE_CARD_NOT_OWNED"
  | "TRADE_CARD_ALREADY_LISTED"
  | "TRADE_OFFER_LIMIT"
  | "TRADE_SAME_CARD"
  | "TRADE_WANTED_CARD_UNAVAILABLE";

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
  offeredUserCardId: string;
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
          isActive: cardsTable.is_active,
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
  if (!wanted) {
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
    WHERE trade_gate.id = ${streamerColumn}
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
    WHERE cross_gate.id = ${streamerColumn}
      AND cross_gate.cross_channel_trade_enabled = TRUE
  )`;
}

async function enrichOfferRows(
  rows: TradeOfferRow[],
  currentUserId?: string,
): Promise<TradeOfferDto[]> {
  if (rows.length === 0) return [];

  const streamerIds = [...new Set(
    rows.flatMap((row) => [row.offered_streamer_id, row.wanted_streamer_id]),
  )];
  const offererIds = [...new Set(rows.map((row) => row.offerer_user_id))];

  const [streamers, offerers] = await Promise.all([
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
          .where(inArray(usersTable.id, offererIds));
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
  const offererMap = new Map(
    offerers.map((row) => [
      row.id,
      {
        twitchUsername: row.twitchUsername,
        twitchDisplayName: row.twitchDisplayName,
        twitchProfileImageUrl: row.twitchProfileImageUrl,
      } satisfies TradeUserSummary,
    ]),
  );

  const ownership = new Map<string, Array<{ id: string; listed: boolean }>>();
  if (currentUserId) {
    const wantedCardIds = [...new Set(
      rows
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
                WHERE active_listing.offered_user_card_id = ${userCardsTable.id}
                  AND active_listing.status = 'open'
              )`,
            })
            .from(userCardsTable)
            .where(
              and(
                eq(userCardsTable.user_id, currentUserId),
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
    const dto: TradeOfferDto = {
      id: row.id,
      offeredUserCardId: row.offered_user_card_id,
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
      offerer: offererMap.get(row.offerer_user_id) ?? null,
      offeredStreamer: streamerMap.get(row.offered_streamer_id) ?? null,
      wantedStreamer: streamerMap.get(row.wanted_streamer_id) ?? null,
    };

    if (currentUserId) {
      dto.isOwnOffer = row.offerer_user_id === currentUserId;
      if (!dto.isOwnOffer && row.wanted_card_id) {
        const copies = ownership.get(row.wanted_card_id) ?? [];
        dto.canAccept =
          copies.length === 0
            ? "not_owned"
            : copies.every((copy) => copy.listed)
              ? "all_listed"
              : "yes";
      }
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

  const conditions = [
    eq(tradeOffersTable.status, "open"),
    isNotNull(tradeOffersTable.offered_card_id),
    isNotNull(tradeOffersTable.wanted_card_id),
    tradeEnabledGate(tradeOffersTable.offered_streamer_id),
    tradeEnabledGate(tradeOffersTable.wanted_streamer_id),
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
    offers: await enrichOfferRows(pageRows, currentUser?.id),
    page: input.page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
}

export async function listMyTradeOffers(twitchUserId: string) {
  const user = await getUserByTwitchId(twitchUserId);
  if (!user) return [];

  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select()
        .from(tradeOffersTable)
        .where(
          or(
            eq(tradeOffersTable.offerer_user_id, user.id),
            eq(tradeOffersTable.accepted_by_user_id, user.id),
          ),
        )
        .orderBy(desc(tradeOffersTable.created_at), desc(tradeOffersTable.id));
    },
    "trade:list-mine",
    { idempotent: true },
  );

  const offers = await enrichOfferRows(rows, user.id);
  return offers.map((offer, index) => ({
    ...offer,
    mineRole:
      rows[index]?.offerer_user_id === user.id
        ? "offerer" as const
        : "acceptor" as const,
  }));
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

async function callAcceptTradeOfferRpc(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
}): Promise<TradeAcceptRpcResult> {
  const { sql: query } = await getDb();
  const rows = await query<Array<{ result: TradeAcceptRpcResult }>>`
    SELECT public.accept_trade_offer(
      ${input.twitchUserId},
      ${input.tradeOfferId}::uuid,
      ${input.requestId}::uuid
    ) AS result
  `;
  const result = rows[0]?.result;
  if (
    !result
    || typeof result.success !== "boolean"
    || (
      result.success === false
      && (
        typeof result.error !== "string"
        || !TRADE_ACCEPT_RPC_ERRORS.has(result.error as TradeAcceptRpcError)
      )
    )
  ) {
    throw new Error("accept_trade_offer returned an invalid response");
  }
  return result;
}

function waitForTradeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issue #724: accept_trade_offer() owns the transaction and row locks. The API
 * layer only retries SQLSTATE 40P01 once with the SAME requestId. The RPC checks
 * its idempotency replay before mutable validation, so a retry after a commit
 * cannot transfer ownership twice.
 */
export async function acceptTradeOffer(input: {
  twitchUserId: string;
  tradeOfferId: string;
  requestId: string;
}): Promise<TradeAcceptRpcResult | { success: false; error: "TRADE_BUSY" }> {
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

