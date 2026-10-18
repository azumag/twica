import type { TradeAuctionBidDto, TradeAuctionDto } from "@/lib/trade-auction";

/**
 * Shared fixtures for the auction UI tests (#1791 PR-2). Shapes follow the
 * DTOs of src/lib/trade-auction.ts as returned by the API.
 */
export const NOW = new Date("2026-10-18T00:00:00.000Z").getTime();
const HOUR = 3_600_000;

export function makeBid(overrides: Partial<TradeAuctionBidDto> = {}): TradeAuctionBidDto {
  return {
    id: "bid-1",
    auctionId: "auction-1",
    bidCardId: "card-coin",
    bidStreamerId: "s-1",
    bidCard: { name: "Coin", rarity: "common", imageUrl: null },
    quantity: 3,
    isCrossChannel: false,
    status: "active",
    state: "active",
    createdAt: "2026-10-17T00:00:00.000Z",
    settleable: true,
    ...overrides,
  };
}

export function makeAuction(overrides: Partial<TradeAuctionDto> = {}): TradeAuctionDto {
  return {
    id: "auction-1",
    offeredCardId: "card-dragon",
    offeredStreamerId: "s-1",
    offeredCard: { name: "Auction Dragon", rarity: "epic", imageUrl: null },
    // 2 days 5 hours after NOW.
    endsAt: new Date(NOW + 53 * HOUR).toISOString(),
    selectionDeadline: new Date(NOW + 125 * HOUR).toISOString(),
    status: "open",
    phase: "bidding",
    bidCount: 0,
    createdAt: "2026-10-16T00:00:00.000Z",
    completedAt: null,
    seller: { twitchUsername: "alice", twitchDisplayName: "Alice", twitchProfileImageUrl: null },
    offeredStreamer: { id: "s-1", twitchUsername: "chan", twitchDisplayName: "ChanOne", twitchProfileImageUrl: null },
    isOwnAuction: false,
    myBid: null,
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
