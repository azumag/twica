import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ElementType, type ReactElement, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * /trade/** server pages and layout (#726/#727): login gates, returnTo,
 * channel gates, and that only server-filtered data reaches client props.
 */
const mocks = vi.hoisted(() => ({
  tradeUiVisible: true,
  getSession: vi.fn(),
  getTradeBoardStreamer: vi.fn(),
  listWantableCards: vi.fn(),
  listTradeableOwnedCopies: vi.fn(),
  listCrossTradePartnerStreamers: vi.fn(),
  listMyTradeOffers: vi.fn(),
  loadAllowedBidCardsForAuction: vi.fn(),
  loggerWarn: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/constants")>(),
  get CARD_TRADE_UI_VISIBLE() {
    return mocks.tradeUiVisible;
  },
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
  // The hub parses ?sort= before loading the collection section (#2079).
  parseTradeCollectionSort: (value: string | string[] | undefined) =>
    value === "ending_soon" ? "ending_soon" : "newest",
}));
// The detail page passes TRADE_MAX_BID_QUANTITY (#1791); the real module
// pulls in the DB layer, so the value is mirrored here.
vi.mock("@/lib/trade-auction", () => ({ TRADE_MAX_BID_QUANTITY: 10 }));
// The detail page loads the exchange-target restriction map (the offered card's streamer's list).
vi.mock("@/lib/trade-wanted-restrictions", () => ({
  loadAllowedBidCardsForAuction: mocks.loadAllowedBidCardsForAuction,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next-intl", () => ({
  // The trade layout now owns a nested provider (per-segment message payloads).
  // Unit tests render server components outside the Next.js request scope, where
  // the real client provider cannot infer its locale, so keep it as a passthrough.
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next-intl/server", () => ({
  // The layout picks its segment payload from the request messages.
  getMessages: async () => ({}),
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/components/Header", () => ({ default: () => <div data-testid="app-header" /> }));
vi.mock("@/components/DashboardNav", () => ({ default: () => <nav data-testid="dashboard-nav" /> }));
// The layout wraps the nav and page content in DashboardShell now. This suite is
// about the trade layout's data/guard wiring, not the shell's client-side drawer,
// so a passthrough keeps the same document order (nav, then main) without
// requiring the next-intl/usePathname context the real client component needs.
vi.mock("@/components/DashboardShell", () => ({
  default: ({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {nav}
      {children}
    </div>
  ),
}));
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
vi.mock("@/components/TradeCollections", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-collections" data-props={JSON.stringify(props)} />
  ),
}));
// The notice's own rendering/URL cleanup is covered by
// tests/unit/components/trade-listed-notice.test.tsx; here the hub only needs
// to prove it accepts the allowlisted ?listed value and positions the notice.
vi.mock("@/components/TradeListedNotice", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-listed-notice" data-props={JSON.stringify(props)} />
  ),
}));
// The collection lists have their own service suite (#2079); here the hub
// only needs to prove it passes the parsed sort and the loaded sections down.
vi.mock("@/lib/trade-collections", () => ({
  listTradeCollections: async () => [],
}));

import MyTrades from "@/components/MyTrades";
import TradeLayout, { metadata } from "@/app/trade/layout";
import TradeHubPage from "@/app/trade/page";
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

/**
 * React consumes `key` instead of passing it as a prop, so the mocked
 * component cannot expose it through data-props. Walk the server component's
 * returned element tree instead and read the key off the <MyTrades> element.
 */
function findElement(node: ReactNode, type: ElementType): ReactElement | null {
  // Do not use Children.toArray(): it clones unkeyed elements with synthetic
  // keys (".1"), which would hide the key this test is checking.
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  const children = (node.props as { children?: ReactNode }).children;
  return findElement(children, type);
}

const params = Promise.resolve({ streamerId: STREAMER_ID });

beforeEach(() => {
  mocks.tradeUiVisible = true;
  vi.clearAllMocks();
  mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer());
  mocks.listWantableCards.mockResolvedValue([
    {
      cardId: "c-1",
      name: "Visible Card",
      rarity: "common",
      imageUrl: "https://img/x.png",
      // 閲覧者に依存しない表示番号（#N）。フィルタの選択肢もこの値で表示する。
      collectionNumber: 1,
      isOwned: true,
    },
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

  // The board's help link must stay in the page for both visitors and signed-in
  // users after moving it out of the separate row in the shared layout.
  it("links the usage guide from the board for both anonymous and logged-in visitors", async () => {
    for (const session of [null, SESSION]) {
      cleanup();
      mocks.getSession.mockResolvedValue(session);
      const board = await TradeBoardPage({ params, searchParams: Promise.resolve({}) });
      render(await TradeLayout({ children: board }));
      const link = screen.getByRole("link", { name: "entryLink" });
      expect(link).toHaveAttribute("href", "/guide/trade");
      const main = screen.getByRole("main");
      expect(main).toContainElement(link);
      expect(main).toContainElement(screen.getByRole("heading", { name: "boardTitle" }));
    }
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
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/new?kind=offer&give=${STREAMER_ID}`)}`,
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
    expect(board.filterCards).toEqual([
      { cardId: "c-1", name: "Visible Card", collectionNumber: 1 },
    ]);
    expect(board.createHref).toBe(
      `/trade/new?kind=offer&give=${STREAMER_ID}&want=${STREAMER_ID}`,
    );
    expect(board.isLoggedIn).toBe(true);
  });

  it("passes the channel's reveal setting for the unrevealed notice", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.getTradeBoardStreamer.mockResolvedValue(boardStreamer({ revealsUnownedCards: false }));
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    expect(props("trade-board").revealsUnownedCards).toBe(false);
  });

  it("hands the board the display number of a hidden-name filter card (#2070 follow-up)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    // 名前が非公開の未所持カード: name は "" で、表示番号だけが分かる。
    mocks.listWantableCards.mockResolvedValue([
      {
        cardId: "c-hidden",
        name: "",
        rarity: "rare",
        imageUrl: "https://img/secret.png",
        collectionNumber: 12,
        isOwned: false,
      },
    ]);
    render(await TradeBoardPage({ params, searchParams: Promise.resolve({}) }));
    // 名前（""）と番号だけを渡す。画像 URL はフィルタの props に含めない。
    expect(props("trade-board").filterCards).toEqual([
      { cardId: "c-hidden", name: "", collectionNumber: 12 },
    ]);
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
    expect(props("trade-board").filterCards).toEqual([
      { cardId: "c-1", name: "Visible Card", collectionNumber: 1 },
    ]);
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

describe("/trade/[streamerId]/new legacy listing route (#2080)", () => {
  const legacyRedirect = (searchParams: Record<string, string | string[] | undefined> = {}) =>
    TradeCreatePage({ params, searchParams: Promise.resolve(searchParams) });

  it("redirects to the unified flow preserving the old in-channel meaning (give === want)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(legacyRedirect({})).rejects.toThrow(
      `REDIRECT:/trade/new?kind=offer&give=${STREAMER_ID}&want=${STREAMER_ID}`,
    );
  });

  it("keeps ?scope=cross as give-only: the wanted collection is chosen in step 3", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(legacyRedirect({ scope: "cross" })).rejects.toThrow(
      `REDIRECT:/trade/new?kind=offer&give=${STREAMER_ID}`,
    );
  });

  it("keeps ?scope=cross&partner=P as give=X&want=P and carries ?offered=", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(
      legacyRedirect({ scope: "cross", partner: "p-1", offered: "card-keep" }),
    ).rejects.toThrow(
      `REDIRECT:/trade/new?kind=offer&give=${STREAMER_ID}&want=p-1&offered=card-keep`,
    );
  });

  it("keeps ?kind=auction as the auction kind (no wanted collection)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(legacyRedirect({ kind: "auction" })).rejects.toThrow(
      `REDIRECT:/trade/new?kind=auction&give=${STREAMER_ID}`,
    );
  });

  it("does not read the streamer or its catalogue before redirecting (no 404 gate)", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    // Even if the channel is unknown/disabled, the legacy URL is just a view
    // alias: the new page owns the gates.
    mocks.getTradeBoardStreamer.mockResolvedValue(null);
    await expect(legacyRedirect({ scope: "cross" })).rejects.toThrow("REDIRECT:");
    expect(mocks.getTradeBoardStreamer).not.toHaveBeenCalled();
    expect(mocks.listTradeableOwnedCopies).not.toHaveBeenCalled();
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(mocks.listCrossTradePartnerStreamers).not.toHaveBeenCalled();
  });

  it("sends anonymous visitors to login with the CONVERTED URL as returnTo", async () => {
    mocks.getSession.mockResolvedValue(null);
    const converted = `/trade/new?kind=offer&give=${STREAMER_ID}`;
    await expect(legacyRedirect({ scope: "cross" })).rejects.toThrow(
      `REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(converted)}`,
    );
  });

  it("sends an invalid streamer id to the bare /trade/new instead of 404", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(
      TradeCreatePage({
        params: Promise.resolve({ streamerId: "not-a-uuid" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("REDIRECT:/trade/new");
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
      createHref: `/trade/new?kind=auction&give=${STREAMER_ID}`,
      justListed: true,
    });
    expect(board.viewerKey).toMatch(/^u:[0-9a-f]{16}$/);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "tabAuction" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "tabInChannel" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "createAuctionButton +" })).toHaveAttribute(
      "href",
      `/trade/new?kind=auction&give=${STREAMER_ID}`,
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
      `/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(`/trade/new?kind=auction&give=${STREAMER_ID}`)}`,
    );
  });
});

describe("/trade/[streamerId]/new kind allowlist (#1791)", () => {
  it("?kind=auction maps to the auction flow; anything else is a regular offer", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(
      TradeCreatePage({ params, searchParams: Promise.resolve({ kind: "auction" }) }),
    ).rejects.toThrow(`REDIRECT:/trade/new?kind=auction&give=${STREAMER_ID}`);
    await expect(
      TradeCreatePage({ params, searchParams: Promise.resolve({ kind: "other" }) }),
    ).rejects.toThrow(
      `REDIRECT:/trade/new?kind=offer&give=${STREAMER_ID}&want=${STREAMER_ID}`,
    );
  });
});

describe("/trade/[streamerId]/auctions/[auctionId] detail page (#1791)", () => {
  const AUCTION_ID = "22222222-2222-4222-8222-222222222222";
  const detailParams = Promise.resolve({ streamerId: STREAMER_ID, auctionId: AUCTION_ID });

  it("offers only owned, wantable cards as bid candidates with their free copy counts", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listWantableCards.mockResolvedValue([
      { cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, collectionNumber: 1, isOwned: true },
      { cardId: "c-locked", name: "Locked", rarity: "common", imageUrl: null, collectionNumber: 2, isOwned: true },
      { cardId: "c-unowned", name: "Unowned", rarity: "epic", imageUrl: null, collectionNumber: 3, isOwned: false },
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
      { cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, collectionNumber: 1, freeCount: 2 },
      { cardId: "c-locked", name: "Locked", rarity: "common", imageUrl: null, collectionNumber: 2, freeCount: 0 },
    ]);
  });

  it("passes the restriction map of THIS auction's offered card's streamer (not the board channel's rules), intersected with the viewer's bid candidates", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listWantableCards.mockResolvedValue([
      { cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, collectionNumber: 1, isOwned: true },
      { cardId: "c-unowned", name: "Unowned", rarity: "epic", imageUrl: null, collectionNumber: 3, isOwned: false },
    ]);
    mocks.listTradeableOwnedCopies.mockResolvedValue([
      { userCardId: "u1", cardId: "c-own", name: "Own", rarity: "rare", imageUrl: null, obtainedAt: null, isListed: false, ownedCount: 1 },
    ]);
    mocks.loadAllowedBidCardsForAuction.mockResolvedValue({ "c-offered": ["c-own"] });
    render(await TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({}) }));

    // The page path is the BIDDER's channel (it differs from the offered card's channel on the
    // cross-channel tab), so the rule is looked up from the auction itself, for this viewer
    // (the loader applies the visibility rule to the offered card), with the viewer's own bid
    // candidates as the only values that can be serialized.
    expect(mocks.loadAllowedBidCardsForAuction).toHaveBeenCalledTimes(1);
    const [auctionId, viewerTwitchUserId, selectable] = mocks.loadAllowedBidCardsForAuction.mock.calls[0];
    expect(auctionId).toBe(AUCTION_ID);
    expect(viewerTwitchUserId).toBe("viewer-1");
    expect([...selectable]).toEqual(["c-own"]);
    expect(props("trade-auction-detail").allowedBidCardIdsByOfferedCardId).toEqual({ "c-offered": ["c-own"] });
  });

  it("does not read the restriction map when the viewer has no bid candidate or is anonymous", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listWantableCards.mockResolvedValue([]);
    mocks.listTradeableOwnedCopies.mockResolvedValue([]);
    render(await TradeAuctionDetailPage({ params: detailParams, searchParams: Promise.resolve({}) }));
    expect(mocks.loadAllowedBidCardsForAuction).not.toHaveBeenCalled();
    expect(props("trade-auction-detail").allowedBidCardIdsByOfferedCardId).toEqual({});
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

describe("/trade hub page (#2078)", () => {
  it("redirects anonymous visitors to login returning to /trade", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(TradeHubPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade",
    );
    // The hub is login-only: no per-viewer list is loaded before the redirect.
    expect(mocks.listMyTradeOffers).not.toHaveBeenCalled();
  });

  it("renders the heading, the create link to the unified flow and the viewer's trades", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const offer = { id: "o-1", status: "open", mineRole: "offerer" };
    mocks.listMyTradeOffers.mockResolvedValue({ offers: [offer], page: 1, pageSize: 20, hasMore: true });
    render(await TradeHubPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "hubTitle" })).toHaveClass("lg:sr-only");
    // #2080: the primary action opens the unified listing flow. It must be a
    // real link (not the old disabled placeholder) so the hub has no dead end.
    const create = screen.getByRole("link", { name: "hubCreateButton" });
    expect(create).toHaveAttribute("href", "/trade/new");
    expect(create).not.toHaveAttribute("disabled");
    expect(create).not.toHaveAttribute("aria-disabled");
    // The removed "coming soon" explanation must not linger anywhere.
    expect(screen.queryByText("hubCreateUnavailable")).toBeNull();
    expect(screen.getByRole("heading", { name: "myTradesTitle" })).toBeInTheDocument();
    expect(props("my-trades")).toEqual({ initialOpen: { offers: [offer], hasMore: true } });
    expect(screen.getByRole("heading", { name: "collectionsTitle" })).toBeInTheDocument();
    expect(props("trade-collections")).toEqual({ initialCollections: [], sort: "newest" });
  });

  it("keeps the hub title visible when the sidebar has no trade entry", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.tradeUiVisible = false;
    render(await TradeHubPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "hubTitle" })).not.toHaveClass("lg:sr-only");
  });

  it.each(["offer", "auction"] as const)(
    "shows the post-listing notice for ?listed=%s between the heading and my trades",
    async (listed) => {
      mocks.getSession.mockResolvedValue(SESSION);
      render(await TradeHubPage({ searchParams: Promise.resolve({ listed }) }));

      // The hub reuses the board's two notices instead of new copy (#2080).
      expect(props("trade-listed-notice")).toEqual({ kind: listed });
      // The notice belongs under the heading and above "my trades", where the
      // viewer looks after being sent back from the form.
      const notice = screen.getByTestId("trade-listed-notice");
      const myTradesHeading = screen.getByRole("heading", { name: "myTradesTitle" });
      expect(
        notice.compareDocumentPosition(myTradesHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it.each([
    ["absent", {}],
    ["unrelated", { listed: "1" }],
    ["unknown", { listed: "redeemed" }],
    ["repeated", { listed: ["offer", "auction"] }],
  ])("ignores a %s ?listed value and shows no notice", async (_name, query) => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeHubPage({ searchParams: Promise.resolve(query) }));
    expect(screen.queryByTestId("trade-listed-notice")).toBeNull();
  });

  it("passes the allowlisted sort to the server-rendered collection list", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeHubPage({ searchParams: Promise.resolve({ sort: "ending_soon" }) }));
    expect(props("trade-collections")).toEqual({ initialCollections: [], sort: "ending_soon" });

    cleanup();
    render(await TradeHubPage({ searchParams: Promise.resolve({ sort: "unknown" }) }));
    expect(props("trade-collections")).toEqual({ initialCollections: [], sort: "newest" });
  });

  it("remounts MyTrades on every server render with a fresh key", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    // A request-scoped key: router.refresh() must produce a different one so
    // the client component and its per-mount cache are discarded.
    const first = findElement(
      await TradeHubPage({ searchParams: Promise.resolve({}) }),
      MyTrades,
    );
    const second = findElement(
      await TradeHubPage({ searchParams: Promise.resolve({}) }),
      MyTrades,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.key).not.toBe(first!.key);
  });

  it("prefetches the open tab's first page for logged-in users", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    render(await TradeHubPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.listMyTradeOffers).toHaveBeenCalledWith("viewer-1", { status: "open", page: 1 });
  });

  it("falls back to the client fetch when the prefetch fails", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.listMyTradeOffers.mockRejectedValue(new Error("db down"));
    render(await TradeHubPage({ searchParams: Promise.resolve({}) }));
    expect(props("my-trades")).toEqual({ initialOpen: null });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });
});

// #2078: /trade/mine is now a permanent alias of the /trade hub. The hub suite
// above owns the login gate, SSR prefetch and <MyTrades> coverage that used to
// live here; this page must only redirect, even for anonymous visitors (the hub
// then sends them to login with returnTo=/trade).
describe("/trade/mine page", () => {
  it("redirects logged-in visitors to the trade hub", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(MyTradesPage()).rejects.toThrow("REDIRECT:/trade");
    // The alias must not perform the SSR prefetch itself any more.
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.listMyTradeOffers).not.toHaveBeenCalled();
  });

  it("redirects anonymous visitors to /trade as well", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(MyTradesPage()).rejects.toThrow("REDIRECT:/trade");
    expect(mocks.listMyTradeOffers).not.toHaveBeenCalled();
  });
});
