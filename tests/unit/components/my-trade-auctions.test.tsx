import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import MyTrades from "@/components/MyTrades";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import jaMessages from "../../../messages/ja.json";
import { jsonResponse, makeAuction, makeBid, NOW } from "./trade-auction-fixtures";

const ja = jaMessages.trade;

function renderMine() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MyTrades />
    </NextIntlClientProvider>,
  );
}

/**
 * /trade/mine "auction" tab (#1791): GET /api/trades/auctions/mine is a
 * separate endpoint, so the offer tabs must keep working when it fails.
 */
describe("MyTrades auction tab (#1791)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let auctions: Record<string, TradeAuctionDto[] | "unavailable" | "error">;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    auctions = { selling: [], bidding: [] };
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/trades/mine")) {
        return jsonResponse(200, { offers: [], page: 1, pageSize: 20, hasMore: false });
      }
      if (url.startsWith("/api/trades/auctions/mine")) {
        const role = new URL(url, "https://x.test").searchParams.get("role")!;
        const value = auctions[role];
        if (value === "unavailable") return jsonResponse(503, { code: "TRADE_AUCTION_UNAVAILABLE" });
        if (value === "error") return jsonResponse(500, { code: "INTERNAL_ERROR" });
        return jsonResponse(200, { auctions: value, page: 1, pageSize: 20, hasMore: false });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function openAuctionTab() {
    renderMine();
    await screen.findByText(ja.myTradesEmptyOpen);
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabAuction }));
  }

  it("does not request auctions until the tab is opened", async () => {
    renderMine();
    await screen.findByText(ja.myTradesEmptyOpen);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/trades/auctions"))).toBe(false);
  });

  it("selling: shows each auction's phase, and a 'choose a bid' link while selecting", async () => {
    auctions.selling = [
      makeAuction({ id: "a-bidding", isOwnAuction: true, myBid: undefined, bidCount: 1 }),
      makeAuction({
        id: "a-selecting",
        isOwnAuction: true,
        myBid: undefined,
        phase: "selecting",
        bidCount: 2,
        offeredCard: { name: "Selecting Card", rarity: "rare", imageUrl: null },
      }),
      makeAuction({
        id: "a-expired",
        isOwnAuction: true,
        myBid: undefined,
        phase: "expired",
        offeredCard: { name: "Expired Card", rarity: "rare", imageUrl: null },
      }),
    ];
    await openAuctionTab();
    const selecting = (await screen.findByText("Selecting Card")).closest("li")!;
    expect(within(selecting).getByText(ja.auctionPhaseSelecting)).toBeInTheDocument();
    expect(within(selecting).getByRole("link", { name: ja.myAuctionsSettleLink })).toHaveAttribute(
      "href",
      "/trade/s-1/auctions/a-selecting",
    );
    const bidding = screen.getByText("Auction Dragon").closest("li")!;
    expect(within(bidding).getByText(ja.auctionPhaseBidding)).toBeInTheDocument();
    expect(within(bidding).getByRole("link", { name: ja.myAuctionsDetailLink })).toBeInTheDocument();
    const expired = screen.getByText("Expired Card").closest("li")!;
    expect(within(expired).getByText(ja.auctionPhaseExpired)).toBeInTheDocument();
    const url = new URL(String(fetchMock.mock.calls.at(-1)![0]), "https://x.test");
    expect(url.searchParams.get("role")).toBe("selling");
  });

  it("bidding: shows the own bid with its state and links to the bid card's channel", async () => {
    auctions.bidding = [
      makeAuction({ id: "a-active", myBid: makeBid({ bidStreamerId: "s-9" }) }),
      makeAuction({
        id: "a-won",
        phase: "completed",
        status: "completed",
        offeredCard: { name: "Won Card", rarity: "rare", imageUrl: null },
        myBid: makeBid({ id: "b-won", status: "won", state: "won" }),
      }),
      makeAuction({
        id: "a-released",
        phase: "expired",
        offeredCard: { name: "Released Card", rarity: "rare", imageUrl: null },
        myBid: makeBid({ id: "b-rel", state: "released" }),
      }),
      makeAuction({
        id: "a-stuck",
        phase: "selecting",
        offeredCard: { name: "Stuck Card", rarity: "rare", imageUrl: null },
        myBid: makeBid({ id: "b-stuck", settleable: false }),
      }),
    ];
    await openAuctionTab();
    fireEvent.click(screen.getByRole("button", { name: ja.myAuctionsRoleBidding }));
    const active = (await screen.findByText("Auction Dragon")).closest("li")!;
    expect(within(active).getByText(ja.auctionBidStateActive)).toBeInTheDocument();
    expect(within(active).getByText("Coin")).toBeInTheDocument();
    expect(within(active).getByRole("link", { name: ja.myAuctionsDetailLink })).toHaveAttribute(
      "href",
      "/trade/s-9/auctions/a-active?scope=cross",
    );
    expect(within(screen.getByText("Won Card").closest("li")!).getByText(ja.auctionBidStateWon)).toBeInTheDocument();
    expect(
      within(screen.getByText("Released Card").closest("li")!).getByText(ja.auctionBidStateReleased),
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("Stuck Card").closest("li")!).getByText(ja.auctionBidUnsettleableBadge),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ja.myAuctionsRoleBidding })).toHaveAttribute("aria-pressed", "true");
  });

  it("empty states per role", async () => {
    await openAuctionTab();
    expect(await screen.findByText(ja.myAuctionsEmptySelling)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ja.myAuctionsRoleBidding }));
    expect(await screen.findByText(ja.myAuctionsEmptyBidding)).toBeInTheDocument();
  });

  it("deploy window: 503 shows 'not available yet' and the offer tabs keep working", async () => {
    auctions.selling = "unavailable";
    await openAuctionTab();
    expect(await screen.findByText(ja.auctionUnavailableNotice)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
    expect(await screen.findByText(ja.myTradesEmptyOpen)).toBeInTheDocument();
  });

  it("other failures show the auction load error with a retry", async () => {
    auctions.selling = "error";
    await openAuctionTab();
    expect(await screen.findByText(ja.myAuctionsLoadError)).toBeInTheDocument();
    auctions.selling = [];
    fireEvent.click(screen.getByRole("button", { name: ja.retryButton }));
    expect(await screen.findByText(ja.myAuctionsEmptySelling)).toBeInTheDocument();
  });
});
