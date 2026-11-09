import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import TradeAuctionBoard from "@/components/TradeAuctionBoard";
import { clearTradeListCache } from "@/lib/use-trade-list";
import jaMessages from "../../../messages/ja.json";
import enMessages from "../../../messages/en.json";
import { jsonResponse, makeAuction, makeBid, NOW } from "./trade-auction-fixtures";

const ja = jaMessages.trade;
const trJa = createTranslator({ locale: "ja", messages: jaMessages, namespace: "trade" });
const trEn = createTranslator({ locale: "en", messages: enMessages, namespace: "trade" });

function renderBoard(
  props: Partial<React.ComponentProps<typeof TradeAuctionBoard>> = {},
  locale: "ja" | "en" = "ja",
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ja" ? jaMessages : enMessages}>
      <TradeAuctionBoard
        streamerId="s-1"
        scope="in_channel"
        isLoggedIn
        viewerKey="u:test"
        createHref="/trade/s-1/new?kind=auction"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("TradeAuctionBoard (#1791 board auction tab)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTradeListCache();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the auction list for the board's channel and scope", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auctions: [], hasMore: false }));
    renderBoard({ scope: "cross_channel" });
    await screen.findByText(ja.auctionEmptyState);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "https://x.test");
    expect(url.pathname).toBe("/api/trades/auctions");
    expect(url.searchParams.get("streamerId")).toBe("s-1");
    expect(url.searchParams.get("scope")).toBe("cross_channel");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("shows the card, the time left while bidding, the bid count and a detail link", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auctions: [makeAuction({ bidCount: 2 })], hasMore: false }));
    renderBoard();
    const row = (await screen.findByText("Auction Dragon")).closest("li")!;
    expect(within(row).getByText(ja.auctionPhaseBidding)).toBeInTheDocument();
    expect(within(row).getByText(trJa("auctionTimeLeftDaysHours", { days: 2, hours: 5 }))).toBeInTheDocument();
    expect(within(row).getByText(trJa("auctionBidCount", { count: 2 }))).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: ja.auctionRowDetailLink })).toHaveAttribute(
      "href",
      "/trade/s-1/auctions/auction-1",
    );
  });

  it("shows 'awaiting selection' instead of a countdown once the deadline passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      auctions: [makeAuction({ phase: "selecting", bidCount: 1, endsAt: new Date(NOW - 1000).toISOString() })],
      hasMore: false,
    }));
    renderBoard();
    const row = (await screen.findByText("Auction Dragon")).closest("li")!;
    expect(within(row).getByText(ja.auctionPhaseSelecting)).toBeInTheDocument();
    expect(within(row).queryByText(/残り/)).toBeNull();
  });

  it("marks the viewer's own auction and the viewer's own bid with its state", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      auctions: [
        makeAuction({ id: "a-own", isOwnAuction: true, myBid: undefined }),
        makeAuction({
          id: "a-bid",
          offeredCard: { name: "Other Card", rarity: "rare", imageUrl: null },
          myBid: makeBid({ auctionId: "a-bid" }),
        }),
      ],
      hasMore: false,
    }));
    renderBoard();
    const own = (await screen.findByText("Auction Dragon")).closest("li")!;
    expect(within(own).getByText(ja.auctionOwnBadge)).toBeInTheDocument();
    expect(within(own).getByRole("link", { name: ja.auctionRowManageLink })).toBeInTheDocument();
    const bid = screen.getByText("Other Card").closest("li")!;
    expect(
      within(bid).getByText(trJa("auctionRowMyBid", { card: "Coin", count: 3, state: ja.auctionBidStateActive })),
    ).toBeInTheDocument();
    expect(within(bid).getByRole("link", { name: ja.auctionRowMyBidLink })).toBeInTheDocument();
  });

  it("flags an own bid that can no longer be settled while the seller is selecting", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      auctions: [makeAuction({ phase: "selecting", bidCount: 1, myBid: makeBid({ settleable: false }) })],
      hasMore: false,
    }));
    renderBoard();
    await screen.findByText("Auction Dragon");
    expect(screen.getByText(ja.auctionBidUnsettleableBadge)).toBeInTheDocument();
    expect(
      screen.getByText(trJa("auctionRowMyBid", { card: "Coin", count: 3, state: ja.auctionBidStateSelecting })),
    ).toBeInTheDocument();
  });

  it("cross tab: shows the auction's channel and keeps the scope in the detail link", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      auctions: [makeAuction({ offeredStreamerId: "s-2", offeredStreamer: { id: "s-2", twitchUsername: "two", twitchDisplayName: "ChanTwo", twitchProfileImageUrl: null } })],
      hasMore: false,
    }));
    renderBoard({ scope: "cross_channel" });
    await screen.findByText("Auction Dragon");
    expect(screen.getByText(trJa("cardStreamerLabel", { name: "ChanTwo" }))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ja.auctionRowDetailLink })).toHaveAttribute(
      "href",
      "/trade/s-1/auctions/auction-1?scope=cross",
    );
  });

  it("deploy window: 503 TRADE_AUCTION_UNAVAILABLE shows 'not available yet', not a load error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { code: "TRADE_AUCTION_UNAVAILABLE" }));
    renderBoard();
    expect(await screen.findByText(ja.auctionUnavailableNotice)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: ja.retryButton })).toBeNull();
  });

  it("other failures show the error banner with a retry that refetches", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { code: "INTERNAL_ERROR" }))
      .mockResolvedValueOnce(jsonResponse(200, { auctions: [makeAuction()], hasMore: false }));
    renderBoard();
    expect(await screen.findByText(ja.auctionLoadError)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ja.retryButton }));
    expect(await screen.findByText("Auction Dragon")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("empty in-channel tab invites the first auction; the cross tab does not", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auctions: [], hasMore: false }));
    renderBoard();
    await screen.findByText(ja.auctionEmptyState);
    expect(screen.getByRole("link", { name: ja.auctionEmptyStateCta })).toHaveAttribute(
      "href",
      "/trade/s-1/new?kind=auction",
    );
  });

  it("empty cross tab has no listing CTA", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auctions: [], hasMore: false }));
    renderBoard({ scope: "cross_channel" });
    await screen.findByText(ja.auctionEmptyState);
    expect(screen.queryByRole("link", { name: ja.auctionEmptyStateCta })).toBeNull();
  });

  it("pages with the shared pager", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const page = new URL(url, "https://x.test").searchParams.get("page");
      return jsonResponse(200, {
        auctions: [makeAuction({ id: `a-${page}`, offeredCard: { name: `Card p${page}`, rarity: "common", imageUrl: null } })],
        hasMore: page === "1",
      });
    });
    renderBoard();
    await screen.findByText("Card p1");
    fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
    expect(await screen.findByText("Card p2")).toBeInTheDocument();
  });

  it("shows the 'listed' notice after creating an auction", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auctions: [], hasMore: false }));
    renderBoard({ justListed: true });
    expect(screen.getByText(ja.auctionListedNotice)).toBeInTheDocument();
  });

  it("uses English ICU plurals in the en locale", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      auctions: [makeAuction({ bidCount: 1, endsAt: new Date(NOW + 61 * 60_000).toISOString() })],
      hasMore: false,
    }));
    renderBoard({}, "en");
    await screen.findByText("Auction Dragon");
    expect(screen.getByText("1 bid")).toBeInTheDocument();
    expect(screen.getByText(trEn("auctionTimeLeftHoursMinutes", { hours: 1, minutes: 1 }))).toHaveTextContent(
      "1 hour 1 minute left",
    );
  });
});
