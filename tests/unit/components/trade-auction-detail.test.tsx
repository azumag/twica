import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import TradeAuctionDetail, { type TradeAuctionBidCard } from "@/components/TradeAuctionDetail";
import type { TradeAuctionBidDto, TradeAuctionDto } from "@/lib/trade-auction";
import jaMessages from "../../../messages/ja.json";
import { jsonResponse, makeAuction, makeBid, NOW } from "./trade-auction-fixtures";

const ja = jaMessages.trade;
const trJa = createTranslator({ locale: "ja", messages: jaMessages, namespace: "trade" });

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
const clearTradeListCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/use-trade-list", () => ({ clearTradeListCache }));

const BID_CARDS: TradeAuctionBidCard[] = [
  { cardId: "card-coin", name: "Coin", rarity: "common", imageUrl: null, freeCount: 4 },
  { cardId: "card-gem", name: "Gem", rarity: "rare", imageUrl: null, freeCount: 0 },
  { cardId: "card-dragon", name: "Auction Dragon", rarity: "epic", imageUrl: null, freeCount: 2 },
];

type Detail = { auction: TradeAuctionDto; bids: TradeAuctionBidDto[] | null };

function detailElement(props: Partial<React.ComponentProps<typeof TradeAuctionDetail>> = {}) {
  return (
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeAuctionDetail
        auctionId="auction-1"
        isLoggedIn
        loginHref="/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%2Fauctions%2Fauction-1"
        bidCards={BID_CARDS}
        maxBidQuantity={10}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

function renderDetail(props: Partial<React.ComponentProps<typeof TradeAuctionDetail>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeAuctionDetail
        auctionId="auction-1"
        isLoggedIn
        loginHref="/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%2Fauctions%2Fauction-1"
        bidCards={BID_CARDS}
        maxBidQuantity={10}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

/**
 * fetch router: GET of the detail answers `detail.current`; POSTs are
 * answered by `writes` (url → response factory) and recorded.
 */
function setupFetch(initial: Detail) {
  const detail = { current: initial };
  const writes = new Map<string, () => Response | Promise<Response>>();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const answer = writes.get(url);
      if (!answer) throw new Error(`unexpected POST ${url}`);
      return answer();
    }
    if (url === "/api/trades/auctions/auction-1") return jsonResponse(200, detail.current);
    throw new Error(`unexpected GET ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { detail, writes, posts, fetchMock };
}

function bidForm() {
  return screen.getByRole("region", { name: ja.auctionBidFormTitle });
}

function cardTile(region: HTMLElement, name: string) {
  return within(region).getByRole("button", { name: new RegExp(name) });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  refresh.mockClear();
  clearTradeListCache.mockClear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  // Unmount first: a reload scheduled by the last write must not reach the
  // real fetch after the stub is removed.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TradeAuctionDetail loading states", () => {
  it("404 → not found copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { code: "TRADE_AUCTION_NOT_FOUND" })));
    renderDetail();
    expect(await screen.findByText(ja.errorTradeAuctionNotFound)).toBeInTheDocument();
  });

  it("503 TRADE_AUCTION_UNAVAILABLE → 'not available yet' (deploy window)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { code: "TRADE_AUCTION_UNAVAILABLE" })));
    renderDetail();
    expect(await screen.findByText(ja.auctionUnavailableNotice)).toBeInTheDocument();
  });

  it("other failures → error with retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { code: "INTERNAL_ERROR" }))
      .mockResolvedValueOnce(jsonResponse(200, { auction: makeAuction(), bids: null }));
    vi.stubGlobal("fetch", fetchMock);
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: ja.retryButton }));
    expect(await screen.findByRole("region", { name: ja.auctionDetailTitle })).toBeInTheDocument();
  });
});

describe("TradeAuctionDetail bidder", () => {
  it("shows the auction header: phase with time left, bid count, seller and deadline", async () => {
    setupFetch({ auction: makeAuction({ bidCount: 4 }), bids: null });
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    expect(screen.getByText(trJa("auctionTimeLeftDaysHours", { days: 2, hours: 5 }))).toBeInTheDocument();
    expect(screen.getByText(trJa("auctionBidCount", { count: 4 }))).toBeInTheDocument();
    expect(screen.getByText(trJa("offeredByLabel", { name: "Alice" }))).toBeInTheDocument();
  });

  it("anonymous viewers get a login link instead of the bid form", async () => {
    setupFetch({ auction: makeAuction({ isOwnAuction: undefined, myBid: undefined }), bids: null });
    renderDetail({ isLoggedIn: false, bidCards: [] });
    const link = await screen.findByRole("link", { name: ja.auctionLoginToBid });
    expect(link.getAttribute("href")).toContain("returnTo=");
    expect(screen.queryByRole("region", { name: ja.auctionBidFormTitle })).toBeNull();
  });

  it("lists bid candidates with usable counts; same card and no free copy are disabled", async () => {
    setupFetch({ auction: makeAuction(), bids: null });
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    const form = bidForm();
    expect(cardTile(form, "Coin")).toBeEnabled();
    expect(within(cardTile(form, "Coin")).getByText(trJa("auctionBidUsableBadge", { count: 4 }))).toBeInTheDocument();
    expect(cardTile(form, "Gem")).toBeDisabled();
    const same = cardTile(form, "Auction Dragon");
    expect(same).toBeDisabled();
    expect(same).toHaveAttribute("title", ja.auctionBidSameCard);
  });

  it("explains when the viewer has no card to bid with", async () => {
    setupFetch({ auction: makeAuction(), bids: null });
    renderDetail({ bidCards: [] });
    expect(await screen.findByText(ja.auctionBidCardsEmpty)).toBeInTheDocument();
  });

  it("places a bid: quantity limited to usable copies, POST body, success notice and refresh", async () => {
    const { writes, posts, detail } = setupFetch({ auction: makeAuction(), bids: null });
    writes.set("/api/trades/auctions/auction-1/bids", () => {
      detail.current = { auction: makeAuction({ bidCount: 1, myBid: makeBid({ quantity: 2 }) }), bids: null };
      return jsonResponse(200, { bid: makeBid({ quantity: 2 }), replacedBidId: null, idempotentReplay: false });
    });
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    const submit = within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit });
    expect(submit).toBeDisabled();
    fireEvent.click(cardTile(bidForm(), "Coin"));
    const select = screen.getByRole("combobox", { name: ja.auctionBidQuantityLabel });
    // freeCount 4 → options 1..4 only.
    expect(within(select).getAllByRole("option")).toHaveLength(4);
    fireEvent.change(select, { target: { value: "2" } });
    expect(screen.getByText(trJa("auctionBidSummary", { card: "Coin", count: 2 }))).toBeInTheDocument();
    fireEvent.click(submit);
    expect(await screen.findByText(ja.auctionBidSuccess)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ bidCardId: "card-coin", quantity: 2 });
    expect(posts[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(clearTradeListCache).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    // The reloaded detail shows the new bid.
    expect(await screen.findByRole("region", { name: ja.auctionMyBidTitle })).toBeInTheDocument();
  });

  it("prevents double submission while the bid is in flight", async () => {
    const { writes, posts } = setupFetch({ auction: makeAuction(), bids: null });
    let release!: (response: Response) => void;
    writes.set("/api/trades/auctions/auction-1/bids", () => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    fireEvent.click(cardTile(bidForm(), "Coin"));
    const submit = within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit });
    fireEvent.click(submit);
    const busy = within(bidForm()).getByRole("button", { name: ja.auctionBidSubmitting });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    fireEvent.click(busy);
    expect(cardTile(bidForm(), "Coin")).toBeDisabled();
    release(jsonResponse(200, { bid: makeBid(), replacedBidId: null, idempotentReplay: false }));
    await screen.findByText(ja.auctionBidSuccess);
    expect(posts).toHaveLength(1);
  });

  it("reuses the requestId after a network error and issues a new one for another selection", async () => {
    const { writes, posts } = setupFetch({ auction: makeAuction(), bids: null });
    writes.set("/api/trades/auctions/auction-1/bids", () => {
      throw new TypeError("network down");
    });
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    fireEvent.click(cardTile(bidForm(), "Coin"));
    const submit = () => fireEvent.click(within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit }));
    submit();
    expect(await screen.findByText(ja.errorNetwork)).toBeInTheDocument();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body.requestId).toBe(posts[0].body.requestId);
    // A network error does not reload (nothing is known to have changed).
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: ja.auctionBidQuantityLabel }), { target: { value: "3" } });
    await screen.findByText(trJa("auctionBidSummary", { card: "Coin", count: 3 }));
    submit();
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].body.requestId).not.toBe(posts[0].body.requestId);
  });

  it("explains a refused bid with the API copy (e.g. the deadline passed) and reloads", async () => {
    const { writes } = setupFetch({ auction: makeAuction(), bids: null });
    writes.set("/api/trades/auctions/auction-1/bids", () => jsonResponse(409, { code: "TRADE_AUCTION_NOT_OPEN" }));
    renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    fireEvent.click(cardTile(bidForm(), "Coin"));
    fireEvent.click(within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeAuctionNotOpen);
    expect(refresh).toHaveBeenCalled();
  });

  it("derives the bid quantity from the reloaded candidates when they shrink (M1)", async () => {
    const { writes, posts } = setupFetch({ auction: makeAuction(), bids: null });
    writes.set("/api/trades/auctions/auction-1/bids", () =>
      jsonResponse(200, { bid: makeBid({ quantity: 1 }), replacedBidId: null, idempotentReplay: false })
    );
    const view = renderDetail();
    await screen.findByRole("region", { name: ja.auctionDetailTitle });
    fireEvent.click(cardTile(bidForm(), "Coin"));
    fireEvent.change(screen.getByRole("combobox", { name: ja.auctionBidQuantityLabel }), { target: { value: "3" } });
    expect(screen.getByText(trJa("auctionBidSummary", { card: "Coin", count: 3 }))).toBeInTheDocument();

    // The candidates shrink (another tab locked two copies): the stale "3" is
    // clamped to what is usable now, in the select, the summary and the POST.
    const shrunkenCards = [
      { ...BID_CARDS[0], freeCount: 1 },
      BID_CARDS[1],
      BID_CARDS[2],
    ];
    view.rerender(detailElement({ bidCards: shrunkenCards }));
    const select = screen.getByRole("combobox", { name: ja.auctionBidQuantityLabel });
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect((select as HTMLSelectElement).value).toBe("1");
    expect(screen.getByText(trJa("auctionBidSummary", { card: "Coin", count: 1 }))).toBeInTheDocument();
    fireEvent.click(within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toMatchObject({ bidCardId: "card-coin", quantity: 1 });

    // Nothing usable left: the form offers no quantity and the button is disabled.
    const emptyCards = [
      { ...BID_CARDS[0], freeCount: 0 },
      BID_CARDS[1],
      BID_CARDS[2],
    ];
    view.rerender(detailElement({ bidCards: emptyCards }));
    expect(within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit })).toBeDisabled();
    // Clicking the disabled button sends nothing.
    fireEvent.click(within(bidForm()).getByRole("button", { name: ja.auctionBidSubmit }));
    expect(posts).toHaveLength(1);
  });

  it("changing a bid counts the current bid's copies as usable and labels the change", async () => {
    setupFetch({
      auction: makeAuction({ bidCount: 1, myBid: makeBid({ quantity: 3 }) }),
      bids: null,
    });
    renderDetail();
    const form = await screen.findByRole("region", { name: ja.auctionBidChangeTitle });
    // freeCount 4 + 3 copies of the current bid on the same card.
    expect(within(cardTile(form, "Coin")).getByText(trJa("auctionBidUsableBadge", { count: 7 }))).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: ja.auctionBidChangeSubmit })).toBeInTheDocument();
  });

  it("withdraws a bid through the confirmation dialog", async () => {
    const { writes, posts, detail } = setupFetch({
      auction: makeAuction({ bidCount: 1, myBid: makeBid() }),
      bids: null,
    });
    writes.set("/api/trades/auctions/auction-1/bids/bid-1/withdraw", () => {
      detail.current = { auction: makeAuction(), bids: null };
      return jsonResponse(200, { success: true, bidId: "bid-1", alreadyWithdrawn: false });
    });
    renderDetail();
    const mine = await screen.findByRole("region", { name: ja.auctionMyBidTitle });
    fireEvent.click(within(mine).getByRole("button", { name: ja.auctionWithdrawButton }));
    const dialog = screen.getByRole("dialog", { name: ja.auctionWithdrawConfirmTitle });
    // Irreversible: the dismiss button has the initial focus.
    expect(within(dialog).getByRole("button", { name: ja.cancelOfferModalDismissButton })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: ja.auctionWithdrawConfirmButton }));
    expect(await screen.findByText(ja.auctionWithdrawSuccess)).toBeInTheDocument();
    expect(posts).toEqual([{ url: "/api/trades/auctions/auction-1/bids/bid-1/withdraw", body: {} }]);
  });

  it("dismissing the dialog sends nothing", async () => {
    const { posts } = setupFetch({ auction: makeAuction({ bidCount: 1, myBid: makeBid() }), bids: null });
    renderDetail();
    const mine = await screen.findByRole("region", { name: ja.auctionMyBidTitle });
    fireEvent.click(within(mine).getByRole("button", { name: ja.auctionWithdrawButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalDismissButton }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("selecting + settleable bid: waits for the seller, no withdraw, no bid form", async () => {
    setupFetch({
      auction: makeAuction({ phase: "selecting", bidCount: 1, myBid: makeBid() }),
      bids: null,
    });
    renderDetail();
    const mine = await screen.findByRole("region", { name: ja.auctionMyBidTitle });
    expect(within(mine).getByText(ja.auctionBidStateSelecting)).toBeInTheDocument();
    expect(within(mine).getByText(/出品者が入札を選ぶのを待っています/)).toBeInTheDocument();
    expect(within(mine).queryByRole("button", { name: ja.auctionWithdrawButton })).toBeNull();
    expect(screen.queryByRole("region", { name: ja.auctionBidChangeTitle })).toBeNull();
  });

  it("selecting + unsettleable bid: explains it and allows the withdrawal", async () => {
    setupFetch({
      auction: makeAuction({ phase: "selecting", bidCount: 1, myBid: makeBid({ settleable: false }) }),
      bids: null,
    });
    renderDetail();
    const mine = await screen.findByRole("region", { name: ja.auctionMyBidTitle });
    expect(within(mine).getByText(ja.auctionBidUnsettleableBadge)).toBeInTheDocument();
    expect(within(mine).getByText(ja.auctionMyBidUnsettleableHelp)).toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: ja.auctionWithdrawButton })).toBeEnabled();
  });

  it("shows the final state of the viewer's bid (won / lost / released)", async () => {
    setupFetch({
      auction: makeAuction({ phase: "completed", status: "completed", bidCount: 0, myBid: makeBid({ status: "lost", state: "lost" }) }),
      bids: null,
    });
    renderDetail();
    const mine = await screen.findByRole("region", { name: ja.auctionMyBidTitle });
    expect(within(mine).getByText(ja.auctionBidStateLost)).toBeInTheDocument();
    expect(within(mine).queryByRole("button")).toBeNull();
  });

  it("selecting without an own bid: bidding is closed", async () => {
    setupFetch({ auction: makeAuction({ phase: "selecting", bidCount: 2 }), bids: null });
    renderDetail();
    expect(await screen.findByText(ja.auctionBiddingClosedNotice)).toBeInTheDocument();
  });
});

describe("TradeAuctionDetail seller", () => {
  const own = (overrides: Partial<TradeAuctionDto> = {}) =>
    makeAuction({ isOwnAuction: true, myBid: undefined, offeredUserCardId: "uc-1", ...overrides });

  it("bidding phase: lists bids with the bidder, offers no settle and no cancel while bids exist", async () => {
    setupFetch({
      auction: own({ bidCount: 1 }),
      bids: [makeBid({ bidder: { twitchUsername: "bob", twitchDisplayName: "Bob", twitchProfileImageUrl: null } })],
    });
    renderDetail();
    const list = await screen.findByRole("region", { name: ja.auctionBidsTitle });
    expect(within(list).getByText(trJa("auctionBidderLabel", { name: "Bob" }))).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: ja.auctionSettleButton })).toBeNull();
    expect(screen.queryByRole("button", { name: ja.auctionCancelButton })).toBeNull();
    expect(screen.getByText(ja.auctionCancelHasBidsHelp)).toBeInTheDocument();
    // The seller never sees a bid form for their own auction.
    expect(screen.queryByRole("region", { name: ja.auctionBidFormTitle })).toBeNull();
  });

  it("no bids: cancels through the confirmation dialog (before or after the deadline)", async () => {
    const { writes, posts, detail } = setupFetch({ auction: own({ phase: "expired" }), bids: [] });
    writes.set("/api/trades/auctions/auction-1/cancel", () => {
      detail.current = { auction: own({ phase: "cancelled", status: "cancelled" }), bids: [] };
      return jsonResponse(200, { success: true, auctionId: "auction-1", alreadyCancelled: false });
    });
    renderDetail();
    expect(await screen.findByText(ja.auctionBidsEmpty)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ja.auctionCancelButton }));
    const dialog = screen.getByRole("dialog", { name: ja.auctionCancelConfirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: ja.auctionCancelConfirmButton }));
    expect(await screen.findByText(ja.auctionCancelSuccess)).toBeInTheDocument();
    expect(posts).toEqual([{ url: "/api/trades/auctions/auction-1/cancel", body: {} }]);
    // Reloaded as cancelled: no cancel button any more.
    await waitFor(() => expect(screen.queryByRole("button", { name: ja.auctionCancelButton })).toBeNull());
  });

  it("shows TRADE_AUCTION_HAS_BIDS when a bid arrived meanwhile", async () => {
    const { writes } = setupFetch({ auction: own(), bids: [] });
    writes.set("/api/trades/auctions/auction-1/cancel", () => jsonResponse(409, { code: "TRADE_AUCTION_HAS_BIDS" }));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: ja.auctionCancelButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: ja.auctionCancelConfirmButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeAuctionHasBids);
  });

  it("selecting: settles a bid with a per-bid requestId; unsettleable bids cannot be chosen", async () => {
    const { writes, posts, detail } = setupFetch({
      auction: own({ phase: "selecting", bidCount: 2 }),
      bids: [
        makeBid({ id: "bid-ok", bidder: { twitchUsername: "bob", twitchDisplayName: "Bob", twitchProfileImageUrl: null } }),
        makeBid({ id: "bid-bad", settleable: false, bidCard: { name: "Gem", rarity: "rare", imageUrl: null }, bidder: { twitchUsername: "eve", twitchDisplayName: "Eve", twitchProfileImageUrl: null } }),
      ],
    });
    writes.set("/api/trades/auctions/auction-1/settle", () => {
      detail.current = {
        auction: own({ phase: "completed", status: "completed", bidCount: 0 }),
        bids: [makeBid({ id: "bid-ok", status: "won", state: "won" }), makeBid({ id: "bid-bad", status: "lost", state: "lost" })],
      };
      return jsonResponse(200, { success: true, auctionId: "auction-1", bidId: "bid-ok" });
    });
    renderDetail();
    const list = await screen.findByRole("region", { name: ja.auctionBidsTitle });
    const rows = within(list).getAllByRole("listitem");
    const bad = rows.find((row) => within(row).queryByText("Gem"))!;
    expect(within(bad).getByText(ja.auctionBidUnsettleableBadge)).toBeInTheDocument();
    expect(within(bad).getByRole("button", { name: ja.auctionSettleButton })).toBeDisabled();
    const ok = rows.find((row) => within(row).queryByText(trJa("auctionBidderLabel", { name: "Bob" })))!;
    fireEvent.click(within(ok).getByRole("button", { name: ja.auctionSettleButton }));
    const dialog = screen.getByRole("dialog", { name: ja.auctionSettleConfirmTitle });
    expect(within(dialog).getByText("Auction Dragon")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ja.auctionSettleConfirmButton }));
    expect(await screen.findByText(ja.auctionSettleSuccess)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ bidId: "bid-ok" });
    expect(posts[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(ja.auctionSellerBidWon)).toBeInTheDocument();
  });

  it("retrying a settle for the same bid reuses its requestId", async () => {
    const { writes, posts } = setupFetch({
      auction: own({ phase: "selecting", bidCount: 1 }),
      bids: [makeBid({ id: "bid-ok" })],
    });
    writes.set("/api/trades/auctions/auction-1/settle", () => jsonResponse(409, { code: "TRADE_BUSY" }));
    renderDetail();
    const settle = async () => {
      fireEvent.click(await screen.findByRole("button", { name: ja.auctionSettleButton }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: ja.auctionSettleConfirmButton }));
    };
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeBusy);
    await settle();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body.requestId).toBe(posts[0].body.requestId);
  });

  it("explains an expired selection window with the API copy", async () => {
    const { writes } = setupFetch({ auction: own({ phase: "selecting", bidCount: 1 }), bids: [makeBid()] });
    writes.set("/api/trades/auctions/auction-1/settle", () => jsonResponse(409, { code: "TRADE_AUCTION_EXPIRED" }));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: ja.auctionSettleButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: ja.auctionSettleConfirmButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeAuctionExpired);
  });
});
