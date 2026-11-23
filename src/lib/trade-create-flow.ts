import { asc, sql } from "drizzle-orm";

import { collectedStreamerIdsSubquery } from "@/lib/collected-streamers";
import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";
import { withLiveDirectorySettingsColumnFallback } from "@/lib/db/streamers-safe-columns";
import { loadAllowedWantedByOffered } from "@/lib/trade-wanted-restrictions";
import {
  getTradeBoardStreamer,
  listTradeableOwnedCopies,
  listWantableCards,
  type TradeableOwnedCopy,
  type WantableCard,
} from "@/lib/trade";

/**
 * Server-side data for the unified listing flow /trade/new (#2080).
 *
 * The flow chooses (1) kind, (2) the collection to give, (3) the collection to
 * want (offers only), then (4) the cards in <TradeCreateForm>. Everything the
 * page needs to render the collection choices is loaded here, so the page file
 * stays a thin composition and none of the old /trade/[streamerId]/new loading
 * rules are copied into it.
 */

/**
 * One collection the viewer owns a card of, with the two trade settings the
 * flow gates on. The definition of "owning a collection" is the shared
 * collectedStreamerIdsSubquery (the same one the hub's collection list uses),
 * so a channel can never appear in one screen and disappear from the other.
 */
export type TradeCreateCollection = {
  id: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
  tradeEnabled: boolean;
  crossChannelTradeEnabled: boolean;
};

/**
 * The viewer's collections, in display-name order, from ONE statement.
 *
 * N+1 avoidance is the point: the step-2/step-3 lists need the name, icon and
 * both trade flags of every owned collection, and asking per collection would
 * make a page render cost grow with the collection count. All flags come from
 * the same row, so the candidate list and its disabled reasons are consistent
 * with each other.
 *
 * Deploy window (#722): the trade columns can be missing before the migration
 * is applied. The shared fallback retries without them and both flags fail
 * closed to false, exactly like getTradeBoardStreamer; the flow then shows
 * every collection as trade-disabled instead of throwing.
 */
export async function listViewerTradeCollections(
  twitchUserId: string,
): Promise<TradeCreateCollection[]> {
  const rows = await withLiveDirectorySettingsColumnFallback((useSafeColumns) =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            twitchDisplayName: streamersTable.twitch_display_name,
            twitchProfileImageUrl: streamersTable.twitch_profile_image_url,
            tradeEnabled: useSafeColumns
              ? sql<boolean>`FALSE`
              : sql<boolean>`${streamersTable.trade_enabled}`,
            crossChannelTradeEnabled: useSafeColumns
              ? sql<boolean>`FALSE`
              : sql<boolean>`${streamersTable.cross_channel_trade_enabled}`,
          })
          .from(streamersTable)
          .where(sql`${streamersTable.id} IN ${collectedStreamerIdsSubquery(twitchUserId)}`)
          // Same deterministic order as listCrossTradePartnerStreamers, so a
          // collection button does not jump between renders.
          .orderBy(asc(streamersTable.twitch_display_name), asc(streamersTable.id));
      },
      "trade:create-collections",
      { idempotent: true },
    ),
  );

  return rows.map((row) => ({
    id: row.id,
    twitchDisplayName: row.twitchDisplayName,
    twitchProfileImageUrl: row.twitchProfileImageUrl,
    tradeEnabled: row.tradeEnabled === true,
    crossChannelTradeEnabled: row.crossChannelTradeEnabled === true,
  }));
}

/**
 * Why a candidate collection cannot be selected. The key is mapped to copy in
 * the page, so the gate stays independent of the locale.
 */
export type TradeCreateCollectionBlockReason =
  | "trade_disabled"
  | "give_cross_disabled"
  | "want_cross_disabled"
  | "want_no_tradeable_card";

export type TradeCreateCollectionGate =
  | { selectable: true }
  | { selectable: false; reason: TradeCreateCollectionBlockReason };

/**
 * Step 2 gate: the give collection must have trading enabled. The page renders
 * this gate's result and also uses it to decide whether a ?give= value in the
 * URL is accepted, so "shown as selectable" and "accepted by the server" can
 * never disagree.
 */
export function giveCollectionGate(
  collection: TradeCreateCollection,
): TradeCreateCollectionGate {
  return collection.tradeEnabled
    ? { selectable: true }
    : { selectable: false, reason: "trade_disabled" };
}

/**
 * Step 3 gate. `want.id === give.id` is the in-channel trade and needs no
 * cross permission. Otherwise the cross-channel rules of
 * listCrossTradePartnerStreamers are applied through `crossPartnerIds`: that
 * function is the allowlist of channels the viewer may ask from (base channel
 * allows cross, partner allows trade + cross, and the viewer owns an ACTIVE
 * card of the partner). Passing its result in keeps the screen and the
 * catalogue read on exactly the same set, instead of re-implementing the SQL
 * conditions in TypeScript.
 *
 * The order of the reason checks is deliberate: when more than one condition
 * fails, the first check describes the outermost blocker (the give side's
 * permission), which is what the viewer has to change first.
 */
export function wantCollectionGate(
  give: TradeCreateCollection,
  want: TradeCreateCollection,
  crossPartnerIds: ReadonlySet<string>,
): TradeCreateCollectionGate {
  if (want.id === give.id) return giveCollectionGate(give);
  if (!give.tradeEnabled) return { selectable: false, reason: "trade_disabled" };
  if (!give.crossChannelTradeEnabled) {
    return { selectable: false, reason: "give_cross_disabled" };
  }
  if (!want.tradeEnabled) return { selectable: false, reason: "trade_disabled" };
  if (!want.crossChannelTradeEnabled) {
    return { selectable: false, reason: "want_cross_disabled" };
  }
  // The list also requires an active owned copy; a collection with only
  // retired cards therefore lands here and gets the "no tradable card" copy.
  if (!crossPartnerIds.has(want.id)) {
    return { selectable: false, reason: "want_no_tradeable_card" };
  }
  return { selectable: true };
}

export type TradeCreateFormData = {
  ownedCopies: TradeableOwnedCopy[];
  wantableCards: WantableCard[];
  /**
   * 欲しいチャネルが未所持カードを行として公開しているか
   * （show_unowned_cards = revealsUnownedCards）。false なら候補は所持カードだけに
   * なるため「持っているカードのみ指定できる」案内を出す。
   */
  wantableRevealsUnownedCards: boolean;
  /**
   * 欲しいチャネルが未所持カードの名前を公開しているか
   * （revealsUnownedCardNames）。false なら未所持カードの name は "" で届き、
   * UI は表示番号 #N で選ぶ。このとき理由の案内を出す。
   */
  wantableRevealsUnownedNames: boolean;
  /**
   * 交換対象の制限(出品カードごとのホワイトリスト): 出品カード id → 選べる card id。
   * 対象は閲覧者の出品可能コピーのカードのうちルールを持つものだけ(キー無し =
   * 制限なし)。値は公開済みの候補(wantableCards)との交差で、閲覧者に非公開の
   * カード id・件数を含まない。
   */
  allowedWantedByOfferedCardId: Record<string, string[]>;
};

/**
 * Step 4 data, extracted from the former /trade/[streamerId]/new page so the
 * unified page only has to compose the step decisions and this loader remains
 * the single place that applies the catalogue privacy rules.
 *
 * `wantStreamerId = null` means an auction: it has no counterpart channel, so
 * no wanted catalogue is read at all and the client receives an empty list.
 * For offers, the wanted channel's two reveal flags (rows / names) decide the
 * form's notices, and listWantableCards has already applied the visibility rule
 * in SQL — this function only forwards its result, so hidden card names/images
 * are never serialized into the client props.
 */
export async function loadTradeCreateFormData(input: {
  viewerId: string;
  giveStreamerId: string;
  wantStreamerId: string | null;
}): Promise<TradeCreateFormData> {
  const [ownedCopies, wantableCards, wantStreamer] = await Promise.all([
    listTradeableOwnedCopies(input.viewerId, input.giveStreamerId),
    input.wantStreamerId
      ? listWantableCards(input.viewerId, input.wantStreamerId)
      : Promise.resolve<WantableCard[]>([]),
    input.wantStreamerId
      ? getTradeBoardStreamer(input.wantStreamerId)
      : Promise.resolve(null),
  ]);

  // 交換対象の制限。オークションは求めるカードを持たない(wantStreamerId = null)ので読まない。
  // 値は公開判定済みの wantableCards との交差だけを返す(非公開カード id をクライアントへ
  // 直列化しない)。UI 補助であり、権威は出品 API と応諾 RPC。
  const allowedWantedByOfferedCardId =
    input.wantStreamerId && wantableCards.length > 0
      ? await loadAllowedWantedByOffered(
          { offeredCardIds: [...new Set(ownedCopies.map((copy) => copy.cardId))] },
          new Set(wantableCards.map((card) => card.cardId)),
        )
      : {};

  return {
    ownedCopies,
    wantableCards,
    allowedWantedByOfferedCardId,
    // Fail closed if the channel disappeared between the candidate read and
    // this read: no notice (and no wrong claim) is better than a wrong one.
    //
    // 20261122 の項目別公開以降、行の可視性（show_unowned_cards）と名前の
    // 可視性（show_unowned_card_name）は独立している。名前が非公開でも行が
    // 見えていれば未所持カードは #N で選べるので、2つの案内を取り違えないよう
    // 別々のフラグとして渡す（C4a）。
    wantableRevealsUnownedCards: wantStreamer?.revealsUnownedCards ?? false,
    wantableRevealsUnownedNames: wantStreamer?.revealsUnownedCardNames ?? false,
  };
}

/**
 * Whether the auction schema (20261018030000) is applied.
 *
 * The old page only discovered an unmigrated auction deployment when the POST
 * failed, and the auction board discovers it from the API's 503. The stepped
 * page shows the kind choice BEFORE any API call, so it needs a preflight to
 * disable the auction choice / show the same "not available yet" notice at
 * step 1 or 2 instead of sending the viewer through a flow that cannot submit.
 *
 * `to_regclass` is a catalog lookup (no table scan) and the migration applies
 * the table and its RPCs together, so table existence is the right signal.
 * Deliberately no withDbRetry: this is advisory UI state, and a slow retry
 * would delay the page just to show a notice; any read failure is treated as
 * unavailable (the offer flow does not depend on this at all).
 *
 * Read the catalog through the same raw-SQL path as src/lib/trade-auction.ts
 * (`const { sql: query } = await getDb()` and a postgres.js tagged template).
 * Drizzle's `db.execute` had no other precedent in src/lib, and its result
 * shape is driver-specific: reading `rows[0]` from a different shape throws no
 * error, it just yields undefined and silently disables auctions forever. The
 * postgres.js client returns a real array, so the deny-by-default check below
 * observes the actual value. The integration test runs this against a migrated
 * PostgreSQL to keep the driver shape honest.
 */
export async function isTradeAuctionSchemaAvailable(): Promise<boolean> {
  try {
    const { sql: query } = await getDb();
    const rows = await query<Array<{ available: boolean }>>`
      SELECT to_regclass('public.trade_auctions') IS NOT NULL AS available
    `;
    // Deny-by-default: only an explicit TRUE enables the auction entry point.
    return rows[0]?.available === true;
  } catch {
    return false;
  }
}
