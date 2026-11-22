/**
 * Trade auctions (#1791, PR-1: service layer). Design:
 * tasks/plans/issue-1791-trade-auction.md (§4 DB, §5 API).
 *
 * Division of labour (same as accept, src/lib/trade.ts):
 *   * Every state change is ONE PL/pgSQL RPC of
 *     20261018030000_trade_auctions.sql (create / place bid / withdraw /
 *     cancel / settle). The RPCs own row locks, DB-time (clock_timestamp())
 *     phase decisions, copy locks (trade_copy_locked), ownership transfer and
 *     idempotent replay. Business failures come back as `{ success: false,
 *     error }` JSONB and are mapped to the TRADE_* API codes here.
 *   * The card visibility rule (cardVisibleTo in src/lib/trade.ts) is applied
 *     here, in SQL, before the bid RPC: re-implementing it inside PL/pgSQL
 *     would create a second copy of a privacy rule that could drift.
 *   * Reads (board / detail / mine) are single statements that derive the
 *     phase from the stored status and the DB clock, never from Worker time.
 *
 * Deploy window (§4.6): before the migration the tables / functions do not
 * exist. Writes then answer TRADE_AUCTION_UNAVAILABLE and reads throw
 * TradeAuctionUnavailableError; the routes turn both into 503 so the UI can
 * hide the auction entry points. Existing trade screens are unaffected: they
 * fall back in src/lib/trade.ts and /api/trades/mine does not touch auctions.
 */
import { and, asc, desc, eq, gt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import { getSqlState } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import {
  cards as cardsTable,
  streamers as streamersTable,
  tradeAuctionBids as bidsTable,
  tradeAuctions as auctionsTable,
  users as usersTable,
} from "@/lib/db/schema";
import { collectedStreamerIdsSubquery } from "@/lib/collected-streamers";
import {
  cardIsActive,
  cardVisibleTo,
  crossEnabledGate,
  isTradeAuctionSchemaMissingError,
  maskTradeCardImages,
  normalizeSnapshot,
  qualifiedColumn,
  toIsoTimestamp,
  TRADE_COLLECTION_PREVIEW_SIZE,
  TRADE_PAGE_SIZE,
  tradeEnabledGate,
  viewerUserIdOf,
  waitForTradeRetry,
  withUnownedCardItemColumnFallback,
  type TradeCardSnapshot,
  type TradeCollectionSort,
  type TradeScope,
  type TradeStreamerSummary,
  type TradeUserSummary,
} from "@/lib/trade";
import { isCanonicalUuid } from "@/lib/uuid-validation";

/** Allowed listing durations (hours): 24 hours / 3 days / 7 days. */
export const TRADE_AUCTION_DURATIONS_HOURS = [24, 72, 168] as const;
export type TradeAuctionDurationHours = (typeof TRADE_AUCTION_DURATIONS_HOURS)[number];
/** Selection window after ends_at (stored per auction by the RPC). */
export const TRADE_AUCTION_SELECTION_HOURS = 72;
/**
 * Max active bids per bidder (spec). Must match place_trade_auction_bid. A
 * bid change on the same auction replaces the bid and does not count.
 */
export const TRADE_MAX_ACTIVE_BIDS = 10;
/** Bid quantity range; same bound as trade_offers.wanted_quantity. */
export const TRADE_MAX_BID_QUANTITY = 10;

/**
 * Effective state of an auction (design §3), derived in SQL:
 *   bidding   — open and clock_timestamp() < ends_at
 *   selecting — open, ends_at passed, before selection_deadline, ≥1 active bid
 *   expired   — open but neither of the above (no bids at the deadline, or
 *               the selection window passed). 'expired' is derived only; there
 *               is no stored 'expired' status.
 *   completed / cancelled — stored status
 */
export type TradeAuctionPhase = "bidding" | "selecting" | "expired" | "completed" | "cancelled";
export type TradeAuctionBidStatus = "active" | "withdrawn" | "won" | "lost";
/**
 * Bid state shown to its bidder: `released` is an `active` row whose auction
 * no longer holds cards (expired / cancelled), i.e. its copies are free.
 */
export type TradeAuctionBidState = TradeAuctionBidStatus | "released";

/** API error codes introduced by auctions (see src/lib/trade-api.ts for statuses). */
export type TradeAuctionErrorCode =
  | "TRADE_AUCTION_UNAVAILABLE"
  | "TRADE_AUCTION_NOT_FOUND"
  | "TRADE_AUCTION_NOT_OPEN"
  | "TRADE_AUCTION_STILL_BIDDING"
  | "TRADE_AUCTION_EXPIRED"
  | "TRADE_AUCTION_HAS_BIDS"
  | "TRADE_AUCTION_SELF_BID"
  | "TRADE_AUCTION_BID_NOT_FOUND"
  | "TRADE_AUCTION_BID_NOT_ACTIVE"
  | "TRADE_AUCTION_BID_LOCKED"
  | "TRADE_AUCTION_BID_LIMIT"
  | "TRADE_AUCTION_BID_INVALID"
  | "TRADE_BID_CARD_UNAVAILABLE"
  | "TRADE_BID_CARD_NOT_WANTABLE"
  | "TRADE_NOT_ENOUGH_CARDS";

/** Every code an auction service call can return. */
export type TradeAuctionServiceErrorCode =
  | TradeAuctionErrorCode
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "TRADE_BUSY"
  | "TRADE_DISABLED"
  | "TRADE_CARD_NOT_OWNED"
  | "TRADE_CARD_ALREADY_LISTED"
  | "TRADE_OFFER_LIMIT"
  | "TRADE_OFFERED_CARD_INACTIVE"
  | "TRADE_SAME_CARD";

/**
 * RPC error string → API code. Names are those RETURNed by the RPCs of
 * 20261018030000. Kept as one table so an unknown string (a newer migration
 * than this app) is detected by validation and fails as 500 instead of being
 * shown as success.
 */
const RPC_ERRORS = {
  USER_NOT_FOUND: "UNAUTHORIZED",
  INVALID_DURATION: "INVALID_REQUEST",
  INVALID_QUANTITY: "INVALID_REQUEST",
  REQUEST_ID_CONFLICT: "INVALID_REQUEST",
  CARD_NOT_OWNED: "TRADE_CARD_NOT_OWNED",
  OFFERED_CARD_INACTIVE: "TRADE_OFFERED_CARD_INACTIVE",
  TRADE_DISABLED: "TRADE_DISABLED",
  OFFER_LIMIT: "TRADE_OFFER_LIMIT",
  CARD_ALREADY_LISTED: "TRADE_CARD_ALREADY_LISTED",
  AUCTION_NOT_FOUND: "TRADE_AUCTION_NOT_FOUND",
  AUCTION_NOT_OPEN: "TRADE_AUCTION_NOT_OPEN",
  SELF_BID_FORBIDDEN: "TRADE_AUCTION_SELF_BID",
  SAME_CARD: "TRADE_SAME_CARD",
  BID_CARD_UNAVAILABLE: "TRADE_BID_CARD_UNAVAILABLE",
  BID_CARD_NOT_WANTABLE: "TRADE_BID_CARD_NOT_WANTABLE",
  BID_LIMIT: "TRADE_AUCTION_BID_LIMIT",
  NOT_ENOUGH_CARDS: "TRADE_NOT_ENOUGH_CARDS",
  BID_NOT_FOUND: "TRADE_AUCTION_BID_NOT_FOUND",
  BID_NOT_ACTIVE: "TRADE_AUCTION_BID_NOT_ACTIVE",
  BID_WITHDRAW_LOCKED: "TRADE_AUCTION_BID_LOCKED",
  AUCTION_HAS_BIDS: "TRADE_AUCTION_HAS_BIDS",
  AUCTION_STILL_BIDDING: "TRADE_AUCTION_STILL_BIDDING",
  AUCTION_EXPIRED: "TRADE_AUCTION_EXPIRED",
  AUCTION_BID_INVALID: "TRADE_AUCTION_BID_INVALID",
} as const satisfies Record<string, TradeAuctionServiceErrorCode>;

type RpcErrorName = keyof typeof RPC_ERRORS;

function isRpcErrorName(value: unknown): value is RpcErrorName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RPC_ERRORS, value);
}

export type TradeAuctionResult<T> =
  | ({ kind: "ok" } & T)
  | { kind: "error"; code: TradeAuctionServiceErrorCode };

/** Thrown by the read functions while the auction schema is missing (deploy window). */
export class TradeAuctionUnavailableError extends Error {
  constructor() {
    super("Trade auction schema is not available yet");
    this.name = "TradeAuctionUnavailableError";
  }
}

// -----------------------------------------------------------------------------
// RPC plumbing
// -----------------------------------------------------------------------------

type RpcRecord = Record<string, unknown>;

/**
 * Run one auction RPC. 40P01 (deadlock) is retried ONCE with the same
 * arguments, then reported as TRADE_BUSY — the same policy as acceptTradeOffer
 * (withDbRetry does not retry 40P01, and every RPC replays idempotently or is
 * idempotent in state, so the retry cannot apply a change twice). The missing
 * schema of the deploy window becomes TRADE_AUCTION_UNAVAILABLE. Anything that
 * is not a well-formed `{ success, error? }` object with a known error throws
 * (→ 500, nothing is reported as success).
 */
async function runAuctionRpc(
  name: string,
  call: () => Promise<Array<{ result: unknown }>>,
): Promise<{ ok: true; result: RpcRecord } | { ok: false; code: TradeAuctionServiceErrorCode }> {
  const attempt = async () => {
    try {
      return { rows: await call() } as const;
    } catch (error) {
      if (isTradeAuctionSchemaMissingError(error)) return { unavailable: true } as const;
      throw error;
    }
  };

  let outcome: Awaited<ReturnType<typeof attempt>>;
  try {
    outcome = await attempt();
  } catch (error) {
    if (getSqlState(error) !== "40P01") throw error;
    // Short full-jitter delay, one retry only (see acceptTradeOffer).
    await waitForTradeRetry(Math.floor(Math.random() * 51));
    try {
      outcome = await attempt();
    } catch (retryError) {
      if (getSqlState(retryError) === "40P01") return { ok: false, code: "TRADE_BUSY" };
      throw retryError;
    }
  }
  if ("unavailable" in outcome) return { ok: false, code: "TRADE_AUCTION_UNAVAILABLE" };

  const result = outcome.rows[0]?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${name} returned an invalid response`);
  }
  const record = result as RpcRecord;
  if (record.success === false) {
    if (!isRpcErrorName(record.error)) {
      throw new Error(`${name} returned an unknown error: ${String(record.error)}`);
    }
    return { ok: false, code: RPC_ERRORS[record.error] };
  }
  if (record.success !== true) throw new Error(`${name} returned an invalid response`);
  return { ok: true, result: record };
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !isCanonicalUuid(value)) {
    throw new Error(`auction RPC returned an invalid ${what}`);
  }
  return value;
}

function requireRecord(value: unknown, what: string): RpcRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`auction RPC returned an invalid ${what}`);
  }
  return value as RpcRecord;
}

// -----------------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------------

export type TradeAuctionDto = {
  id: string;
  /** Internal copy id; only for the seller (cancel/settle UI), never public. */
  offeredUserCardId?: string;
  offeredCardId: string | null;
  offeredStreamerId: string;
  offeredCard: TradeCardSnapshot;
  /** ISO timestamps; the UI renders them relatively, the server decides boundaries. */
  endsAt: string;
  selectionDeadline: string;
  status: string;
  phase: TradeAuctionPhase;
  /** Active bids. The only bid information shown to non-participants. */
  bidCount: number;
  createdAt: string;
  completedAt: string | null;
  seller: TradeUserSummary | null;
  offeredStreamer: TradeStreamerSummary | null;
  isOwnAuction?: boolean;
  /** The viewer's own latest non-withdrawn bid on this auction (bidders only). */
  myBid?: TradeAuctionBidDto | null;
};

export type TradeAuctionBidDto = {
  id: string;
  auctionId: string;
  bidCardId: string | null;
  bidStreamerId: string;
  bidCard: TradeCardSnapshot;
  quantity: number;
  isCrossChannel: boolean;
  status: string;
  state: TradeAuctionBidState;
  createdAt: string;
  /**
   * Whether the seller could settle with this bid right now if the auction
   * were selecting (trade_auction_bid_unsettleable_reason IS NULL). In the
   * selecting phase `false` is exactly "the bidder may withdraw it".
   */
  settleable: boolean;
  /** Only in the seller's bid list. */
  bidder?: TradeUserSummary | null;
};

/**
 * 1コレクション分のオークション一覧 (#2079)。オークションは offered 側の
 * 配信者にしか配置されないため、出品のクロスのような2配置は無い。
 */
export type TradeCollectionAuctionGroup = {
  streamer: TradeStreamerSummary;
  auctions: TradeAuctionDto[];
  total: number;
  latestCreatedAt: string;
};

// -----------------------------------------------------------------------------
// SQL fragments (outer references only through qualifiedColumn, literal inner
// aliases — same conventions as src/lib/trade.ts)
// -----------------------------------------------------------------------------

const sellerMeta = alias(usersTable, "auction_seller");
const auctionStreamerMeta = alias(streamersTable, "auction_streamer");
// #2079: the collection whose section an auction is placed under (always the
// offered side; unlike offers, auctions have no wanted side).
const collectionStreamerMeta = alias(streamersTable, "collection_auction_streamer");

/** The streamer summary of the collection a ranked auction is placed under. */
function collectionStreamerFields() {
  return {
    id: collectionStreamerMeta.id,
    twitchUsername: collectionStreamerMeta.twitch_username,
    twitchDisplayName: collectionStreamerMeta.twitch_display_name,
    twitchProfileImageUrl: collectionStreamerMeta.twitch_profile_image_url,
  };
}
const bidderMeta = alias(usersTable, "auction_bidder");
const bidCardJoin = alias(cardsTable, "bid_card");

/** Effective phase (TradeAuctionPhase) of the outer trade_auctions row. */
function auctionPhaseExpr() {
  const status = qualifiedColumn(auctionsTable.status);
  return sql<TradeAuctionPhase>`(CASE
    WHEN ${status} = 'completed' THEN 'completed'
    WHEN ${status} = 'cancelled' THEN 'cancelled'
    WHEN ${status} <> 'open' THEN 'expired'
    WHEN clock_timestamp() < ${qualifiedColumn(auctionsTable.ends_at)} THEN 'bidding'
    WHEN public.trade_auction_holds_cards(${qualifiedColumn(auctionsTable.id)}) THEN 'selecting'
    ELSE 'expired'
  END)`;
}

/** Active bids of the outer auction (bigint → number). */
function activeBidCountExpr() {
  return sql<number>`(
    SELECT count(*)
    FROM public.trade_auction_bids AS counted_bid
    WHERE counted_bid.auction_id = ${qualifiedColumn(auctionsTable.id)}
      AND counted_bid.status = 'active'
  )`.mapWith(Number);
}

/**
 * The viewer's latest non-withdrawn bid on the outer auction as one JSON
 * object (or NULL). Only the viewer's own row is ever read, so no other
 * bidder's content reaches the Worker.
 */
function viewerBidExpr(viewerUserId: SQL) {
  return sql<RpcRecord | null>`(
    SELECT jsonb_build_object(
      'id', own_bid.id,
      'auctionId', own_bid.auction_id,
      'bidCardId', own_bid.bid_card_id,
      'bidStreamerId', own_bid.bid_streamer_id,
      'bidCard', own_bid.bid_card_snapshot,
      'quantity', own_bid.quantity,
      'isCrossChannel', own_bid.is_cross_channel,
      'status', own_bid.status,
      'holds', public.trade_auction_holds_cards(own_bid.auction_id),
      'settleable', public.trade_auction_bid_unsettleable_reason(own_bid.id) IS NULL,
      'createdAt', own_bid.created_at
    )
    FROM public.trade_auction_bids AS own_bid
    WHERE own_bid.auction_id = ${qualifiedColumn(auctionsTable.id)}
      AND own_bid.bidder_user_id = ${viewerUserId}
      AND own_bid.status <> 'withdrawn'
    ORDER BY own_bid.created_at DESC, own_bid.id DESC
    LIMIT 1
  )`;
}

function auctionFields(viewerUserId: SQL | null) {
  return {
    auction: auctionsTable,
    phase: auctionPhaseExpr(),
    bidCount: activeBidCountExpr(),
    viewerUserId: viewerUserId
      ? sql<string | null>`${viewerUserId}`
      : sql<string | null>`NULL::uuid`,
    myBid: viewerUserId ? viewerBidExpr(viewerUserId) : sql<RpcRecord | null>`NULL`,
    seller: {
      id: sellerMeta.id,
      twitchUsername: sellerMeta.twitch_username,
      twitchDisplayName: sellerMeta.twitch_display_name,
      twitchProfileImageUrl: sellerMeta.twitch_profile_image_url,
    },
    offeredStreamer: {
      id: auctionStreamerMeta.id,
      twitchUsername: auctionStreamerMeta.twitch_username,
      twitchDisplayName: auctionStreamerMeta.twitch_display_name,
      twitchProfileImageUrl: auctionStreamerMeta.twitch_profile_image_url,
    },
  };
}

type AuctionRow = {
  auction: typeof auctionsTable.$inferSelect;
  phase: TradeAuctionPhase;
  bidCount: number;
  viewerUserId: string | null;
  myBid: RpcRecord | null;
  seller: { id: string | null; twitchUsername: string | null; twitchDisplayName: string | null; twitchProfileImageUrl: string | null } | null;
  offeredStreamer: { id: string | null; twitchUsername: string | null; twitchDisplayName: string | null; twitchProfileImageUrl: string | null } | null;
};

function toUser(row: AuctionRow["seller"]): TradeUserSummary | null {
  if (!row?.id) return null;
  return {
    twitchUsername: row.twitchUsername ?? "",
    twitchDisplayName: row.twitchDisplayName ?? "",
    twitchProfileImageUrl: row.twitchProfileImageUrl ?? null,
  };
}

function toStreamer(row: AuctionRow["offeredStreamer"]): TradeStreamerSummary | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    twitchUsername: row.twitchUsername ?? "",
    twitchDisplayName: row.twitchDisplayName ?? "",
    twitchProfileImageUrl: row.twitchProfileImageUrl ?? null,
  };
}

function bidStateOf(status: string, holds: boolean): TradeAuctionBidState {
  if (status === "active") return holds ? "active" : "released";
  return status as TradeAuctionBidStatus;
}

/** Bid JSON built by viewerBidExpr / the seller's bid list → DTO. */
function toBidDto(record: RpcRecord): TradeAuctionBidDto {
  const status = String(record.status ?? "");
  return {
    id: String(record.id),
    auctionId: String(record.auctionId),
    bidCardId: typeof record.bidCardId === "string" ? record.bidCardId : null,
    bidStreamerId: String(record.bidStreamerId),
    bidCard: normalizeSnapshot(record.bidCard),
    quantity: Number(record.quantity),
    isCrossChannel: record.isCrossChannel === true,
    status,
    state: bidStateOf(status, record.holds === true),
    createdAt: String(record.createdAt),
    settleable: record.settleable === true,
  };
}

function toAuctionDto(row: AuctionRow): TradeAuctionDto {
  const auction = row.auction;
  const isOwn = row.viewerUserId !== null && auction.seller_user_id === row.viewerUserId;
  const dto: TradeAuctionDto = {
    id: auction.id,
    offeredCardId: auction.offered_card_id,
    offeredStreamerId: auction.offered_streamer_id,
    offeredCard: normalizeSnapshot(auction.offered_card_snapshot),
    endsAt: auction.ends_at,
    selectionDeadline: auction.selection_deadline,
    status: auction.status,
    phase: row.phase,
    bidCount: Number(row.bidCount),
    createdAt: auction.created_at,
    completedAt: auction.completed_at,
    seller: toUser(row.seller),
    offeredStreamer: toStreamer(row.offeredStreamer),
  };
  if (row.viewerUserId !== null) {
    dto.isOwnAuction = isOwn;
    if (isOwn) {
      dto.offeredUserCardId = auction.offered_user_card_id;
    } else {
      dto.myBid = row.myBid ? toBidDto(row.myBid) : null;
    }
  }
  return dto;
}

/**
 * Read-time image mask for a page of auction DTOs (#2070): the offered card of
 * each auction plus the viewer's own bid card, in ONE statement. Rows are never
 * dropped (paging/hasMore stay intact); only imageUrl is nulled.
 *
 * The viewer id comes from the page SELECT itself (NULL for anonymous), so no
 * extra users lookup is needed.
 */
async function maskAuctionListImages(
  auctions: TradeAuctionDto[],
  viewerUserId: string | null,
): Promise<TradeAuctionDto[]> {
  if (auctions.length === 0) return auctions;
  const masked = await maskTradeCardImages(
    auctions.flatMap((auction) => [
      { cardId: auction.offeredCardId, snapshot: auction.offeredCard },
      ...(auction.myBid
        ? [{ cardId: auction.myBid.bidCardId, snapshot: auction.myBid.bidCard }]
        : []),
    ]),
    viewerUserId,
  );
  let index = 0;
  return auctions.map((auction) => {
    const offeredCard = masked[index++];
    // Keep the optional key absent (instead of `myBid: undefined`) when the
    // auction has no viewer bid, so DTO shape tests and `in` checks stay true.
    if (!auction.myBid) return { ...auction, offeredCard };
    const myBid = { ...auction.myBid, bidCard: masked[index++] };
    return { ...auction, offeredCard, myBid };
  });
}

/**
 * Run a read; the missing auction schema (deploy window) becomes
 * TradeAuctionUnavailableError so routes answer 503 instead of 500.
 */
async function guardAuctionRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isTradeAuctionSchemaMissingError(error)) throw new TradeAuctionUnavailableError();
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/**
 * WHERE 条件 shared by the auction board and the hub's per-collection list
 * (#2079 で抽出).
 *
 * Gates for everybody (the seller included, like the regular board): the
 * auction still holds its card, active offered card and trade_enabled.
 * Visibility: the offered card must be visible to the viewer (cardVisibleTo);
 * the seller always sees their own. cardVisibleTo now uses the row rule
 * (owned OR show_unowned_cards) and no longer reads the item columns, but
 * withoutItemColumns is still threaded from the shared deploy-window fallback
 * so every statement of one request shares the same decision.
 */
function auctionBoardConditions(viewerUserId: SQL | null, withoutItemColumns: boolean) {
  const visible = cardVisibleTo(
    auctionsTable.offered_card_id,
    viewerUserId,
    withoutItemColumns,
  );
  return [
    eq(auctionsTable.status, "open"),
    sql`public.trade_auction_holds_cards(${qualifiedColumn(auctionsTable.id)})`,
    cardIsActive(auctionsTable.offered_card_id),
    tradeEnabledGate(auctionsTable.offered_streamer_id),
    viewerUserId ? or(eq(auctionsTable.seller_user_id, viewerUserId), visible)! : visible,
  ];
}

/**
 * GET /api/trades/auctions: auctions that still hold their card (bidding or
 * selecting), filtered in SQL so LIMIT/hasMore are computed over the visible
 * set only (same reasoning as listTradeOffers).
 *
 *   in_channel    — auctions of `streamerId`
 *   cross_channel — auctions of OTHER channels that a viewer of
 *                   `streamerId`'s board could bid on with this channel's
 *                   cards: both channels allow trade and cross-channel trade.
 *                   An auction has no fixed "wanted" side, so this is the
 *                   counterpart of the regular cross tab (offers touching
 *                   this channel) for the currency side.
 *
 * Gates for everybody (the seller included, like the regular board): active
 * offered card and trade_enabled. Visibility: the offered card must be
 * visible to the viewer (cardVisibleTo); the seller always sees their own.
 */
export async function listTradeAuctions(input: {
  streamerId: string;
  scope: TradeScope;
  page: number;
  twitchUserId?: string;
}) {
  const viewerUserId = input.twitchUserId ? viewerUserIdOf(input.twitchUserId) : null;
  const conditionsFor = (withoutItemColumns: boolean) => {
    const conditions = auctionBoardConditions(viewerUserId, withoutItemColumns);
    if (input.scope === "cross_channel") {
      conditions.push(
        ne(auctionsTable.offered_streamer_id, input.streamerId),
        crossEnabledGate(auctionsTable.offered_streamer_id),
        sql`EXISTS (
          SELECT 1 FROM ${streamersTable} AS board_streamer
          WHERE board_streamer.id = ${input.streamerId}
            AND board_streamer.trade_enabled = TRUE
            AND board_streamer.cross_channel_trade_enabled = TRUE
        )`,
      );
    } else {
      conditions.push(eq(auctionsTable.offered_streamer_id, input.streamerId));
    }
    return conditions;
  };

  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  const rows = await guardAuctionRead(() =>
    withUnownedCardItemColumnFallback((withoutItemColumns) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select(auctionFields(viewerUserId))
        .from(auctionsTable)
        .leftJoin(sellerMeta, eq(sellerMeta.id, auctionsTable.seller_user_id))
        .leftJoin(auctionStreamerMeta, eq(auctionStreamerMeta.id, auctionsTable.offered_streamer_id))
        .where(and(...conditionsFor(withoutItemColumns)))
        // Soonest deadline first: that is what a bidder acts on.
        .orderBy(asc(auctionsTable.ends_at), asc(auctionsTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade-auction:list",
    { idempotent: true },
  ))) as AuctionRow[];

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    auctions: await maskAuctionListImages(
      pageRows.map(toAuctionDto),
      rows[0]?.viewerUserId ?? null,
    ),
    page: input.page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
}

/**
 * ハブのコレクション別オークション一覧 (#2079)。
 *
 * 出品一覧と同じく、所持する全コレクション分を1クエリで取る。配置先は
 * offered_streamer_id だけ（オークションに wanted 側は無い）。先頭
 * TRADE_COLLECTION_PREVIEW_SIZE 件は ROW_NUMBER() の外側 WHERE で SQL 内で
 * 切り、total は COUNT OVER、
 * latestCreatedAt は MAX OVER で全件から返す。
 *
 * sort は newest（created_at DESC）と ending_soon（ends_at ASC）の2つだけ。
 * 締切が近い順はオークションにだけ意味がある。レアリティ順を作らない理由は
 * src/lib/trade.ts の TradeCollectionSort を参照。
 *
 * ゲート・可視性・DTO・画像マスクは listTradeAuctions と同じ
 * auctionBoardConditions / toAuctionDto / maskAuctionListImages を使う。
 */
export async function listTradeAuctionsByCollection(input: {
  twitchUserId: string;
  /** undefined: 所持する全コレクションの先頭 TRADE_COLLECTION_PREVIEW_SIZE 件。 */
  streamerId?: string;
  sort: TradeCollectionSort;
  /** streamerId 指定時のみ使う（1始まり）。 */
  page?: number;
}): Promise<TradeCollectionAuctionGroup[]> {
  const viewerUserId = viewerUserIdOf(input.twitchUserId);
  const page = input.page ?? 1;
  const offset = (page - 1) * TRADE_PAGE_SIZE;

  const rows = await guardAuctionRead(() =>
    withUnownedCardItemColumnFallback((withoutItemColumns) => withDbRetry(
    async () => {
      const { db } = await getDb();
      const partition = qualifiedColumn(auctionsTable.offered_streamer_id);
      const endsAt = qualifiedColumn(auctionsTable.ends_at);
      const auctionId = qualifiedColumn(auctionsTable.id);
      // 第1キー: 入札中（まだ締切前）を先、選択待ちを後ろにする真偽値。
      // auctionBoardConditions が trade_auction_holds_cards() で「入札中」と
      // 「選択待ち」だけに絞っているため、ここで ends_at を過ぎている行は
      // 選択待ち（有効な入札があり、選択期限内）と同義。now() ではなく
      // clock_timestamp() を使うのは、holds_cards が同じ clock_timestamp()
      // で境界を判定しているため。now() はトランザクション開始時刻で固定
      // され、締切をまたいだときに DB 関数の判定と食い違いうる。
      const isSelecting = sql<boolean>`(${endsAt} <= clock_timestamp())`;
      // 入札中は ends_at ASC（締切が近い順）。選択待ちは ends_at DESC
      // （直近に締め切られた順）で、/trade/mine が created_at DESC で
      // 新しい順に出す既存の流儀に合わせる。CASE が NULL になるのは
      // 相手側のバケットの行だけなので、同じバケット内では次のキーが効く。
      const orderBy = input.sort === "ending_soon"
        ? sql`${isSelecting} ASC,
            CASE WHEN ${isSelecting} THEN ${endsAt} END DESC,
            CASE WHEN ${endsAt} > clock_timestamp() THEN ${endsAt} END ASC,
            ${auctionId} ASC`
        : sql`${qualifiedColumn(auctionsTable.created_at)} DESC, ${auctionId} DESC`;
      const ranked = db
        .select({
          auctionId: auctionsTable.id,
          placementStreamerId: auctionsTable.offered_streamer_id,
          rn: sql<number>`row_number() OVER (
            PARTITION BY ${partition}
            ORDER BY ${orderBy}
          )`.mapWith(Number).as("rn"),
          total: sql<number>`count(*) OVER (
            PARTITION BY ${partition}
          )`.mapWith(Number).as("total"),
          // 生 SQL は Drizzle の列デコーダを通らないため MAX(timestamptz) は
          // ドライバ設定により Date / 文字列のどちらでも返りうる。DTO へ渡す
          // 前に toIsoTimestamp で string にそろえる。
          latestCreatedAt: sql<string | Date>`max(${qualifiedColumn(auctionsTable.created_at)}) OVER (
            PARTITION BY ${partition}
          )`.as("latestCreatedAt"),
        })
        .from(auctionsTable)
        .where(and(
          ...auctionBoardConditions(viewerUserId, withoutItemColumns),
          sql`${partition} IN ${collectedStreamerIdsSubquery(input.twitchUserId)}`,
          // Push the single-collection filter below the window (the hub path
          // has no streamerId and ranks every owned collection).
          ...(input.streamerId
            ? [eq(auctionsTable.offered_streamer_id, input.streamerId)]
            : []),
        ))
        .as("ranked_collection_auctions");

      const rankedConditions = input.streamerId
        ? [
          eq(ranked.placementStreamerId, input.streamerId),
          ...(page > 1 ? [gt(ranked.rn, offset)] : []),
          lte(ranked.rn, offset + TRADE_PAGE_SIZE),
        ]
        : [lte(ranked.rn, TRADE_COLLECTION_PREVIEW_SIZE)];

      return db
        .select({
          ...auctionFields(viewerUserId),
          placement: collectionStreamerFields(),
          placementStreamerId: ranked.placementStreamerId,
          rn: ranked.rn,
          total: ranked.total,
          latestCreatedAt: ranked.latestCreatedAt,
        })
        .from(ranked)
        .innerJoin(auctionsTable, eq(auctionsTable.id, ranked.auctionId))
        .leftJoin(sellerMeta, eq(sellerMeta.id, auctionsTable.seller_user_id))
        .leftJoin(auctionStreamerMeta, eq(auctionStreamerMeta.id, auctionsTable.offered_streamer_id))
        .leftJoin(
          collectionStreamerMeta,
          eq(collectionStreamerMeta.id, ranked.placementStreamerId),
        )
        .where(and(...rankedConditions))
        .orderBy(asc(ranked.placementStreamerId), asc(ranked.rn));
    },
    "trade-auction:list-collections",
    { idempotent: true },
  ))) as Array<AuctionRow & {
    placement: AuctionRow["offeredStreamer"];
    placementStreamerId: string;
    rn: number;
    total: number;
    /** MAX(timestamptz): raw SQL bypasses the column decoder (see toIsoTimestamp). */
    latestCreatedAt: string | Date;
  }>;

  const masked = await maskAuctionListImages(
    rows.map(toAuctionDto),
    rows[0]?.viewerUserId ?? null,
  );

  const groups = new Map<string, TradeCollectionAuctionGroup>();
  rows.forEach((row, index) => {
    const streamer = toStreamer(row.placement);
    if (!streamer) return;
    let group = groups.get(streamer.id);
    if (!group) {
      group = {
        streamer,
        auctions: [],
        total: Number(row.total),
        latestCreatedAt: toIsoTimestamp(row.latestCreatedAt),
      };
      groups.set(streamer.id, group);
    }
    group.auctions.push(masked[index]);
  });
  return [...groups.values()];
}

/**
 * GET /api/trades/auctions/[id]. Returns null (→ 404) when the viewer may
 * not see the auction. Participants (the seller, and anybody with a
 * non-withdrawn bid) always see it, in any state. Everybody else sees it only
 * under the board conditions (holds cards, active card, trade_enabled,
 * visible), so a hidden card is indistinguishable from a missing auction.
 *
 * Bid contents (card, quantity, bidder) are returned to the seller for every
 * non-withdrawn bid, and to a bidder for their own bid only (myBid). Other
 * viewers get bidCount alone (spec, planning review M8).
 */
export async function getTradeAuction(input: { auctionId: string; twitchUserId?: string }) {
  const viewerUserId = input.twitchUserId ? viewerUserIdOf(input.twitchUserId) : null;
  // #2070: name-level visibility is a deploy-window-dependent fragment.
  const publicConditionFor = (withoutItemColumns: boolean) => and(
    eq(auctionsTable.status, "open"),
    sql`public.trade_auction_holds_cards(${qualifiedColumn(auctionsTable.id)})`,
    cardIsActive(auctionsTable.offered_card_id),
    tradeEnabledGate(auctionsTable.offered_streamer_id),
    cardVisibleTo(auctionsTable.offered_card_id, viewerUserId, withoutItemColumns),
  )!;
  const participantCondition = viewerUserId
    ? or(
      eq(auctionsTable.seller_user_id, viewerUserId),
      sql`EXISTS (
        SELECT 1 FROM public.trade_auction_bids AS participant_bid
        WHERE participant_bid.auction_id = ${qualifiedColumn(auctionsTable.id)}
          AND participant_bid.bidder_user_id = ${viewerUserId}
          AND participant_bid.status <> 'withdrawn'
      )`,
    )!
    : null;

  const rows = await guardAuctionRead(() =>
    withUnownedCardItemColumnFallback((withoutItemColumns) => withDbRetry(
    async () => {
      const { db } = await getDb();
      const publicCondition = publicConditionFor(withoutItemColumns);
      return db
        .select(auctionFields(viewerUserId))
        .from(auctionsTable)
        .leftJoin(sellerMeta, eq(sellerMeta.id, auctionsTable.seller_user_id))
        .leftJoin(auctionStreamerMeta, eq(auctionStreamerMeta.id, auctionsTable.offered_streamer_id))
        .where(and(
          eq(auctionsTable.id, input.auctionId),
          participantCondition ? or(participantCondition, publicCondition)! : publicCondition,
        ))
        .limit(1);
    },
    "trade-auction:detail",
    { idempotent: true },
  ))) as AuctionRow[];
  const row = rows[0];
  if (!row) return null;

  const auction = toAuctionDto(row);
  const viewerId = row.viewerUserId;
  if (!auction.isOwnAuction) {
    // #2070: mask the offered snapshot (and the viewer's own bid, if any) with
    // the same one-statement rule as every other read.
    const [maskedAuction] = await maskAuctionListImages([auction], viewerId);
    return { auction: maskedAuction, bids: null };
  }

  // Seller only: every non-withdrawn bid with its bidder (only reached by the
  // one user entitled to the contents). The image mask (#2070) is one more
  // statement, shared with the auction's own offered snapshot below.
  const bidRows = await guardAuctionRead(() => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          bid: bidsTable,
          holds: sql<boolean>`public.trade_auction_holds_cards(${qualifiedColumn(bidsTable.auction_id)})`,
          settleable: sql<boolean>`(public.trade_auction_bid_unsettleable_reason(${qualifiedColumn(bidsTable.id)}) IS NULL)`,
          bidder: {
            id: bidderMeta.id,
            twitchUsername: bidderMeta.twitch_username,
            twitchDisplayName: bidderMeta.twitch_display_name,
            twitchProfileImageUrl: bidderMeta.twitch_profile_image_url,
          },
        })
        .from(bidsTable)
        .leftJoin(bidderMeta, eq(bidderMeta.id, bidsTable.bidder_user_id))
        .where(and(eq(bidsTable.auction_id, input.auctionId), ne(bidsTable.status, "withdrawn")))
        .orderBy(asc(bidsTable.created_at), asc(bidsTable.id));
    },
    "trade-auction:detail-bids",
    { idempotent: true },
  ));

  // #2070: the seller's bid list and the auction itself are masked in ONE
  // statement. The mapping goes through the same toBidDto as myBid, so a mask
  // added there cannot be bypassed here (the previous hand-written copy was
  // exactly the kind of place that leaks).
  const bids = bidRows.map((bidRow): TradeAuctionBidDto => ({
    ...toBidDto({
      id: bidRow.bid.id,
      auctionId: bidRow.bid.auction_id,
      bidCardId: bidRow.bid.bid_card_id,
      bidStreamerId: bidRow.bid.bid_streamer_id,
      bidCard: bidRow.bid.bid_card_snapshot,
      quantity: bidRow.bid.quantity,
      isCrossChannel: bidRow.bid.is_cross_channel,
      status: bidRow.bid.status,
      holds: bidRow.holds,
      settleable: bidRow.settleable,
      createdAt: bidRow.bid.created_at,
    }),
    bidder: toUser(bidRow.bidder),
  }));
  const masked = await maskTradeCardImages(
    [
      { cardId: auction.offeredCardId, snapshot: auction.offeredCard },
      ...bids.map((bid) => ({ cardId: bid.bidCardId, snapshot: bid.bidCard })),
    ],
    viewerId,
  );
  return {
    auction: { ...auction, offeredCard: masked[0] },
    bids: bids.map((bid, index) => ({ ...bid, bidCard: masked[index + 1] })),
  };
}

export type TradeAuctionMineRole = "selling" | "bidding";

/**
 * GET /api/trades/auctions/mine. A separate endpoint from /api/trades/mine on
 * purpose (§4.6): a failure here (e.g. the deploy window) must not take the
 * existing "my trades" page down.
 *
 *   selling — the viewer's auctions in every state (newest first)
 *   bidding — the viewer's non-withdrawn bids with their auction (newest first)
 *
 * Not filtered by visibility/gates: the viewer chose / received these cards
 * (same policy as listMyTradeOffers). An unknown user matches nothing.
 */
export async function listMyTradeAuctions(
  twitchUserId: string,
  options: { role: TradeAuctionMineRole; page?: number },
) {
  const page = options.page ?? 1;
  const offset = (page - 1) * TRADE_PAGE_SIZE;
  const viewerUserId = viewerUserIdOf(twitchUserId);

  const rows = await guardAuctionRead(() => withDbRetry(
    async () => {
      const { db } = await getDb();
      const base = db
        .select(auctionFields(viewerUserId))
        .from(auctionsTable)
        .leftJoin(sellerMeta, eq(sellerMeta.id, auctionsTable.seller_user_id))
        .leftJoin(auctionStreamerMeta, eq(auctionStreamerMeta.id, auctionsTable.offered_streamer_id));
      if (options.role === "selling") {
        return base
          .where(eq(auctionsTable.seller_user_id, viewerUserId))
          .orderBy(desc(auctionsTable.created_at), desc(auctionsTable.id))
          .limit(TRADE_PAGE_SIZE + 1)
          .offset(offset);
      }
      // One row per auction the viewer bid on (myBid is the latest
      // non-withdrawn bid; a changed bid leaves withdrawn rows behind).
      return base
        .where(sql`EXISTS (
          SELECT 1 FROM public.trade_auction_bids AS mine_bid
          WHERE mine_bid.auction_id = ${qualifiedColumn(auctionsTable.id)}
            AND mine_bid.bidder_user_id = ${viewerUserId}
            AND mine_bid.status <> 'withdrawn'
        )`)
        .orderBy(desc(auctionsTable.created_at), desc(auctionsTable.id))
        .limit(TRADE_PAGE_SIZE + 1)
        .offset(offset);
    },
    "trade-auction:mine",
    { idempotent: true },
  )) as AuctionRow[];

  const hasMore = rows.length > TRADE_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, TRADE_PAGE_SIZE) : rows;
  return {
    // #2070: /mine has no row filter (the viewer chose/received these cards),
    // but the IMAGE rule still applies per card: offering/receiving a card is
    // not current ownership of the wanted/bid card, so only "owned now or
    // details public" keeps an image.
    auctions: await maskAuctionListImages(
      pageRows.map(toAuctionDto),
      rows[0]?.viewerUserId ?? null,
    ),
    page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore,
  };
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export async function createTradeAuction(input: {
  twitchUserId: string;
  offeredUserCardId: string;
  durationHours: TradeAuctionDurationHours;
  requestId: string;
}): Promise<TradeAuctionResult<{ auction: { id: string; endsAt: string; selectionDeadline: string; status: string }; idempotentReplay: boolean }>> {
  const { sql: query } = await getDb();
  const outcome = await runAuctionRpc("create_trade_auction", () => query<Array<{ result: unknown }>>`
    SELECT public.create_trade_auction(
      ${input.twitchUserId},
      ${input.offeredUserCardId}::uuid,
      ${input.durationHours}::integer,
      ${input.requestId}::uuid
    ) AS result
  `);
  if (!outcome.ok) return { kind: "error", code: outcome.code };
  const auction = requireRecord(outcome.result.auction, "auction");
  return {
    kind: "ok",
    auction: {
      id: requireUuid(auction.id, "auction id"),
      endsAt: String(auction.ends_at),
      selectionDeadline: String(auction.selection_deadline),
      status: String(auction.status),
    },
    idempotentReplay: outcome.result.idempotentReplay === true,
  };
}

/**
 * Visibility precheck of a bid (planning review M8), one statement:
 *   * the offered card must be visible to the bidder (else the auction is
 *     treated as not found, exactly like the board hiding it), and
 *   * the bid card must be visible to the bidder AND to the seller: the seller
 *     will see the bid contents, so a bid must not become a side channel that
 *     reveals a card name the seller is not entitled to see.
 * Everything the RPC classifies itself (unknown auction/user, idempotent
 * replay, self-bid, same card, inactive cards, gates) is delegated so that
 * those answers and their precedence stay in one place. Race note as in
 * precheckTradeAccept: a visibility switch a few ms later is not re-checked.
 * Known information bit: a bidder who can see the bid card learns from
 * TRADE_BID_CARD_UNAVAILABLE that the seller cannot (i.e. does not own a copy
 * in a non-revealing channel); no card name is revealed.
 */
async function precheckBidVisibility(input: {
  twitchUserId: string;
  auctionId: string;
  bidCardId: string;
  requestId: string;
}): Promise<TradeAuctionServiceErrorCode | null> {
  const bidderUserId = viewerUserIdOf(input.twitchUserId);
  // #2070: all three cardVisibleTo calls share the deploy-window flag. The
  // bid card is checked against BOTH the bidder and the seller (the seller
  // will see the bid contents), so both sides must use the same rule.
  const rows = await guardAuctionRead(() =>
    withUnownedCardItemColumnFallback((withoutItemColumns) => withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          bidderUserId: sql<string | null>`${bidderUserId}`,
          sellerUserId: auctionsTable.seller_user_id,
          isReplay: sql<boolean>`EXISTS (
            SELECT 1 FROM public.trade_auction_bids AS replay_bid
            WHERE replay_bid.bidder_user_id = ${bidderUserId}
              AND replay_bid.request_id = ${input.requestId}::uuid
          )`,
          offeredVisible: cardVisibleTo(
            auctionsTable.offered_card_id,
            bidderUserId,
            withoutItemColumns,
          ),
          bidCardVisibleToBidder: cardVisibleTo(bidCardJoin.id, bidderUserId, withoutItemColumns),
          bidCardVisibleToSeller: cardVisibleTo(
            bidCardJoin.id,
            qualifiedColumn(auctionsTable.seller_user_id),
            withoutItemColumns,
          ),
        })
        .from(auctionsTable)
        .leftJoin(bidCardJoin, eq(bidCardJoin.id, input.bidCardId))
        .where(eq(auctionsTable.id, input.auctionId))
        .limit(1);
    },
    "trade-auction:bid-precheck",
    { idempotent: true },
  )));
  const row = rows[0];
  if (!row || !row.bidderUserId) return null;
  if (row.isReplay === true) return null;
  if (row.sellerUserId === row.bidderUserId) return null;
  if (row.offeredVisible !== true) return "TRADE_AUCTION_NOT_FOUND";
  if (row.bidCardVisibleToBidder !== true || row.bidCardVisibleToSeller !== true) {
    return "TRADE_BID_CARD_UNAVAILABLE";
  }
  return null;
}

export async function placeTradeAuctionBid(input: {
  twitchUserId: string;
  auctionId: string;
  bidCardId: string;
  quantity: number;
  requestId: string;
}): Promise<TradeAuctionResult<{ bid: { id: string; auctionId: string; bidCardId: string; quantity: number; status: string }; replacedBidId: string | null; idempotentReplay: boolean }>> {
  let precheck: TradeAuctionServiceErrorCode | null;
  try {
    precheck = await precheckBidVisibility(input);
  } catch (error) {
    if (error instanceof TradeAuctionUnavailableError) {
      return { kind: "error", code: "TRADE_AUCTION_UNAVAILABLE" };
    }
    throw error;
  }
  if (precheck) return { kind: "error", code: precheck };

  const { sql: query } = await getDb();
  const outcome = await runAuctionRpc("place_trade_auction_bid", () => query<Array<{ result: unknown }>>`
    SELECT public.place_trade_auction_bid(
      ${input.twitchUserId},
      ${input.auctionId}::uuid,
      ${input.bidCardId}::uuid,
      ${input.quantity}::smallint,
      ${input.requestId}::uuid
    ) AS result
  `);
  if (!outcome.ok) return { kind: "error", code: outcome.code };
  const bid = requireRecord(outcome.result.bid, "bid");
  const replaced = outcome.result.replacedBidId;
  return {
    kind: "ok",
    bid: {
      id: requireUuid(bid.id, "bid id"),
      auctionId: requireUuid(bid.auction_id, "bid auction id"),
      bidCardId: String(bid.bid_card_id),
      quantity: Number(bid.quantity),
      status: String(bid.status),
    },
    replacedBidId: replaced === null || replaced === undefined ? null : requireUuid(replaced, "replaced bid id"),
    idempotentReplay: outcome.result.idempotentReplay === true,
  };
}

/**
 * Withdraw a bid. The RPC resolves the auction from the bid itself (lock order
 * auction → bid) and checks the bidder. Callers may pass the auction id taken
 * from the route path so it can be verified against the bid before acting.
 */
export async function withdrawTradeAuctionBid(input: {
  twitchUserId: string;
  bidId: string;
  auctionId?: string;
}): Promise<TradeAuctionResult<{ bidId: string; alreadyWithdrawn: boolean }>> {
  // The path's [id] is not otherwise consulted by the RPC (it resolves the
  // auction from the bid). Verify it against the bid's actual auction before
  // acting, so a mismatched URL cannot be recorded as that auction's audit
  // entry. A missing bid, or a bid that does not belong to [id], is reported
  // as "not found" rather than forwarded to the RPC.
  if (input.auctionId) {
    const { db } = await getDb();
    const rows = await db
      .select({ auctionId: bidsTable.auction_id })
      .from(bidsTable)
      .where(eq(bidsTable.id, input.bidId))
      .limit(1);
    if (rows.length === 0 || rows[0].auctionId !== input.auctionId) {
      return { kind: "error", code: "TRADE_AUCTION_BID_NOT_FOUND" };
    }
  }
  const { sql: query } = await getDb();
  const outcome = await runAuctionRpc("withdraw_trade_auction_bid", () => query<Array<{ result: unknown }>>`
    SELECT public.withdraw_trade_auction_bid(${input.twitchUserId}, ${input.bidId}::uuid) AS result
  `);
  if (!outcome.ok) return { kind: "error", code: outcome.code };
  return {
    kind: "ok",
    bidId: requireUuid(outcome.result.bidId, "bid id"),
    alreadyWithdrawn: outcome.result.alreadyWithdrawn === true,
  };
}

export async function cancelTradeAuction(input: {
  twitchUserId: string;
  auctionId: string;
}): Promise<TradeAuctionResult<{ auctionId: string; alreadyCancelled: boolean }>> {
  const { sql: query } = await getDb();
  const outcome = await runAuctionRpc("cancel_trade_auction", () => query<Array<{ result: unknown }>>`
    SELECT public.cancel_trade_auction(${input.twitchUserId}, ${input.auctionId}::uuid) AS result
  `);
  if (!outcome.ok) return { kind: "error", code: outcome.code };
  return {
    kind: "ok",
    auctionId: requireUuid(outcome.result.auctionId, "auction id"),
    alreadyCancelled: outcome.result.alreadyCancelled === true,
  };
}

/**
 * Settlement by the seller. The RPC re-validates gates, both cards'
 * is_active, the bid card's trade_wantable and ownership under row locks.
 * Visibility is NOT re-checked here (design change, see the design doc §4.4):
 * the seller already saw the bid contents when the bid was accepted under the
 * visibility rule, and settling transfers the bid copies TO the seller, so a
 * later visibility switch protects nothing; requiring it would leave a bid
 * that neither the seller can settle nor the bidder can withdraw.
 */
export async function settleTradeAuction(input: {
  twitchUserId: string;
  auctionId: string;
  bidId: string;
  requestId: string;
}): Promise<TradeAuctionResult<{
  auctionId: string;
  bidId: string;
  givenUserCardId: string;
  receivedUserCardIds: string[];
  quantity: number;
  completedAt: string;
  idempotentReplay: boolean;
}>> {
  const { sql: query } = await getDb();
  const outcome = await runAuctionRpc("settle_trade_auction", () => query<Array<{ result: unknown }>>`
    SELECT public.settle_trade_auction(
      ${input.twitchUserId},
      ${input.auctionId}::uuid,
      ${input.bidId}::uuid,
      ${input.requestId}::uuid
    ) AS result
  `);
  if (!outcome.ok) return { kind: "error", code: outcome.code };
  const result = outcome.result;
  const received = Array.isArray(result.receivedUserCardIds) ? result.receivedUserCardIds : null;
  if (!received) throw new Error("settle_trade_auction returned invalid receivedUserCardIds");
  const quantity = Number(result.quantity);
  // Every bid copy moved: the RPC transfers exactly `quantity` copies or
  // raises, so a different length is a contract violation (fail as 500).
  if (received.length !== quantity) {
    throw new Error("settle_trade_auction returned a transfer count mismatch");
  }
  return {
    kind: "ok",
    auctionId: requireUuid(result.auctionId, "auction id"),
    bidId: requireUuid(result.bidId, "bid id"),
    givenUserCardId: requireUuid(result.givenUserCardId, "given user card id"),
    receivedUserCardIds: received.map((value) => requireUuid(value, "received user card id")),
    quantity,
    completedAt: String(result.completedAt),
    idempotentReplay: result.idempotentReplay === true,
  };
}
