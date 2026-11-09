import { describe, expect, it } from "vitest";
import {
  auctionBidStateLabelKey,
  auctionPhaseLabelKey,
  parseTradeBoardTab,
  TRADE_AUCTION_DURATION_OPTIONS,
  tradeAuctionBoardPath,
  tradeAuctionCreatePath,
  tradeAuctionDetailPath,
  tradeAuctionTimeLeft,
} from "@/lib/trade-client";
import jaMessages from "../../messages/ja.json";
import enMessages from "../../messages/en.json";

/** Client helpers of the auction UI (#1791 PR-2). */
const NOW = Date.UTC(2026, 9, 18, 0, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("tradeAuctionTimeLeft", () => {
  it("shows days with hours, so a fresh 7-day auction is not rounded down to 6 days", () => {
    expect(tradeAuctionTimeLeft(at(168 * HOUR - MIN), NOW)).toEqual({ kind: "daysHours", days: 6, hours: 23 });
    expect(tradeAuctionTimeLeft(at(24 * HOUR), NOW)).toEqual({ kind: "daysHours", days: 1, hours: 0 });
  });

  it("shows hours with minutes below a day, minutes below an hour", () => {
    expect(tradeAuctionTimeLeft(at(24 * HOUR - 1), NOW)).toEqual({ kind: "hoursMinutes", hours: 23, minutes: 59 });
    expect(tradeAuctionTimeLeft(at(HOUR), NOW)).toEqual({ kind: "hoursMinutes", hours: 1, minutes: 0 });
    expect(tradeAuctionTimeLeft(at(HOUR - 1), NOW)).toEqual({ kind: "minutes", minutes: 59 });
    expect(tradeAuctionTimeLeft(at(MIN), NOW)).toEqual({ kind: "minutes", minutes: 1 });
  });

  it("is 'soon' in the last minute and 'passed' at/after the deadline or for a bad timestamp", () => {
    expect(tradeAuctionTimeLeft(at(MIN - 1), NOW)).toEqual({ kind: "soon" });
    expect(tradeAuctionTimeLeft(at(0), NOW)).toEqual({ kind: "passed" });
    expect(tradeAuctionTimeLeft(at(-HOUR), NOW)).toEqual({ kind: "passed" });
    expect(tradeAuctionTimeLeft("not a date", NOW)).toEqual({ kind: "passed" });
  });
});

describe("auction URLs", () => {
  it("board tab, detail and create paths", () => {
    expect(parseTradeBoardTab("auction")).toBe("auction");
    expect(parseTradeBoardTab(undefined)).toBe("offers");
    expect(parseTradeBoardTab(["auction"])).toBe("offers");
    expect(tradeAuctionBoardPath("s", "in_channel")).toBe("/trade/s?tab=auction");
    expect(tradeAuctionBoardPath("s", "cross_channel")).toBe("/trade/s?tab=auction&scope=cross");
    expect(tradeAuctionDetailPath("s", "a")).toBe("/trade/s/auctions/a");
    expect(tradeAuctionDetailPath("s", "a", "cross_channel")).toBe("/trade/s/auctions/a?scope=cross");
    expect(tradeAuctionCreatePath("s")).toBe("/trade/s/new?kind=auction");
  });

  it("offers exactly the server's durations (24h / 3d / 7d)", () => {
    expect(TRADE_AUCTION_DURATION_OPTIONS).toEqual([24, 72, 168]);
  });
});

describe("auction label keys", () => {
  it("maps every phase and bid state to a key that exists in ja and en", () => {
    const keys = [
      ...(["bidding", "selecting", "expired", "completed", "cancelled"] as const).map(auctionPhaseLabelKey),
      ...(["active", "won", "lost", "released", "withdrawn"] as const).flatMap((state) =>
        (["bidding", "selecting"] as const).map((phase) => auctionBidStateLabelKey(state, phase)),
      ),
    ];
    for (const key of keys) {
      expect(jaMessages.trade).toHaveProperty(key);
      expect(enMessages.trade).toHaveProperty(key);
    }
  });

  it("an active bid reads 'awaiting selection' once the auction is selecting", () => {
    expect(auctionBidStateLabelKey("active", "bidding")).toBe("auctionBidStateActive");
    expect(auctionBidStateLabelKey("active", "selecting")).toBe("auctionBidStateSelecting");
    expect(auctionBidStateLabelKey("released", "expired")).toBe("auctionBidStateReleased");
    expect(auctionBidStateLabelKey("won", "completed")).toBe("auctionBidStateWon");
    expect(auctionBidStateLabelKey("lost", "completed")).toBe("auctionBidStateLost");
  });
});

describe("auction messages", () => {
  it("ja and en define the same trade keys", () => {
    expect(Object.keys(enMessages.trade).sort()).toEqual(Object.keys(jaMessages.trade).sort());
  });
});
