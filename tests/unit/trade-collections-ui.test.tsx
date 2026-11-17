import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TradeCollectionSection } from "@/lib/trade-collections";

/**
 * #2079: hub collection list behaviour that the server tests cannot cover:
 * the empty/error states, the sort navigation, and the "6th row onwards"
 * fetch through GET /api/trades/collections/[streamerId].
 *
 * The row components are replaced with probes: this suite is about which rows
 * are shown and which URL is fetched. Their own rendering is covered by the
 * existing trade component tests.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}:${values.count}`,
}));
vi.mock("@/components/MaintenanceStatusProvider", () => ({
  useMaintenanceStatus: () => ({ mode: "off" }),
}));
vi.mock("@/components/TradeOfferRow", () => ({
  default: ({ offer }: { offer: { id: string } }) => (
    <li data-testid="offer-row" data-offer-id={offer.id} />
  ),
}));
vi.mock("@/components/TradeAuctionRow", () => ({
  default: ({ auction }: { auction: { id: string } }) => (
    <li data-testid="auction-row" data-auction-id={auction.id} />
  ),
}));
vi.mock("@/components/TradeAcceptModal", () => ({ default: () => null }));

import TradeCollections from "@/components/TradeCollections";

const STREAMER = {
  id: "11111111-1111-4111-8111-111111111111",
  twitchUsername: "channel",
  twitchDisplayName: "Channel",
  twitchProfileImageUrl: null,
};

function section(overrides: Partial<TradeCollectionSection> = {}): TradeCollectionSection {
  return {
    streamer: STREAMER,
    offers: Array.from({ length: 5 }, (_, index) => ({ id: `offer-${index + 1}` })) as never,
    offerTotal: 7,
    auctions: [],
    auctionTotal: 0,
    latestCreatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TradeCollections (#2079)", () => {
  it("shows the empty state when no collection has listings", () => {
    render(<TradeCollections initialCollections={[]} sort="newest" />);
    expect(screen.getByText("collectionsEmpty")).toBeInTheDocument();
    expect(screen.getByLabelText("collectionSortLabel")).toHaveValue("newest");
  });

  it("shows the retry state when the SSR prefetch failed", () => {
    render(<TradeCollections initialCollections={null} sort="newest" />);
    expect(screen.getByText("collectionsLoadError")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retryButton" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("navigates to the server-rendered sort URL", () => {
    render(<TradeCollections initialCollections={[section()]} sort="newest" />);
    fireEvent.change(screen.getByLabelText("collectionSortLabel"), {
      target: { value: "ending_soon" },
    });
    expect(mocks.push).toHaveBeenCalledWith("/trade?sort=ending_soon");
  });

  it("fetches rows 6+ from the collection endpoint and can collapse again", async () => {
    const fetched = {
      offers: Array.from({ length: 6 }, (_, index) => ({ id: `expanded-${index + 1}` })),
      total: 7,
      hasMore: false,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fetched,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section()]} sort="newest" />);
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
    // 5 shown of 7 → the expand button is offered with the TOTAL count.
    expect(screen.getByRole("button", { name: "collectionExpand:7" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:7" }));

    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(6));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/trades/collections/${STREAMER.id}?kind=offer&sort=newest&page=1`,
      { credentials: "include", cache: "no-store" },
    );

    fireEvent.click(screen.getByRole("button", { name: "collectionCollapse" }));
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
  });

  it("shows the board link only when the expanded page still has more", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        offers: Array.from({ length: 20 }, (_, index) => ({ id: `expanded-${index + 1}` })),
        total: 25,
        hasMore: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 25 })]} sort="newest" />);
    expect(screen.queryByRole("link", { name: "collectionMoreLink" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:25" }));
    const link = await screen.findByRole("link", { name: "collectionMoreLink" });
    expect(link).toHaveAttribute("href", `/trade/${STREAMER.id}`);
  });
});
