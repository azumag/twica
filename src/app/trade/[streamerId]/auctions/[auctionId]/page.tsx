import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import {
  getTradeBoardStreamer,
  listTradeableOwnedCopies,
  listWantableCards,
} from "@/lib/trade";
import { TRADE_MAX_BID_QUANTITY } from "@/lib/trade-auction";
import {
  parseTradeScope,
  tradeAuctionBoardPath,
  tradeAuctionDetailPath,
  tradeLoginHref,
} from "@/lib/trade-client";
import { isCanonicalUuid } from "@/lib/uuid-validation";
import TradeAuctionDetail, { type TradeAuctionBidCard } from "@/components/TradeAuctionDetail";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Auction detail /trade/[streamerId]/auctions/[auctionId] (#1791, design §6).
 * Readable without login, like the board.
 *
 * A page (not a modal on the board) because bidding reuses the listing
 * flow's Step 2 card picker, whose candidates must be prepared on the server:
 * `[streamerId]` is the board the viewer bids from, and its cards are offered
 * as bid candidates. The auction itself is fetched by <TradeAuctionDetail>
 * through GET /api/trades/auctions/[id] (rate-limited, and it applies the
 * bid-content disclosure rule), so this component never reads auction data.
 *
 * Bid candidates: listWantableCards (trade_wantable + the SQL visibility
 * rule, #1790) intersected with the viewer's copies (listTradeableOwnedCopies,
 * whose `isListed` covers offer / auction / bid locks). Only cards the viewer
 * owns can be bid, so names of unowned cards are not even sent. The RPC
 * re-checks everything under row locks.
 *
 * The channel's trade setting does not gate this page: a participant must
 * still be able to see, and withdraw, a bid that became unsettleable because
 * the setting was turned off (spec). Candidates are simply not loaded then.
 */
export default async function TradeAuctionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ streamerId: string; auctionId: string }>;
  searchParams: SearchParams;
}) {
  const [{ streamerId, auctionId }, query] = await Promise.all([params, searchParams]);
  if (!isCanonicalUuid(auctionId)) notFound();
  const scope = parseTradeScope(query.scope);
  const session = await getSession();
  const [streamer, t] = await Promise.all([
    getTradeBoardStreamer(streamerId),
    getTranslations("trade"),
  ]);
  if (!streamer) notFound();

  let bidCards: TradeAuctionBidCard[] = [];
  if (session && streamer.tradeEnabled) {
    // Bid candidates are only useful to a non-seller viewer while the auction
    // is still accepting bids (O3). Sellers never bid, and once the auction
    // has left the bidding phase the form is not rendered. Skip the two
    // queries in those cases, including on router.refresh() after a write.
    // getTradeAuction is guarded so a missing export (e.g. an older mock) falls
    // back to loading the candidates, preserving the previous behaviour.
    let needsBidCards = true;
    // Loaded dynamically so a module mock that omits it (older tests) does not
    // break the import; the fallback keeps loading candidates in that case.
    let getTradeAuction: unknown = null;
    try {
      const tradeAuctionModule = await import("@/lib/trade-auction");
      getTradeAuction = (tradeAuctionModule as { getTradeAuction?: unknown }).getTradeAuction ?? null;
    } catch {
      getTradeAuction = null;
    }
    if (typeof getTradeAuction === "function") {
      const auctionDetail = await getTradeAuction({ auctionId, twitchUserId: session.twitchUserId }).catch(() => null);
      needsBidCards = auctionDetail
        ? !auctionDetail.auction.isOwnAuction && auctionDetail.auction.phase === "bidding"
        : false;
    }
    if (needsBidCards) {
      const [copies, wantable] = await Promise.all([
        listTradeableOwnedCopies(session.twitchUserId, streamer.id),
        listWantableCards(session.twitchUserId, streamer.id),
      ]);
      const freeByCard = new Map<string, number>();
      for (const copy of copies) {
        if (!copy.isListed) freeByCard.set(copy.cardId, (freeByCard.get(copy.cardId) ?? 0) + 1);
      }
      // Only the fields the picker renders are serialized to the client.
      bidCards = wantable
        .filter((card) => card.isOwned)
        .map((card) => ({
          cardId: card.cardId,
          name: card.name,
          rarity: card.rarity,
          imageUrl: card.imageUrl,
          freeCount: freeByCard.get(card.cardId) ?? 0,
        }));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={tradeAuctionBoardPath(streamer.id, scope)}
        className="text-sm text-purple-400 transition-colors hover:text-purple-300"
      >
        ← {t("auctionBackToBoard")}
      </Link>
      <h1 className="mt-3 mb-4 text-2xl font-bold text-white">
        {t("auctionDetailPageTitle", { channelName: streamer.twitchDisplayName })}
      </h1>
      <TradeAuctionDetail
        auctionId={auctionId}
        isLoggedIn={Boolean(session)}
        loginHref={tradeLoginHref(tradeAuctionDetailPath(streamer.id, auctionId, scope))}
        bidCards={bidCards}
        maxBidQuantity={TRADE_MAX_BID_QUANTITY}
      />
    </div>
  );
}
