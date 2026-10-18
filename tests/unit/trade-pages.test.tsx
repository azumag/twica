import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * /trade/** server pages and layout (#726/#727): login gates, returnTo,
 * channel gates, and that only server-filtered data reaches client props.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getTradeBoardStreamer: vi.fn(),
  listWantableCards: vi.fn(),
  listTradeableOwnedCopies: vi.fn(),
  listCrossTradePartnerStreamers: vi.fn(),
  listMyTradeOffers: vi.fn(),
  loggerWarn: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: () => false,
}));
vi.mock("@/lib/announcements", () => ({ getUnreadAnnouncements: async () => [] }));
vi.mock("@/lib/plan", () => ({ getUserPlan: async () => "basic" }));
vi.mock("@/lib/trade", () => ({
  // The page passes this constant to the create form (#1789); the real module
  // pulls in the DB layer, so the value is mirrored here.
  TRADE_MAX_WANTED_QUANTITY: 10,
  getTradeBoardStreamer: mocks.getTradeBoardStreamer,
  listWantableCards: mocks.listWantableCards,
  listTradeableOwnedCopies: mocks.listTradeableOwnedCopies,
  listCrossTradePartnerStreamers: mocks.listCrossTradePartnerStreamers,
  listMyTradeOffers: mocks.listMyTradeOffers,
}));
// The detail page passes TRADE_MAX_BID_QUANTITY (#1791); the real module
// pulls in the DB layer, so the value is mirrored here.
vi.mock("@/lib/trade-auction", () => ({ TRADE_MAX_BID_QUANTITY: 10 }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/components/Header", () => ({ default: () => <div data-testid="app-header" /> }));
vi.mock("@/components/DashboardNav", () => ({ default: () => <nav data-testid="dashboard-nav" /> }));
vi.mock("@/components/PublicFooter", () => ({ default: () => <footer data-testid="public-footer" /> }));
vi.mock("@/components/MaintenanceBanner", () => ({ default: () => null }));
vi.mock("@/components/MaintenanceStatusProvider", () => ({
  MaintenanceStatusProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="maintenance-provider">{children}</div>
  ),
}));
vi.mock("@/components/TwitchLoginRedirect", () => ({
  TwitchLoginRedirect: () => <div data-testid="login-redirect" />,
}));
vi.mock("@/components/TradeBoard", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-board" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/TradeAuctionBoard", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-auction-board" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/TradeAuctionDetail", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-auction-detail" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/TradeCreateForm", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-create-form" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/MyTrades", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="my-trades" data-props={JSON.stringify(props)} />
  ),
}));

import TradeLayout, { metadata } from "@/app/trade/layout";
import TradeBoardPage from "@/app/trade/[streamerId]/page";
import TradeCreatePage from "@/app/trade/[streamerId]/new/page";
import MyTradesPage from "@/app/trade/mine/page";
import TradeAuctionDetailPage from "@/app/trade/[streamerId]/auctions/[auctionId]/page";

const STREAMER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = { twitchUserId: "viewer-1" };

function boardStreamer(overrides: Record<string, unknown> = {}) {
  return {
    id: STREAMER_ID,
    twitchUsername: "chan",
    twitchDisplayName: "Chan",
    twitchProfileImageUrl: null,
    tradeEnabled: true,
    crossChannelTradeEnabled: true,
    revealsUnownedCards: true,
    ...overrides,
  };
}

function props(testId: string) {
  return JSON.parse(screen.getByTestId(testId).getAttribute("data-props")!);
}

const params = Promise.resolve({ streamerId: STREAMER_ID });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer());
  mocks.listWantableCards.mockResolvedValue([
    { cardId: "c-1", name: "Visible Card", rarity: "common", imageUrl: "https://img/x.png", isOwned: true },
  ]);
  mocks.listTradeableOwnedCopies.mockResolvedValue([]);
  mocks.listCrossTradePartnerStreamers.mockResolvedValue([]);
  mocks.listMyTradeOffers.mockResolvedValue({ offers: [], page: 1, pageSize: 20, hasMore: false });
});

describe("/trade layout", () => {
  it("is not indexed by search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does NOT redirect anonymous visitors (board is public)", async () => {
    mocks.getSession.mockResolvedValue(null);
    render(await TradeLayout({ children: <p>board content</p> }));
    expect(screen.getByText("board content")).toBeInTheDocument();
    expect(screen.queryByTestId("login-redirect")).toBeNull();
    expect(screen.getByTestId("public-footer")).toBeInTheDocument();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("renders the dashboard chrome and maintenance provider for logged-in users", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeLayout({ children: <p>board content</p> }));
    expect(screen.getByTestId("app-header")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-nav")).toBeInTheDocument();
    expect(screen.getByTestId("maintenance-provider")).toHaveTextContent("board content");
  });
});

describe("/trade/[streamerId] board page", () => {
  it("renders for anonymous viewers with a login link that returns to the scoped board", async () => {
    mocks.getSession.mockResolvedValue(null);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({ scope: "cross" }) }));
    const board = props("trade-board");
    expect(board.isLoggedIn).toBe(false);
    expect(board.scope).toBe("cross_channel");
    expect(board.loginHref).toBe(
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/${STREAMER_ID}?scope=cross`)}`,
    );
    expect(board.createHref).toBe(
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/${STREAMER_ID}/new?scope=cross`)}`,
    );
    // Cross tab: no card filter, so the catalogue is not even queried.
    expect(board.filterCards).toEqual([]);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    // Anonymous viewers share one cache namespace that no account can reach.
    expect(board.viewerKey).toBe("anon");
  });

  it("hands the board an opaque per-viewer cache key, never the raw Twitch user id (#1754)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    const first = props("trade-board").viewerKey as string;
    expect(first).toMatch(/^u:[0-9a-f]{16}$/);
    expect(first).not.toContain(SESSION.twitchUserId);
    cleanup();

    mocks.getSession.mockResolvedValue({ ...SESSION, twitchUserId: "viewer-2" });
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(props("trade-board").viewerKey).not.toBe(first);
  });

  it("passes only visibility-filtered card names (id + name) as in-channel filter options", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", STREAMER_ID);
    const board = props("trade-board");
    expect(board.filterCards).toEqual([{ cardId: "c-1", name: "Visible Card" }]);
    expect(board.createHref).toBe(`/trade/${STREAMER_ID}/new`);
    expect(board.isLoggedIn).toBe(true);
  });

  it("passes the channel's reveal setting for the unrevealed notice", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ revealsUnownedCards: false }));
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(props("trade-board").revealsUnownedCards).toBe(false);
  });

  it("shows a notice instead of the board when trading is disabled", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ tradeEnabled: false }));
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByText("tradeDisabledNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-board")).toBeNull();
  });

  it("shows a notice on the cross tab when cross-channel trading is disabled", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ crossChannelTradeEnabled: false }));
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({ scope: "cross" }) }));
    expect(screen.getByText("crossDisabledNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-board")).toBeNull();
  });

  it("starts the filter query in parallel with the channel read (one SSR round trip)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    let resolveStreamer: (value: unknown) => void = () => {};
    mocks.getTradeBoardStreamer.mockReturnValue(new Promise((resolve) => {
      resolveStreamer = resolve;
    }));
    const pending = TradeBoardPage({ params, searchParams: Promise.resolve({}) });
    await vi.waitFor(() => expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", STREAMER_ID));
    // The channel read has not finished yet when the filter query starts.
    resolveStreamer(boardStreamer());
    render(await pending);
    expect(props("trade-board").filterCards).toEqual([{ cardId: "c-1", name: "Visible Card" }]);
  });

  it("ignores a failed (unused) filter query when trading is disabled", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ tradeEnabled: false }));
    mocks.listWantableCards.mockRejectedValue(new Error("db down"));
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByText("tradeDisabledNotice")).toBeInTheDocument();
  });

  it("still fails the page when the filter query it needs fails", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const error = new Error("db down");
    mocks.listWantableCards.mockRejectedValue(error);
    await expect(TradeBoardPage({ params, searchParams: Promise.resolve({}) })).rejects.toBe(error);
  });

  it("404s for an unknown channel", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getTradeBoardStreamer.mockResolvedValue(null);
    await expect(TradeBoardPage({ params, searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  });
});

describe("/trade/[streamerId]/new listing page", () => {
  it("redirects anonymous visitors to login with an encoded returnTo (scope kept)", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(
      TradeCreatePage({ params, searchParams: Promise.resolve({ scope: "cross" }) }),
    ).rejects.toThrow(
      `REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/${STREAMER_ID}/new?scope=cross`)}`,
    );
    expect(mocks.listTradeableOwnedCopies).not.toHaveBeenCalled();
  });

  it("in-channel: Step 2 candidates come from listWantableCards for this channel", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeCreatePage({ params, searchParams: Promise.resolve({}) }));
    expect(mocks.listTradeableOwnedCopies).toHaveBeenCalledWith("viewer-1", STREAMER_ID);
    expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", STREAMER_ID);
    const form = props("trade-create-form");
    expect(form.cross).toBeNull();
    expect(form.wantableCards).toHaveLength(1);
    expect(form.boardHref).toBe(`/trade/${STREAMER_ID}`);
    // #1789: the server page hands the quantity ceiling to the client form.
    expect(form.maxWantedQuantity).toBe(10);
  });

  it("cross: ignores a ?partner= that is not an allowed partner and loads no catalogue", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([
      { id: "p-1", twitchUsername: "p1", twitchDisplayName: "P1", twitchProfileImageUrl: null },
    ]);
    render(
      await TradeCreatePage({ params, searchParams: Promise.resolve({ scope: "cross", partner: "not-allowed" }) }),
    );
    const form = props("trade-create-form");
    // Only the rendered fields are serialized to the client.
    expect(form.cross).toEqual({
      partners: [{ id: "p-1", twitchDisplayName: "P1", twitchProfileImageUrl: null }],
      selectedPartnerId: null,
    });
    expect(form.wantableCards).toEqual([]);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
  });

  it("cross: loads the chosen partner's wantable cards and reveal setting", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([
      { id: "p-1", twitchUsername: "p1", twitchDisplayName: "P1", twitchProfileImageUrl: null },
    ]);
    mocks.getTradeBoardStreamer.mockImplementation(async (id: string) =>
      id === "p-1" ? boardStreamer({ id: "p-1", revealsUnownedCards: false }) : boardStreamer(),
    );
    render(
      await TradeCreatePage({
        params,
        searchParams: Promise.resolve({ scope: "cross", partner: "p-1", offered: "card-keep" }),
      }),
    );
    expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", "p-1");
    // Step 1 choice is carried over the partner navigation (validated by the form).
    expect(props("trade-create-form").initialOfferedCardId).toBe("card-keep");
    const form = props("trade-create-form");
    expect(form.cross.selectedPartnerId).toBe("p-1");
    expect(form.wantableRevealsUnowned).toBe(false);
    expect(form.boardHref).toBe(`/trade/${STREAMER_ID}?scope=cross`);
  });

  it("shows a notice instead of the form when cross trading is disabled", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ crossChannelTradeEnabled: false }));
    render(await TradeCreatePage({ params, searchParams: Promise.resolve({ scope: "cross" }) }));
    expect(screen.getByText("crossDisabledNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-create-form")).toBeNull();
  });
});

describe("/trade/[streamerId] auction tab (#1791)", () => {
  it("links the auction tab from every board tab and keeps the offer board for the default tab", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "tabAuction" })).toHaveAttribute(
      "href",
      `/trade/${STREAMER_ID}?tab=auction`,
    );
    expect(screen.getByRole("link", { name: "tabInChannel" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("trade-board")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-auction-board")).toBeNull();
  });

  it("?tab=auction renders the auction board with an auction CTA and no card filter query", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({ tab: "auction", listed: "1" }) }));
    expect(screen.queryByTestId("trade-board")).toBeNull();
    const board = props("trade-auction-board");
    expect(board).toMatchObject({
      streamerId: STREAMER_ID,
      scope: "in_channel",
      isLoggedIn: true,
      createHref: `/trade/${STREAMER_ID}/new?kind=auction`,
      justListed: true,
    });
    expect(board.viewerKey).toMatch(/^u:[0-9a-f]{16}$/);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "tabAuction" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "tabInChannel" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "createAuctionButton +" })).toHaveAttribute(
      "href",
      `/trade/${STREAMER_ID}/new?kind=auction`,
    );
  });

  it("offers in-channel / cross-channel sub-tabs inside the auction tab when cross trade is on", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(
      await TradeBoardPage({ params, searchParams: Promise.resolve({ tab: "auction", scope: "cross" }) }),
    );
    const sub = screen.getByRole("navigation", { name: "auctionScopeLabel" });
    expect(within(sub).getByRole("link", { name: "auctionScopeCrossChannel" })).toHaveAttribute("aria-current", "page");
    expect(within(sub).getByRole("link", { name: "auctionScopeInChannel" })).toHaveAttribute(
      "href",
      `/trade/${STREAMER_ID}?tab=auction`,
    );
    expect(props("trade-auction-board").scope).toBe("cross_channel");
  });

  it("hides the sub-tabs and shows the cross notice when cross trade is off", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ crossChannelTradeEnabled: false }));
    render(
      await TradeBoardPage({ params, searchParams: Promise.resolve({ tab: "auction", scope: "cross" }) }),
    );
    expect(screen.queryByRole("navigation", { name: "auctionScopeLabel" })).toBeNull();
    expect(screen.getByText("crossDisabledNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-auction-board")).toBeNull();
  });

  it("anonymous viewers get a login CTA returning to the auction listing flow", async () => {
    mocks.getSession.mockResolvedValue(null);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({ tab: "auction" }) }));
    expect(props("trade-auction-board").createHref).toBe(
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/${STREAMER_ID}/new?kind=auction`)}`,
    );
  });
});

describe("/trade/[streamerId]/new kind preselection (#1791)", () => {
  it("?kind=auction preselects the auction kind; anything else is a regular offer", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeCreatePage({ params, searchParams: Promise.resolve({ kind: "auction" }) }));
    expect(props("trade-create-form").initialKind).toBe("auction");
    cleanup();
    render(await TradeCreatePage({ params, searchParams: Promise.resolve({ kind: "other" }) }));
    expect(props("trade-create-form").initialKind).toBe("offer");
  });
});

describe("/trade/[streamerId]/auctions/[auctionId] detail page (#1791)", () => {
  const AUCTION_ID = "22222222-2222-4222-8222-222222222222";
  const detailParams = Promise.resolve({ streamerId: STREAMER_ID, auctionId: AUCTION_ID });

  it("offers only owned, wantable cards as bid candidates with their free copy counts", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listWantableCards.mockResolvedValue([
      { cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, isOwned: true },
      { cardId: "c-locked", name: "Locked", rarity: "common", imageUrl: null, isOwned: true },
      { cardId: "c-unowned", name: "Unowned", rarity: "epic", imageUrl: null, isOwned: false },
    ]);
    mocks.listTradeableOwnedCopies.mockResolvedValue([
      { userCardId: "u1", cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, obtainedAt: null, isListed: false, ownedCount: 3 },
      { userCardId: "u2", cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, obtainedAt: null, isListed: true, ownedCount: 3 },
      { userCardId: "u3", cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, obtainedAt: null, isListed: false, ownedCount: 3 },
      { userCardId: "u4", cardId: "c-locked", name: "Locked", rarity: "common", imageUrl: null, obtainedAt: null, isListed: true, ownedCount: 1 },
      // Owned but not wantable (trade_wantable=false): not a candidate.
      { userCardId: "u5", cardId: "c-not-wantable", name: "NW", rarity: "common", imageUrl: null, obtainedAt: null, isListed: false, ownedCount: 1 },
    ]);
    render(await TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({}) }));
    expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", STREAMER_ID);
    expect(mocks.listTradeableOwnedCopies).toHaveBeenCalledWith("viewer-1", STREAMER_ID);
    const detail = props("trade-auction-detail");
    expect(detail).toMatchObject({ auctionId: AUCTION_ID, isLoggedIn: true, maxBidQuantity: 10 });
    expect(detail.bidCards).toEqual([
      { cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, freeCount: 2 },
      { cardId: "c-locked", name: "Locked", rarity: "common", imageUrl: null, freeCount: 0 },
    ]);
  });

  it("is readable anonymously without loading any card data, with a login link back to it", async () => {
    mocks.getSession.mockResolvedValue(null);
    render(await TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({ scope: "cross" }) }));
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(mocks.listTradeableOwnedCopies).not.toHaveBeenCalled();
    const detail = props("trade-auction-detail");
    expect(detail.isLoggedIn).toBe(false);
    expect(detail.bidCards).toEqual([]);
    expect(detail.loginHref).toBe(
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/${STREAMER_ID}/auctions/${AUCTION_ID}?scope=cross`)}`,
    );
    // The back link returns to the auction sub-tab the viewer came from.
    expect(screen.getByRole("link", { name: /auctionBackToBoard/ })).toHaveAttribute(
      "href",
      `/trade/${STREAMER_ID}?tab=auction&scope=cross`,
    );
  });

  it("still renders for participants when the channel turned trading off (no candidates)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ tradeEnabled: false }));
    render(await TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({}) }));
    expect(props("trade-auction-detail").bidCards).toEqual([]);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
  });

  it("404s for a malformed auction id or an unknown channel", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(
      TradeAuctionDetailPage({
        params: Promise.resolve({ streamerId: STREAMER_ID, auctionId: "nope" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NOT_FOUND");
    mocks.getTradeBoardStreamer.mockResolvedValue(null);
    await expect(
      TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
  });
});

describe("/trade/mine page", () => {
  it("redirects anonymous visitors to login returning to /trade/mine", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(MyTradesPage()).rejects.toThrow(
      "REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fmine",
    );
  });

  it("renders the trade list for logged-in users with the open tab's first page prefetched", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const offer = { id: "o-1", status: "open", mineRole: "offerer" };
    mocks.listMyTradeOffers.mockResolvedValue({ offers: [offer], page: 1, pageSize: 20, hasMore: true });
    render(await MyTradesPage());
    expect(mocks.listMyTradeOffers).toHaveBeenCalledWith("viewer-1", { status: "open", page: 1 });
    expect(props("my-trades")).toEqual({ initialOpen: { offers: [offer], hasMore: true } });
  });

  it("falls back to the client fetch when the prefetch fails", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listMyTradeOffers.mockRejectedValue(new Error("db down"));
    render(await MyTradesPage());
    expect(props("my-trades")).toEqual({ initialOpen: null });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch for anonymous visitors", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(MyTradesPage()).rejects.toThrow("REDIRECT:");
    expect(mocks.listMyTradeOffers).not.toHaveBeenCalled();
  });
});
