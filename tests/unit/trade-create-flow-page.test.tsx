import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * #2080: unified listing flow /trade/new.
 *
 * The page is a server component; the data layer and the client form are
 * mocked so the tests only exercise the step decisions, the allowlisting of
 * ?give/?want and the props handed to the form. The privacy of the card
 * catalogue is covered separately by trade-page-private-card-props.test.tsx
 * (real services + DB double).
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listViewerTradeCollections: vi.fn(),
  loadTradeCreateFormData: vi.fn(),
  isTradeAuctionSchemaAvailable: vi.fn(),
  listCrossTradePartnerStreamers: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/trade", () => ({
  TRADE_MAX_WANTED_QUANTITY: 10,
  listCrossTradePartnerStreamers: mocks.listCrossTradePartnerStreamers,
  // The page itself only uses the two above; these keep the real shared flow
  // module importable under the mock.
  listTradeableOwnedCopies: vi.fn(),
  listWantableCards: vi.fn(),
  getTradeBoardStreamer: vi.fn(),
}));
vi.mock("@/lib/trade-create-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trade-create-flow")>();
  return {
    ...actual,
    listViewerTradeCollections: mocks.listViewerTradeCollections,
    loadTradeCreateFormData: mocks.loadTradeCreateFormData,
    isTradeAuctionSchemaAvailable: mocks.isTradeAuctionSchemaAvailable,
  };
});
vi.mock("@/components/TradeCreateForm", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="trade-create-form" data-props={JSON.stringify(props)} />
  ),
}));

import TradeNewPage from "@/app/trade/new/page";

type Collection = {
  id: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
  tradeEnabled: boolean;
  crossChannelTradeEnabled: boolean;
};

const GIVE = "11111111-1111-4111-8111-111111111111";
const WANT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOT_OWNED = "44444444-4444-4444-8444-444444444444";
const OTHER_COLLECTION = "55555555-5555-4555-8555-555555555555";

function collection(id: string, overrides: Partial<Collection> = {}): Collection {
  return {
    id,
    twitchDisplayName: `Channel ${id.slice(0, 4)}`,
    twitchProfileImageUrl: null,
    tradeEnabled: true,
    crossChannelTradeEnabled: true,
    ...overrides,
  };
}

const GIVE_COLLECTION = collection(GIVE, { twitchDisplayName: "Give Channel" });
const WANT_COLLECTION = collection(WANT, { twitchDisplayName: "Want Channel" });

function formData() {
  return {
    ownedCopies: [
      {
        userCardId: "uc-1",
        cardId: "card-1",
        name: "Card One",
        rarity: "common",
        imageUrl: null,
        obtainedAt: null,
        isListed: false,
        ownedCount: 1,
      },
    ],
    wantableCards: [
      { cardId: "card-2", name: "Visible Card", rarity: "rare", imageUrl: null, isOwned: false },
    ],
    wantableRevealsUnowned: true,
    wantableRevealsUnownedImages: false,
  };
}

function props() {
  return JSON.parse(screen.getByTestId("trade-create-form").getAttribute("data-props")!) as Record<
    string,
    unknown
  >;
}

function query(search: Record<string, string | string[] | undefined> = {}) {
  return Promise.resolve(search);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
  mocks.listViewerTradeCollections.mockResolvedValue([GIVE_COLLECTION, WANT_COLLECTION]);
  mocks.listCrossTradePartnerStreamers.mockResolvedValue([]);
  mocks.isTradeAuctionSchemaAvailable.mockResolvedValue(true);
  mocks.loadTradeCreateFormData.mockResolvedValue(formData());
});

describe("/trade/new login gate", () => {
  it("redirects anonymous visitors to login with the query as returnTo", async () => {
    mocks.getSession.mockResolvedValue(null);
    const returnTo = `/trade/new?kind=offer&give=${GIVE}&want=${WANT}&offered=card-1`;
    await expect(
      TradeNewPage({
        searchParams: query({ kind: "offer", give: GIVE, want: WANT, offered: "card-1" }),
      }),
    ).rejects.toThrow(
      `REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent(returnTo)}`,
    );
    // No per-viewer collection/catalogue read happens before the login gate.
    expect(mocks.listViewerTradeCollections).not.toHaveBeenCalled();
  });

  it("keeps the first step (no kind chosen yet) as the bare /trade/new returnTo", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(TradeNewPage({ searchParams: query({}) })).rejects.toThrow(
      `REDIRECT:/api/auth/twitch/login?redirect=true&returnTo=${encodeURIComponent("/trade/new")}`,
    );
  });
});

describe("/trade/new scope decision", () => {
  it("the same collection is an in-channel trade: the page fixes kind=offer and passes the wanted catalogue", async () => {
    render(
      await TradeNewPage({
        searchParams: query({ kind: "offer", give: GIVE, want: GIVE, offered: "card-keep" }),
      }),
    );

    // Same give/want: no partner allowlist query.
    expect(mocks.listCrossTradePartnerStreamers).not.toHaveBeenCalled();
    expect(mocks.loadTradeCreateFormData).toHaveBeenCalledWith({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: GIVE,
    });
    const form = props();
    expect(form).toMatchObject({
      kind: "offer",
      // ?offered= is carried to step 4; the form still validates that it is a
      // listable card of the viewer.
      initialOfferedCardId: "card-keep",
      maxWantedQuantity: 10,
    });
    // #2080 round 2: the form no longer chooses the kind or the partner, so it
    // must not receive those props (and no dead board destination).
    expect(form).not.toHaveProperty("cross");
    expect(form).not.toHaveProperty("boardHref");
    expect(form).not.toHaveProperty("initialKind");
    expect(form).not.toHaveProperty("streamerId");
    expect(form.wantableCards).toEqual(formData().wantableCards);
    expect(screen.getAllByText("tabInChannel").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /createFlowBackToHub/ })).toHaveAttribute(
      "href",
      "/trade",
    );
  });

  it("a different collection is a cross-channel trade: the page still shows the derived scope", async () => {
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([
      {
        id: WANT,
        twitchUsername: "want",
        twitchDisplayName: "Want Channel",
        twitchProfileImageUrl: null,
      },
    ]);
    render(
      await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE, want: WANT }) }),
    );

    expect(mocks.listCrossTradePartnerStreamers).toHaveBeenCalledWith("viewer-1", GIVE);
    // The counterpart is now only a page-level decision; the form receives the
    // wanted catalogue, not a partner picker.
    expect(props()).toMatchObject({ kind: "offer" });
    expect(props()).not.toHaveProperty("cross");
    expect(screen.getAllByText("tabCrossChannel").length).toBeGreaterThan(0);
  });

  it("auctions skip step 3 entirely (no wanted collection, no wanted catalogue)", async () => {
    render(await TradeNewPage({ searchParams: query({ kind: "auction", give: GIVE }) }));

    expect(mocks.listCrossTradePartnerStreamers).not.toHaveBeenCalled();
    expect(mocks.loadTradeCreateFormData).toHaveBeenCalledWith({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: null,
    });
    const form = props();
    expect(form.kind).toBe("auction");
    expect(form).not.toHaveProperty("cross");
    expect(screen.queryByText("createFlowStepWantTitle")).toBeNull();
    expect(screen.queryByText("createFlowWantScopeHint")).toBeNull();
  });
});

describe("/trade/new candidate gates", () => {
  it("marks a trade-disabled give collection as unselectable with the reason", async () => {
    const disabled = collection(OTHER, {
      twitchDisplayName: "Disabled Channel",
      tradeEnabled: false,
    });
    mocks.listViewerTradeCollections.mockResolvedValue([GIVE_COLLECTION, disabled]);

    render(await TradeNewPage({ searchParams: query({ kind: "offer" }) }));

    expect(screen.getByRole("link", { name: /Give Channel/ })).toHaveAttribute(
      "href",
      `/trade/new?kind=offer&give=${GIVE}`,
    );
    expect(screen.queryByRole("link", { name: /Disabled Channel/ })).toBeNull();
    expect(screen.getByText("createFlowTradeDisabled")).toBeInTheDocument();
    // The partner allowlist is not queried before a give collection is chosen.
    expect(mocks.listCrossTradePartnerStreamers).not.toHaveBeenCalled();
  });

  it("marks each wanted candidate as in-channel/cross and explains every gate", async () => {
    const crossOff = collection(OTHER, {
      twitchDisplayName: "Cross Off",
      crossChannelTradeEnabled: false,
    });
    const tradeOff = collection(OTHER_COLLECTION, {
      twitchDisplayName: "Trade Off",
      tradeEnabled: false,
    });
    const noPartner = collection(NOT_OWNED, { twitchDisplayName: "No Tradeable Card" });
    const eligible = collection(WANT, { twitchDisplayName: "Eligible" });
    // A collection the viewer does not own is never returned by the candidate
    // query, so it must not appear even if it exists in the database.
    mocks.listViewerTradeCollections.mockResolvedValue([
      GIVE_COLLECTION,
      crossOff,
      tradeOff,
      noPartner,
      eligible,
    ]);
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([
      {
        id: eligible.id,
        twitchUsername: "eligible",
        twitchDisplayName: eligible.twitchDisplayName,
        twitchProfileImageUrl: null,
      },
    ]);

    render(await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE }) }));

    // want === give: in-channel, selectable without the cross partner list.
    expect(screen.getByRole("link", { name: /Give Channel/ })).toHaveAttribute(
      "href",
      `/trade/new?kind=offer&give=${GIVE}&want=${GIVE}`,
    );
    // Cross candidate allowed by listCrossTradePartnerStreamers.
    expect(screen.getByRole("link", { name: /Eligible/ })).toHaveAttribute(
      "href",
      `/trade/new?kind=offer&give=${GIVE}&want=${WANT}`,
    );
    // Gate failures are rendered as disabled rows with their reason, never links.
    expect(screen.queryByRole("link", { name: /Cross Off/ })).toBeNull();
    expect(screen.getByText("createFlowWantCrossDisabled")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Trade Off/ })).toBeNull();
    expect(screen.getByText("createFlowTradeDisabled")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /No Tradeable Card/ })).toBeNull();
    expect(screen.getByText("createFlowWantNoTradeableCard")).toBeInTheDocument();
  });

  it("disables every cross candidate when the GIVE collection itself does not allow cross trade", async () => {
    mocks.listViewerTradeCollections.mockResolvedValue([
      collection(GIVE, { twitchDisplayName: "Give Channel", crossChannelTradeEnabled: false }),
      collection(OTHER, { twitchDisplayName: "Other Channel" }),
    ]);
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([]);

    render(await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE }) }));

    // The in-channel candidate has no cross condition and stays selectable.
    expect(screen.getByRole("link", { name: /Give Channel/ })).toHaveAttribute(
      "href",
      `/trade/new?kind=offer&give=${GIVE}&want=${GIVE}`,
    );
    expect(screen.queryByRole("link", { name: /Other Channel/ })).toBeNull();
    expect(screen.getByText("createFlowGiveCrossDisabled")).toBeInTheDocument();
  });

  it("does not read a catalogue for a give id the viewer does not own", async () => {
    render(await TradeNewPage({ searchParams: query({ kind: "offer", give: NOT_OWNED }) }));

    expect(mocks.listCrossTradePartnerStreamers).not.toHaveBeenCalled();
    expect(mocks.loadTradeCreateFormData).not.toHaveBeenCalled();
    // Fell back to step 2 instead of trusting the URL.
    expect(screen.getByText("createFlowStepGiveTitle")).toBeInTheDocument();
  });

  it("normalizes a canonical UUID before matching it against the owned collections", async () => {
    render(
      await TradeNewPage({
        searchParams: query({ kind: "offer", give: GIVE.toUpperCase(), want: GIVE.toUpperCase() }),
      }),
    );

    expect(mocks.loadTradeCreateFormData).toHaveBeenCalledWith({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: GIVE,
    });
  });

  it.each([
    ["an invalid UUID", "not-a-uuid"],
    ["a UUID the viewer does not own", NOT_OWNED],
  ])("ignores %s in ?want and does not read its catalogue", async (_name, want) => {
    render(await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE, want }) }));

    expect(mocks.loadTradeCreateFormData).not.toHaveBeenCalled();
    expect(screen.getByText("createFlowStepWantTitle")).toBeInTheDocument();
  });

  it("refuses a collected ?want that listCrossTradePartnerStreamers does not allow", async () => {
    mocks.listViewerTradeCollections.mockResolvedValue([
      GIVE_COLLECTION,
      collection(OTHER, { twitchDisplayName: "Not Allowed" }),
    ]);
    render(
      await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE, want: OTHER }) }),
    );

    expect(mocks.listCrossTradePartnerStreamers).toHaveBeenCalledWith("viewer-1", GIVE);
    expect(mocks.loadTradeCreateFormData).not.toHaveBeenCalled();
    expect(screen.getByText("createFlowStepWantTitle")).toBeInTheDocument();
  });
});

describe("/trade/new auction availability", () => {
  it("offers both kind links on step 1 when auctions are available", async () => {
    render(await TradeNewPage({ searchParams: query({}) }));

    expect(screen.getByRole("link", { name: /createKindOffer/ })).toHaveAttribute(
      "href",
      "/trade/new?kind=offer",
    );
    expect(screen.getByRole("link", { name: /createKindAuction/ })).toHaveAttribute(
      "href",
      "/trade/new?kind=auction",
    );
  });

  it("shows the same 'not available yet' notice as the auction board when auctions are unavailable", async () => {
    mocks.isTradeAuctionSchemaAvailable.mockResolvedValue(false);
    render(await TradeNewPage({ searchParams: query({ kind: "auction", give: GIVE }) }));

    expect(screen.getByText("auctionUnavailableNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-create-form")).toBeNull();
    expect(mocks.loadTradeCreateFormData).not.toHaveBeenCalled();
  });

  it("disables the auction choice on step 1 instead of linking to an unusable flow", async () => {
    mocks.isTradeAuctionSchemaAvailable.mockResolvedValue(false);
    render(await TradeNewPage({ searchParams: query({}) }));

    expect(mocks.isTradeAuctionSchemaAvailable).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: /createKindOffer/ })).toHaveAttribute(
      "href",
      "/trade/new?kind=offer",
    );
    expect(screen.queryByRole("link", { name: /createKindAuction/ })).toBeNull();
    expect(screen.getByText("auctionUnavailableNotice")).toBeInTheDocument();
  });

  it("does not probe the auction schema for a regular offer flow", async () => {
    render(
      await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE, want: GIVE }) }),
    );
    expect(mocks.isTradeAuctionSchemaAvailable).not.toHaveBeenCalled();
  });
});

describe("/trade/new step summaries", () => {
  it("shows the chosen kind / give / want with a change link that removes that step's parameter", async () => {
    mocks.listCrossTradePartnerStreamers.mockResolvedValue([
      {
        id: WANT,
        twitchUsername: "want",
        twitchDisplayName: "Want Channel",
        twitchProfileImageUrl: null,
      },
    ]);
    render(
      await TradeNewPage({ searchParams: query({ kind: "offer", give: GIVE, want: WANT }) }),
    );

    const changes = screen.getAllByRole("link", { name: "createFlowChange" });
    expect(changes.map((link) => link.getAttribute("href"))).toEqual([
      "/trade/new",
      "/trade/new?kind=offer",
      `/trade/new?kind=offer&give=${GIVE}`,
    ]);
  });
});
