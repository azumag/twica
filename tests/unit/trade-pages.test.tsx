import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
  getTradeBoardStreamer: mocks.getTradeBoardStreamer,
  listWantableCards: mocks.listWantableCards,
  listTradeableOwnedCopies: mocks.listTradeableOwnedCopies,
  listCrossTradePartnerStreamers: mocks.listCrossTradePartnerStreamers,
  listMyTradeOffers: mocks.listMyTradeOffers,
}));
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
